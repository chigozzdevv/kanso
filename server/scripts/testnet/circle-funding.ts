import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NEAR_TESTNET_USDC } from '@kanso/bindings';
import { deployment } from '@kanso/schema';
import type { Pool } from '@kanso/schema';
import {
  CircleMintSandbox,
  circle_deposit_address,
} from '@testnet/circle-mint';
import { call, near_send, near_signer, near_view } from '@testnet/deploy-near';
import { rpc, NEAR_RPC } from '@testnet/network';
import type { Release } from '@testnet/deployment';
import { read_json } from '@testnet/store';
import type { KeyIndex } from '@testnet/store';

type CircleTransfer = {
  id: string;
  status: string;
  transactionHash?: string;
  errorCode?: string;
  destination: { address: string; chain: string };
  amount: { amount: string; currency: string };
};
type Withdrawal = {
  address: string;
  amount_atomic: string;
  balance_before: string;
  transfer?: CircleTransfer;
  verified?: boolean;
};
type NearOutcome = {
  final_execution_status: string;
  status: { SuccessValue?: string };
  receipts_outcome: {
    outcome: {
      executor_id: string;
      logs: string[];
      status: { SuccessValue?: string };
    };
  }[];
};

export function circle_receipt_received(
  outcome: NearOutcome,
  address: string,
  atomic: string,
): boolean {
  if (
    outcome.final_execution_status !== 'FINAL' ||
    outcome.status.SuccessValue === undefined
  )
    return false;
  return outcome.receipts_outcome.some(
    ({ outcome }) =>
      outcome.executor_id === NEAR_TESTNET_USDC &&
      outcome.status.SuccessValue !== undefined &&
      outcome.logs.some((log) => {
        if (!log.startsWith('EVENT_JSON:')) return false;
        const event = JSON.parse(log.slice('EVENT_JSON:'.length)) as {
          standard?: string;
          event?: string;
          data?: {
            new_owner_id?: string;
            owner_id?: string;
            amount?: string;
          }[];
        };
        return (
          event.standard === 'nep141' &&
          ['ft_transfer', 'ft_mint'].includes(event.event ?? '') &&
          event.data?.some(
            (entry) =>
              (entry.new_owner_id ?? entry.owner_id) === address &&
              entry.amount === atomic,
          ) === true
        );
      }),
  );
}

export function usdc_atomic(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value))
    throw new Error('Use a USDC amount with at most six decimal places');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

export function usdc_decimal(value: bigint): string {
  if (value < 0n) throw new Error('USDC amount cannot be negative');
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, '0')}`;
}

async function funding_context(release: Release) {
  const d = deployment.parse(
    JSON.parse(
      await readFile(
        join(release.folder, '..', 'deployments/testnet.json'),
        'utf8',
      ),
    ),
  );
  const config = await near_view<{ settlement_token: string }>(
    d.near.coordinator,
    'get_config',
  );
  if (
    d.network !== 'testnet' ||
    d.near.settlement_token !== NEAR_TESTNET_USDC ||
    config.settlement_token !== NEAR_TESTNET_USDC
  )
    throw new Error(
      'Circle funding requires the official NEAR Testnet USDC deployment',
    );
  const circle = new CircleMintSandbox();
  const configuration = await circle.request<{
    payments: { masterWalletId: string };
  }>('/v1/configuration');
  const state = release.journal.contracts.circle_mint as
    { wallet_id?: string } | undefined;
  if (!state || state.wallet_id !== configuration.payments.masterWalletId)
    throw new Error('Prepare funding with this Circle sandbox account first');
  const index = await read_json<KeyIndex>(release.folder, 'index.json');
  return { d, circle, index };
}

export async function circle_deposit_near(
  release: Release,
  amount: string,
  run: string,
) {
  if (!/^[a-z0-9-]{1,64}$/.test(run))
    throw new Error('Use a stable funding run ID');
  const atomic = usdc_atomic(amount);
  if (atomic <= 0n) throw new Error('Deposit must be greater than zero');
  const { circle } = await funding_context(release);
  const destination = await circle_deposit_address(release, 'NEAR');
  if (
    destination.chain !== 'NEAR' ||
    destination.currency !== 'USD' ||
    !/^[a-f0-9]{64}$/.test(destination.address)
  )
    throw new Error('Circle returned an unexpected NEAR deposit address');
  if (
    !(await near_view(NEAR_TESTNET_USDC, 'storage_balance_of', {
      account_id: destination.address,
    }))
  )
    throw new Error('Circle deposit address is not registered for USDC');
  const signer = await near_signer(release, 'solver');
  const effect = await near_send(
    release,
    `circle-deposit-near-${run}`,
    signer,
    NEAR_TESTNET_USDC,
    [
      call('ft_transfer', {
        receiver_id: destination.address,
        amount: atomic.toString(),
        memo: 'Kanso sandbox funding',
      }),
    ],
  );
  const transfers = await circle.request<CircleTransfer[]>(
    '/v1/businessAccount/transfers?pageSize=50',
  );
  return {
    transaction_id: effect.transaction_id,
    transfer:
      transfers.find((t) => t.transactionHash === effect.transaction_id) ??
      null,
    balances: await circle.request('/v1/businessAccount/balances'),
  };
}

export async function circle_withdraw(
  release: Release,
  role: string,
  amount: string,
  run: string,
) {
  if (!['lp', 'solver'].includes(role) || !/^[a-z0-9-]{1,64}$/.test(run))
    throw new Error('Use an LP or solver role and a stable funding run ID');
  const atomic = usdc_atomic(amount);
  if (atomic <= 0n) throw new Error('Withdrawal must be greater than zero');
  const { circle, index } = await funding_context(release);
  const address = index.wallets.find(
    (w) => w.family === 'near' && w.role === role,
  )?.address;
  if (!address?.endsWith('.testnet'))
    throw new Error('Missing NEAR Testnet withdrawal account');
  const id = `circle-withdraw-${run}-${role}`;
  let saved = release.journal.contracts[id] as Withdrawal | undefined;
  if (
    saved &&
    (saved.address !== address || saved.amount_atomic !== atomic.toString())
  )
    throw new Error('Circle withdrawal intent changed');
  if (saved?.verified) return saved;
  const recipients = await circle.request<
    { id: string; address: string; chain: string; currency: string }[]
  >('/v1/businessAccount/wallets/addresses/recipient');
  const recipient = recipients.find(
    (r) => r.address === address && r.chain === 'NEAR' && r.currency === 'USD',
  );
  if (!recipient)
    throw new Error(
      `Approve the NEAR recipient in Circle Mint Sandbox: ${address}`,
    );
  const balance = () =>
    near_view<string>(NEAR_TESTNET_USDC, 'ft_balance_of', {
      account_id: address,
    });
  if (!release.journal.effects[id]) {
    const balances = await circle.request<{
      available: { amount: string; currency: string }[];
    }>('/v1/businessAccount/balances');
    const available = balances.available.find(
      (entry) => entry.currency === 'USD',
    );
    if (!available || usdc_atomic(available.amount) < atomic)
      throw new Error(
        'Wait for the Circle sandbox deposit to settle before withdrawing',
      );
  }
  if (!saved) {
    if (
      !(await near_view(NEAR_TESTNET_USDC, 'storage_balance_of', {
        account_id: address,
      }))
    )
      throw new Error(
        'Register the recipient with the official USDC contract before withdrawing',
      );
    saved = {
      address,
      amount_atomic: atomic.toString(),
      balance_before: await balance(),
    };
    release.journal.contracts[id] = saved;
    await release.save();
  }
  const created = await circle.post<CircleTransfer>(
    release,
    id,
    '/v1/businessAccount/transfers',
    {
      destination: { type: 'verified_blockchain', addressId: recipient.id },
      amount: { amount: usdc_decimal(atomic), currency: 'USD' },
    },
  );
  const transfer = await circle.request<CircleTransfer>(
    `/v1/businessAccount/transfers/${created.id}`,
  );
  saved.transfer = transfer;
  await release.save();
  console.log(
    `Circle ${role} withdrawal ${usdc_decimal(atomic)} USDC: ${transfer.status}`,
  );
  if (['failed', 'denied'].includes(transfer.status))
    throw new Error(
      `Circle withdrawal failed: ${transfer.errorCode ?? transfer.status}`,
    );
  if (transfer.status !== 'complete') return saved;
  if (
    transfer.destination.address !== address ||
    transfer.destination.chain !== 'NEAR' ||
    transfer.amount.currency !== 'USD' ||
    usdc_atomic(transfer.amount.amount) !== atomic ||
    !transfer.transactionHash
  )
    throw new Error(
      'Circle withdrawal outcome differs from the requested NEAR transfer',
    );
  const outcome = await rpc<NearOutcome>(NEAR_RPC, 'tx', {
    tx_hash: transfer.transactionHash,
    sender_account_id: address,
    wait_until: 'NONE',
  });
  if (
    !circle_receipt_received(outcome, address, atomic.toString()) ||
    BigInt(await balance()) < BigInt(saved.balance_before) + atomic
  )
    throw new Error(
      'The exact official Circle NEAR Testnet USDC receipt is not verified',
    );
  saved.verified = true;
  await release.save();
  console.log(
    `Official NEAR Testnet USDC received and verified: ${transfer.transactionHash}`,
  );
  return saved;
}

export async function circle_fund_targets(
  release: Release,
  pool_target: string,
  solver_target: string,
  run: string,
) {
  if (!/^[a-z0-9-]{1,64}$/.test(run))
    throw new Error('Use a stable funding run ID');
  const pool_amount = usdc_atomic(pool_target),
    solver_amount = usdc_atomic(solver_target);
  if (pool_amount <= 0n || solver_amount <= 0n)
    throw new Error('Pool and solver targets must be greater than zero');
  const { d, index } = await funding_context(release);
  const probe = release.journal.contracts['circle-withdraw-probe-lp'] as
    Withdrawal | undefined;
  if (!probe?.verified || probe.amount_atomic !== '1000000')
    throw new Error('Verify the 1-USDC LP probe before bulk funding');
  const pool = await near_view<Pool>(d.near.coordinator, 'get_pool', {
    pool_id: 'usdc',
  });
  const lp = await near_signer(release, 'lp');
  const solver = index.wallets.find(
    (w) => w.family === 'near' && w.role === 'solver',
  );
  if (!solver) throw new Error('Missing solver account');
  const state_key = `circle-targets-${run}`;
  let targets = release.journal.contracts[state_key] as
    | {
        pool_target: string;
        solver_target: string;
        pool_deposit: string;
        lp_withdraw: string;
        solver_withdraw: string;
      }
    | undefined;
  if (
    targets &&
    (targets.pool_target !== pool_target ||
      targets.solver_target !== solver_target)
  )
    throw new Error('Funding targets changed for this run');
  if (!targets) {
    const lp_balance = BigInt(
      await near_view<string>(NEAR_TESTNET_USDC, 'ft_balance_of', {
        account_id: lp.accountId,
      }),
    );
    const solver_balance = BigInt(
      await near_view<string>(NEAR_TESTNET_USDC, 'ft_balance_of', {
        account_id: solver.address,
      }),
    );
    const deposit =
      pool_amount > BigInt(pool.cash_atomic)
        ? pool_amount - BigInt(pool.cash_atomic)
        : 0n;
    targets = {
      pool_target,
      solver_target,
      pool_deposit: deposit.toString(),
      lp_withdraw: (deposit > lp_balance
        ? deposit - lp_balance
        : 0n
      ).toString(),
      solver_withdraw: (solver_amount > solver_balance
        ? solver_amount - solver_balance
        : 0n
      ).toString(),
    };
    release.journal.contracts[state_key] = targets;
    await release.save();
  }
  for (const [role, amount] of [
    ['lp', targets.lp_withdraw],
    ['solver', targets.solver_withdraw],
  ] as const) {
    if (BigInt(amount) === 0n) continue;
    const withdrawal = await circle_withdraw(
      release,
      role,
      usdc_decimal(BigInt(amount)),
      run,
    );
    if (!withdrawal.verified)
      return {
        status: 'withdrawal_pending',
        role,
        transfer: withdrawal.transfer,
      };
  }
  if (BigInt(targets.pool_deposit) > 0n) {
    await near_send(release, `circle-pool-${run}`, lp, NEAR_TESTNET_USDC, [
      call('ft_transfer_call', {
        receiver_id: d.near.coordinator,
        amount: targets.pool_deposit,
        msg: JSON.stringify({
          kind: 'pool_deposit',
          pool_id: 'usdc',
          operation_id: `circle_pool_${run.replaceAll('-', '_')}`,
        }),
      }),
    ]);
  }
  const funded = await near_view<Pool>(d.near.coordinator, 'get_pool', {
    pool_id: 'usdc',
  });
  if (BigInt(funded.cash_atomic) < pool_amount)
    throw new Error('Pool cash did not reach the requested funding target');
  const solver_balance = await near_view<string>(
    NEAR_TESTNET_USDC,
    'ft_balance_of',
    { account_id: solver.address },
  );
  if (BigInt(solver_balance) < solver_amount)
    throw new Error(
      'Solver balance did not reach the requested funding target',
    );
  const backing = await near_view<string>(NEAR_TESTNET_USDC, 'ft_balance_of', {
    account_id: d.near.coordinator,
  });
  if (BigInt(backing) < BigInt(funded.cash_atomic))
    throw new Error('The funded pool is not backed by the official USDC token');
  return {
    status: 'funded',
    pool_cash_atomic: funded.cash_atomic,
    solver_usdc_atomic: solver_balance,
    coordinator_usdc_atomic: backing,
  };
}
