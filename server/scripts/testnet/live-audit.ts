import type {
  Refund,
  Settlement,
  Transfer,
  Loan,
  PoolPolicy,
} from '@kanso/schema';
import type { Release } from '@testnet/deployment';
import { digest } from '@testnet/deployment';
import { near_send, near_signer, near_view, call } from '@testnet/deploy-near';
import { live_plan } from '@testnet/live-setup';
import { finalize_live } from '@testnet/live-settlement';

type Pool = {
  cash_atomic: string;
  reserved_atomic: string;
  in_flight_atomic: string;
  total_shares: string;
  recognized_loss_atomic: string;
};
export async function audit_live(release: Release) {
  const { deployment: d, offers } = await live_plan(release);
  const borrower = await near_signer(release, 'borrower'),
    lp = await near_signer(release, 'lp');
  for (const offer of offers) {
    const settlement = await near_view<Settlement | null>(
      d.near.coordinator,
      'get_settlement',
      { operation_id: `sale_${offer.offer_id}` },
    );
    if (settlement?.state !== 'applied' || !settlement.refund_id) continue;
    const refund = await near_view<Refund>(d.near.coordinator, 'get_refund', {
      refund_id: settlement.refund_id,
    });
    if (refund.paid) continue;
    if (refund.owner !== borrower.accountId)
      throw new Error('Unexpected test refund owner');
    const transfer_id = `claim_${offer.offer_id}`;
    await near_send(release, transfer_id, borrower, d.near.coordinator, [
      call('claim_refund', { refund_id: refund.refund_id, transfer_id }),
    ]);
    await finalize_live(release, transfer_id);
    const paid = await near_view<Refund>(d.near.coordinator, 'get_refund', {
      refund_id: refund.refund_id,
    });
    if (!paid.paid) throw new Error('Borrower surplus refund did not complete');
  }
  const pool_id = 'live-verification',
    withdrawal_id = 'live_lp_withdrawal_v1',
    transfer_id = 'live_lp_withdrawal_transfer_v1';
  type Position = { shares: string; reserved_shares: string };
  if (!release.journal.contracts.lp_before) {
    release.journal.contracts.lp_before = {
      position: await near_view<Position>(d.near.coordinator, 'get_position', {
        pool_id,
        account_id: lp.accountId,
      }),
      pool: await near_view<Pool>(d.near.coordinator, 'get_pool', { pool_id }),
      token_balance: await near_view<string>(
        d.near.settlement_token,
        'ft_balance_of',
        { account_id: lp.accountId },
      ),
    };
    await release.save();
  }
  await near_send(release, 'lp-withdraw-request', lp, d.near.coordinator, [
    call('request_withdrawal', { withdrawal_id, pool_id, shares: '1000000' }),
  ]);
  await near_send(release, 'lp-withdraw-claim', lp, d.near.coordinator, [
    call('claim_withdrawal', { withdrawal_id, transfer_id }),
  ]);
  await finalize_live(release, transfer_id);
  const before = release.journal.contracts.lp_before as {
    position: Position;
    pool: Pool;
    token_balance: string;
  };
  const verified = release.journal.contracts.accounting as
    | {
        lp_after: { position: Position; pool: Pool; token_balance: string };
        withdrawal_verified_at?: string;
        verified_at: string;
      }
    | undefined;
  const after = verified?.lp_after ?? {
    position: await near_view<Position>(d.near.coordinator, 'get_position', {
      pool_id,
      account_id: lp.accountId,
    }),
    pool: await near_view<Pool>(d.near.coordinator, 'get_pool', { pool_id }),
    token_balance: await near_view<string>(
      d.near.settlement_token,
      'ft_balance_of',
      { account_id: lp.accountId },
    ),
  };
  const withdrawal = await near_view<Transfer>(
    d.near.coordinator,
    'get_transfer',
    { transfer_id },
  );
  if (
    BigInt(before.position.shares) - BigInt(after.position.shares) !==
      1000000n ||
    after.position.reserved_shares !== '0' ||
    BigInt(after.token_balance) - BigInt(before.token_balance) !==
      BigInt(withdrawal.amount_atomic) ||
    BigInt(before.pool.cash_atomic) - BigInt(after.pool.cash_atomic) !==
      BigInt(withdrawal.amount_atomic) ||
    BigInt(before.pool.total_shares) - BigInt(after.pool.total_shares) !==
      1000000n
  )
    throw new Error('Live LP share, cash or payout accounting mismatch');
  const replay_balance = await near_view<string>(
    d.near.settlement_token,
    'ft_balance_of',
    {
      account_id: lp.accountId,
    },
  );
  const replay_id = `lp-withdraw-replay-${digest(replay_balance).slice(0, 16)}`;
  await near_send(release, replay_id, lp, d.near.coordinator, [
    call('claim_withdrawal', { withdrawal_id, transfer_id }),
  ]);
  if (
    (await near_view<string>(d.near.settlement_token, 'ft_balance_of', {
      account_id: lp.accountId,
    })) !== replay_balance
  )
    throw new Error('LP withdrawal replay paid twice');
  const pools = await Promise.all(
    ['test-usdc', 'live-verification'].map((pool_id) =>
      near_view<Pool>(d.near.coordinator, 'get_pool', { pool_id }),
    ),
  );
  if (pools.some((p) => p.in_flight_atomic !== '0'))
    throw new Error('Resolve in-flight transfers before the accounting audit');
  const [escrow, refunds] = await near_view<[string, string]>(
    d.near.coordinator,
    'settlement_liabilities',
  );
  const token_balance = await near_view<string>(
    d.near.settlement_token,
    'ft_balance_of',
    { account_id: d.near.coordinator },
  );
  const cash = pools.reduce((total, p) => total + BigInt(p.cash_atomic), 0n);
  const required = cash + BigInt(escrow) + BigInt(refunds);
  if (BigInt(token_balance) < required)
    throw new Error(
      'Settlement token backing is below pool cash and liabilities',
    );
  if (!release.journal.contracts.pool_governance) {
    const current = await near_view<{ policy: PoolPolicy }>(
      d.near.coordinator,
      'get_pool',
      { pool_id },
    );
    const target = (release.journal.contracts.policy_target as
      PoolPolicy | undefined) ?? {
      ...current.policy,
      version: current.policy.version + 1,
      apr_bps: 1100,
    };
    release.journal.contracts.policy_target = target;
    await release.save();
    const wrong = 'policy-unauthorized';
    if (!release.journal.effects[wrong]) {
      try {
        await near_send(release, wrong, lp, d.near.coordinator, [
          call('update_pool_policy', { pool_id, policy: target }),
        ]);
      } catch (error) {
        const recorded = () => release.journal.effects[wrong];
        if (!JSON.stringify(recorded()?.result).includes('MANAGER_REQUIRED'))
          throw error;
      }
    }
    if (
      release.journal.effects[wrong]?.state !== 'failed' ||
      !JSON.stringify(release.journal.effects[wrong]?.result).includes(
        'MANAGER_REQUIRED',
      )
    )
      throw new Error('Pool accepted an unauthorized policy change');
    await near_send(
      release,
      'policy-manager-update',
      await near_signer(release, 'manager'),
      d.near.coordinator,
      [call('update_pool_policy', { pool_id, policy: target })],
    );
    const old = await near_view<Loan>(d.near.coordinator, 'get_loan', {
      loan_id: 'live_near_repay_v1',
    });
    const updated = await near_view<{ policy: PoolPolicy }>(
      d.near.coordinator,
      'get_pool',
      { pool_id },
    );
    if (
      old.policy.version !== 1 ||
      old.policy.apr_bps !== 1000 ||
      updated.policy.version !== target.version ||
      updated.policy.apr_bps !== 1100
    )
      throw new Error('Pool governance changed accepted loan terms');
    release.journal.contracts.pool_governance = {
      unauthorized_transaction: release.journal.effects[wrong]!.transaction_id,
      manager_transaction:
        release.journal.effects['policy-manager-update']!.transaction_id,
      new_policy: updated.policy,
      accepted_loan_policy: old.policy,
      verified_at: new Date().toISOString(),
    };
    await release.save();
  }
  release.journal.contracts.accounting = {
    lp_before: before,
    lp_after: after,
    withdrawal,
    duplicate_withdrawal_transaction:
      release.journal.effects[replay_id]!.transaction_id,
    withdrawal_verified_at:
      verified?.withdrawal_verified_at ??
      verified?.verified_at ??
      new Date().toISOString(),
    coordinator_token_balance_atomic: token_balance,
    pool_cash_atomic: cash.toString(),
    escrow_atomic: escrow,
    refund_liability_atomic: refunds,
    required_backing_atomic: required.toString(),
    unallocated_surplus_atomic: (BigInt(token_balance) - required).toString(),
    verified_at: new Date().toISOString(),
  };
  await release.save();
  console.log(
    'Borrower surplus, LP withdrawal, replay protection and settlement-token backing verified',
  );
}
