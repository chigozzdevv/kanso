import { transactions } from 'near-api-js';
import { Transaction as BitcoinTransaction } from 'bitcoinjs-lib';
import {
  bitcoin_deposit,
  evm_deposit,
  solana_deposit,
  sui_deposit,
  starknet_deposit,
} from '@kanso/sdk';
import type { ChainConfiguration, Loan, Offer } from '@kanso/schema';
import { BitcoinLightClient } from '@server/shared/near/bitcoin-light-client';
import { RpcProvider } from '@server/shared/near/rpc.provider';
import { ReadMpcClient } from '@server/shared/near/read-mpc.client';
import type { Observation } from '@server/shared/near/read-mpc.client';
import { Release, digest } from '@testnet/deployment';
import { near_send, near_signer, near_view, call } from '@testnet/deploy-near';
import { live_plan } from '@testnet/live-setup';
import { send_source } from '@testnet/live-wallets';
import { payload_hash, verify_read_signature } from '@testnet/live-mpc';
import { publish_live_prices } from '@testnet/live-oracle';

export const value_of = <T>(effect: { result?: unknown }): T => {
  const result = effect.result as { status: { SuccessValue: string } };
  return JSON.parse(
    Buffer.from(result.status.SuccessValue, 'base64').toString(),
  ) as T;
};
export async function refresh_prices() {
  const oracle = await Release.load('deployment-oracle.json');
  const coordinator = (await near_signer(oracle, 'coordinator')).accountId;
  const price = await near_view<{ published_at: number }>(
    coordinator,
    'get_asset_price',
    { asset_id: 'near' },
  );
  if (price && Date.now() / 1000 - price.published_at < 90) return;
  try {
    await oracle.lock(() => publish_live_prices(oracle));
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'EEXIST' &&
      price &&
      Date.now() / 1000 - price.published_at < 180
    )
      return;
    throw error;
  }
}
export async function risk_window<T>(
  release: Release,
  id: string,
  action: () => Promise<T>,
) {
  const { deployment: d } = await live_plan(release);
  const owner = await near_signer(release, 'owner');
  const counter = Object.keys(release.journal.effects).filter((k) =>
    k.startsWith(`${id}-open-`),
  ).length;
  const attempt = `${id}-${counter}`;
  try {
    await near_send(
      release,
      `${id}-open-${counter}`,
      owner,
      d.near.coordinator,
      [
        call('set_pause_flags', {
          flags: {
            origination: false,
            collateral_withdrawals: false,
            settlements: false,
          },
        }),
      ],
    );
    return await action();
  } finally {
    await near_send(release, `${attempt}-close`, owner, d.near.coordinator, [
      call('set_pause_flags', {
        flags: {
          origination: true,
          collateral_withdrawals: false,
          settlements: false,
        },
      }),
    ]);
  }
}
function selected(offers: Offer[]) {
  return offers.filter(
    (o) =>
      (!process.env.LIVE_CHAIN ||
        o.legs[0]!.leg_id === process.env.LIVE_CHAIN) &&
      !(process.env.LIVE_SKIP ?? '').split(',').includes(o.legs[0]!.leg_id),
  );
}
export async function accept_live(release: Release) {
  const plan = await live_plan(release),
    d = plan.deployment;
  const borrower = await near_signer(release, 'borrower');
  const pending: Offer[] = [];
  for (const offer of selected(plan.offers)) {
    const existing = await near_view<Loan | null>(
      d.near.coordinator,
      'get_loan',
      { loan_id: offer.offer_id },
    ).catch((error) => {
      if (error instanceof Error && error.message.includes('LOAN_NOT_FOUND'))
        return null;
      throw error;
    });
    if (!existing) pending.push(offer);
  }
  if (!pending.length) return;
  await refresh_prices();
  const now = Math.floor(Date.now() / 1000);
  for (const offer of pending) {
    offer.expires_at = now + 3600;
    offer.setup_deadline = now + 86000;
  }
  await release.save();
  await risk_window(release, 'accept-live', async () => {
    for (let i = 0; i < pending.length; i += 4) {
      const group = pending.slice(i, i + 4);
      await near_send(
        release,
        `accept-${digest(JSON.stringify(group)).slice(0, 24)}`,
        borrower,
        d.near.coordinator,
        group.map((offer) =>
          transactions.functionCall(
            'accept_offer',
            { offer },
            50_000_000_000_000n,
            1n,
          ),
        ),
      );
    }
  });
}
export async function deposit_live(release: Release) {
  const plan = await live_plan(release),
    d = plan.deployment;
  const borrower = await near_signer(release, 'borrower');
  for (const offer of selected(plan.offers)) {
    const loan = await near_view<Loan | null>(d.near.coordinator, 'get_loan', {
      loan_id: offer.offer_id,
    });
    if (!loan)
      throw new Error(`Accept offer before depositing: ${offer.offer_id}`);
    const lock = loan.locks[0]!,
      leg = lock.leg;
    const id = `deposit-${offer.offer_id}`;
    if (
      lock.receipt_verified ||
      release.journal.effects[id]?.state === 'confirmed'
    )
      continue;
    if (leg.custody.family === 'near') {
      await near_send(release, id, borrower, d.near.coordinator, [
        call(
          'lock_native',
          { loan_id: loan.loan_id, leg_id: leg.leg_id },
          BigInt(leg.amount_atomic),
        ),
      ]);
      continue;
    }
    const chain_id = leg.custody.chain_id;
    const c = d.chains.find((c) => c.manifest.chain_id === chain_id)!;
    if (c.manifest.family === 'bitcoin')
      await near_send(
        release,
        `derive-${offer.offer_id}`,
        borrower,
        d.near.coordinator,
        [
          call('derive_bitcoin_deposit_key', {
            loan_id: loan.loan_id,
            leg_id: leg.leg_id,
          }),
        ],
      );
    const action =
      c.manifest.family === 'evm'
        ? await evm_deposit(c, leg, lock.agreement, 0)
        : c.manifest.family === 'solana'
          ? await solana_deposit(c, leg, lock.agreement, 0)
          : c.manifest.family === 'sui'
            ? await sui_deposit(c, leg, lock.agreement, 0)
            : c.manifest.family === 'starknet'
              ? await starknet_deposit(c, leg, lock.agreement, 0)
              : await bitcoin_deposit(d, loan.loan_id, leg);
    await send_source(release, id, action);
  }
}
export async function attest_live(
  release: Release,
  c: ChainConfiguration,
  observation: Observation,
) {
  const plan = await live_plan(release),
    d = plan.deployment;
  const hash = payload_hash(release, observation.payload);
  const base = `attest-${hash}`;
  let id = base,
    retry = 0;
  while (
    release.journal.effects[id]?.state === 'failed' &&
    JSON.stringify(release.journal.effects[id]?.result).includes(
      'Request has timed out.',
    ) &&
    retry < 3
  ) {
    id = `${base}-retry-${++retry}`;
  }
  const effect = await near_send(
    release,
    id,
    await near_signer(release, 'relayer'),
    d.near.coordinator,
    [
      transactions.functionCall(
        'request_read_attestation',
        {
          chain_id: c.manifest.chain_id,
          manifest_version: c.manifest.version,
          payload: observation.payload,
        },
        300_000_000_000_000n,
        1n,
      ),
    ],
  );
  const response = value_of<{
    payload_hash: string;
    signature: {
      scheme: string;
      big_r: unknown;
      s: unknown;
      recovery_id: number;
    };
  }>(effect);
  if (
    response.payload_hash !== hash ||
    response.signature.scheme !== 'Secp256k1'
  )
    throw new Error('MPC read response mismatch');
  const signature = {
    big_r: response.signature.big_r,
    s: response.signature.s,
    recovery_id: response.signature.recovery_id,
  };
  verify_read_signature(
    hash,
    signature,
    Buffer.from(c.manifest.read_public_key).toString('hex'),
  );
  return { payload: observation.payload, signature };
}
export async function verify_locks(release: Release) {
  const plan = await live_plan(release),
    d = plan.deployment;
  const providers = new RpcProvider(process.env);
  const reader = new ReadMpcClient(d, undefined, '1', providers);
  const bitcoin = new BitcoinLightClient(d, providers);
  for (const offer of selected(plan.offers)) {
    const loan = await near_view<Loan>(d.near.coordinator, 'get_loan', {
      loan_id: offer.offer_id,
    });
    const lock = loan.locks[0]!,
      leg = lock.leg;
    if (lock.receipt_verified || leg.custody.family === 'near') continue;
    const chain = leg.custody.chain_id;
    const c = d.chains.find((c) => c.manifest.chain_id === chain)!;
    const deposit = release.journal.effects[`deposit-${loan.loan_id}`];
    if (!deposit) {
      console.log(`${chain}: deposit is pending: ${loan.loan_id}`);
      continue;
    }
    try {
      const historical = {
        ...c,
        manifest: await near_view<ChainConfiguration['manifest']>(
          d.near.coordinator,
          'get_chain_manifest',
          { chain_id: chain, version: leg.custody.manifest_version },
        ),
      };
      const observation =
        c.manifest.family === 'bitcoin'
          ? await bitcoin.observe(historical, deposit.transaction_id)
          : await reader.observe(
              historical,
              deposit.transaction_id,
              'LockAccepted',
              leg.custody.lock_id,
            );
      const proof =
        'proof' in observation
          ? observation.proof
          : await attest_live(release, historical, observation);
      const args: Record<string, unknown> = {
        loan_id: loan.loan_id,
        leg_id: leg.leg_id,
        proof,
      };
      if ('proof' in observation) {
        const tx = BitcoinTransaction.fromBuffer(
          Buffer.from(observation.raw_transaction),
        );
        const script = await near_view<number[]>(
          d.near.coordinator,
          'bitcoin_deposit_script',
          { loan_id: loan.loan_id, leg_id: leg.leg_id },
        );
        const index = tx.outs.findIndex(
          (o) =>
            Buffer.from(o.script).equals(Buffer.from(script)) &&
            o.value === BigInt(leg.amount_atomic),
        );
        if (index < 0)
          throw new Error('Committed Bitcoin deposit output absent');
        args.raw_transaction = observation.raw_transaction;
        args.vout = index;
      }
      if (c.manifest.family === 'bitcoin') {
        const verified = await submit_bitcoin_proof(
          release,
          `verify-${loan.loan_id}`,
          'submit_bitcoin_lock',
          args,
        );
        deposit.state = 'confirmed';
        deposit.result = {
          inclusion_proof_transaction: verified.transaction_id,
        };
      } else
        await near_send(
          release,
          `verify-${loan.loan_id}`,
          await near_signer(release, 'relayer'),
          d.near.coordinator,
          [call('submit_remote_lock', args)],
        );
      delete release.journal.contracts[`pending-${loan.loan_id}`];
      await release.save();
    } catch (error) {
      console.log(
        `${chain}: verification pending: ${error instanceof Error ? error.message : String(error)}`,
      );
      release.journal.contracts[`pending-${loan.loan_id}`] = {
        checked_at: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      };
      await release.save();
    }
  }
}
export async function submit_bitcoin_proof(
  release: Release,
  id: string,
  method:
    | 'submit_bitcoin_lock'
    | 'submit_bitcoin_delivery'
    | 'register_bitcoin_recovery',
  args: Record<string, unknown>,
  role = 'relayer',
) {
  const { deployment: d } = await live_plan(release);
  const base = `${id}-spv-${digest(JSON.stringify(args)).slice(0, 16)}`;
  let effect_id = base;
  for (
    let retry = 1;
    release.journal.effects[effect_id]?.state === 'failed' && retry <= 8;
    retry++
  )
    effect_id = `${base}-retry-${retry}`;
  return near_send(
    release,
    effect_id,
    await near_signer(release, role),
    d.near.coordinator,
    [call(method, args)],
  );
}
export async function fund_live(release: Release) {
  const plan = await live_plan(release),
    d = plan.deployment;
  const borrower = await near_signer(release, 'borrower');
  const ready: Loan[] = [];
  for (const offer of selected(plan.offers)) {
    const loan = await near_view<Loan>(d.near.coordinator, 'get_loan', {
      loan_id: offer.offer_id,
    });
    if (loan.state === 'pending_funding' && loan.setup_state === 'funding') {
      await near_send(
        release,
        `finalize-fund-${loan.loan_id}`,
        borrower,
        d.near.coordinator,
        [
          call(
            'finalize_transfer',
            { transfer_id: `fund_${loan.loan_id}` },
            0n,
          ),
        ],
      );
      continue;
    }
    if (loan.state === 'pending_funding' && loan.setup_state === 'ready')
      ready.push(loan);
  }
  if (!ready.length) return;
  await refresh_prices();
  await risk_window(release, 'fund-live', async () => {
    for (const loan of ready) {
      const base = `fund-${loan.loan_id}`;
      let effect_id = base;
      for (
        let retry = 1;
        release.journal.effects[effect_id]?.state === 'failed' && retry <= 3;
        retry++
      )
        effect_id = `${base}-retry-${retry}`;
      await near_send(release, effect_id, borrower, d.near.coordinator, [
        call('fund_loan', {
          loan_id: loan.loan_id,
          transfer_id: `fund_${loan.loan_id}`,
        }),
      ]);
      await near_send(
        release,
        `finalize-fund-${loan.loan_id}`,
        borrower,
        d.near.coordinator,
        [
          call(
            'finalize_transfer',
            { transfer_id: `fund_${loan.loan_id}` },
            0n,
          ),
        ],
      );
      const funded = await near_view<Loan>(d.near.coordinator, 'get_loan', {
        loan_id: loan.loan_id,
      });
      if (funded.state !== 'active')
        throw new Error(`Disbursement did not complete: ${loan.loan_id}`);
    }
  });
}
