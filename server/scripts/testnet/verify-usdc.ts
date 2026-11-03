import { NEAR_TESTNET_USDC } from '@kanso/bindings';
import type {
  Deployment,
  Loan,
  Pool,
  Refund,
  Settlement,
  SettlementPlan,
} from '@kanso/schema';
import { scoped_id } from '@kanso/sdk';
import type { Release } from '@testnet/deployment';
import {
  call,
  finalize_near_transfer,
  near_send,
  near_signer,
  near_view,
} from '@testnet/deploy-near';

async function assert_usdc(d: Deployment) {
  const config = await near_view<{
    settlement_token: string;
    settlement_decimals: number;
  }>(d.near.coordinator, 'get_config');
  if (
    config.settlement_token !== NEAR_TESTNET_USDC ||
    config.settlement_decimals !== 6 ||
    d.near.settlement_token !== NEAR_TESTNET_USDC
  )
    throw new Error('Official Circle NEAR Testnet USDC must be configured');
}

export async function verify_usdc_refund(
  release: Release,
  d: Deployment,
  loan: Loan,
) {
  await assert_usdc(d);
  const key = scoped_id('circle-refund', loan.loan_id);
  const saved = (release.journal.contracts[key] ??= {}) as {
    plan?: SettlementPlan;
    balance_before?: string;
    complete?: boolean;
  };
  if (saved.complete) return;
  const coordinator = d.near.coordinator,
    solver = await near_signer(release, 'solver');
  const balance = () =>
    near_view<string>(NEAR_TESTNET_USDC, 'ft_balance_of', {
      account_id: solver.accountId,
    });
  if (!saved.plan) {
    const leg = loan.offer.legs.find(
      (value) => value.custody.family === 'near',
    );
    if (!leg)
      throw new Error('Refund verification requires native NEAR collateral');
    const lock = loan.locks.find((value) => value.leg.leg_id === leg.leg_id)!;
    const price = await near_view<{
      price_atomic: string;
      confidence_bps: number;
    }>(coordinator, 'get_asset_price', { asset_id: leg.asset_id });
    const input = BigInt(lock.locked_atomic) / 2n;
    const output =
      (input *
        BigInt(price.price_atomic) *
        BigInt(10000 - price.confidence_bps)) /
      (10n ** 24n * 10000n);
    if (input <= 0n || output <= 0n)
      throw new Error('Refund verification amount is zero');
    saved.balance_before = await balance();
    saved.plan = {
      operation_id: key,
      loan_id: loan.loan_id,
      expected_revision: String(loan.revision),
      leg_id: leg.leg_id,
      input_atomic: input.toString(),
      net_output_atomic: output.toString(),
      execution_cost_atomic: '0',
      max_source_fee_atomic: '0',
      solver: solver.accountId,
      source_recipient: solver.accountId,
      remote_recipient: [],
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      kind: 'repayment',
      conditional_version: 0,
    };
    await release.save();
  }
  const credit = await near_view<string>(coordinator, 'storage_balance', {
    account_id: solver.accountId,
  });
  if (BigInt(credit) < 10n ** 23n)
    await near_send(release, `${key}-storage`, solver, coordinator, [
      call('storage_deposit', {}, 3n * 10n ** 23n),
    ]);
  let settlement = await near_view<Settlement | null>(
    coordinator,
    'get_settlement',
    { operation_id: key },
  );
  if (!settlement) {
    await near_send(release, `${key}-quote`, solver, coordinator, [
      call('quote_settlement', { plan: saved.plan }),
    ]);
    settlement = await near_view<Settlement>(coordinator, 'get_settlement', {
      operation_id: key,
    });
  }
  if (settlement.state === 'quoted') {
    await near_send(release, `${key}-fund`, solver, NEAR_TESTNET_USDC, [
      call('ft_transfer_call', {
        receiver_id: coordinator,
        amount: saved.plan.net_output_atomic,
        msg: JSON.stringify({ kind: 'solver_escrow', operation_id: key }),
      }),
    ]);
    settlement = await near_view<Settlement>(coordinator, 'get_settlement', {
      operation_id: key,
    });
    if (
      settlement.state !== 'funded' ||
      BigInt(saved.balance_before!) - BigInt(await balance()) !==
        BigInt(saved.plan.net_output_atomic)
    )
      throw new Error('Circle USDC solver escrow did not fund exactly');
  }
  if (settlement.state === 'funded') {
    await near_send(release, `${key}-cancel`, solver, coordinator, [
      call('cancel_settlement', { operation_id: key }),
    ]);
    settlement = await near_view<Settlement>(coordinator, 'get_settlement', {
      operation_id: key,
    });
  }
  if (settlement.state !== 'cancelled' || !settlement.refund_id)
    throw new Error('Unsigned Circle USDC escrow did not produce a refund');
  const refund = await near_view<Refund>(coordinator, 'get_refund', {
    refund_id: settlement.refund_id,
  });
  const transfer_id = scoped_id(key, 'refund');
  if (!refund.transfer_id)
    await near_send(release, `${key}-claim`, solver, coordinator, [
      call('claim_refund', { refund_id: refund.refund_id, transfer_id }),
    ]);
  await finalize_near_transfer(release, coordinator, transfer_id);
  if (
    (await balance()) !== saved.balance_before ||
    (
      await near_view<[string, string]>(coordinator, 'settlement_liabilities')
    ).some((value) => value !== '0')
  )
    throw new Error(
      'Circle USDC refund did not restore the exact balance and clear liabilities',
    );
  saved.complete = true;
  await release.save();
  console.log(
    'Circle USDC solver escrow cancellation and exact refund verified',
  );
}

export async function verify_liquidity(release: Release, d: Deployment) {
  const key = scoped_id(
    'circle-liquidity',
    d.near.settlement_token,
    ...d.pool_ids,
  );
  const saved = (release.journal.contracts[key] ??= {}) as {
    balance_before?: string;
    shares_before?: string;
    withdrawn?: string;
    cash_before_deposit?: string;
    complete?: boolean;
  };
  if (saved.complete) return;
  const coordinator = d.near.coordinator,
    pool_id = d.pool_ids[0]!,
    lp = await near_signer(release, 'lp');
  const balance = () =>
    near_view<string>(NEAR_TESTNET_USDC, 'ft_balance_of', {
      account_id: lp.accountId,
    });
  const position = () =>
    near_view<{ shares: string }>(coordinator, 'get_position', {
      pool_id,
      account_id: lp.accountId,
    });
  const pool = () => near_view<Pool>(coordinator, 'get_pool', { pool_id });
  if (!saved.balance_before) {
    saved.balance_before = await balance();
    saved.shares_before = (await position()).shares;
    await release.save();
  }
  const withdrawal_id = scoped_id(key, 'withdrawal'),
    transfer_id = scoped_id(key, 'transfer');
  await near_send(release, `${key}-request`, lp, coordinator, [
    call('request_withdrawal', { pool_id, withdrawal_id, shares: '1000000' }),
  ]);
  await near_send(release, `${key}-claim`, lp, coordinator, [
    call('claim_withdrawal', { withdrawal_id, transfer_id }),
  ]);
  const transfer = await finalize_near_transfer(
    release,
    coordinator,
    transfer_id,
  );
  if (!saved.withdrawn) {
    if (
      BigInt(await balance()) - BigInt(saved.balance_before!) !==
        BigInt(transfer.amount_atomic) ||
      BigInt(saved.shares_before!) - BigInt((await position()).shares) !==
        1_000_000n
    )
      throw new Error(
        'Circle USDC LP withdrawal did not match the finalized amount and shares',
      );
    saved.withdrawn = transfer.amount_atomic;
    saved.cash_before_deposit = (await pool()).cash_atomic;
    await release.save();
  }
  await near_send(release, `${key}-deposit`, lp, NEAR_TESTNET_USDC, [
    call('ft_transfer_call', {
      receiver_id: coordinator,
      amount: saved.withdrawn,
      msg: JSON.stringify({
        kind: 'pool_deposit',
        pool_id,
        operation_id: scoped_id(key, 'deposit'),
      }),
    }),
  ]);
  const current = await pool();
  const backing = await near_view<string>(NEAR_TESTNET_USDC, 'ft_balance_of', {
    account_id: coordinator,
  });
  if (
    (await balance()) !== saved.balance_before ||
    BigInt(current.cash_atomic) - BigInt(saved.cash_before_deposit!) !==
      BigInt(saved.withdrawn) ||
    current.cash_atomic !== backing ||
    current.in_flight_atomic !== '0'
  )
    throw new Error(
      'Circle USDC redeposit or pool backing verification failed',
    );
  saved.complete = true;
  await release.save();
  console.log(
    'Circle USDC LP withdrawal, redeposit and exact pool backing verified',
  );
}
