import type {
  Loan,
  LoanSummary,
  Settlement,
  SettlementPlan,
} from '@kanso/schema';
import type { Release } from '@testnet/deployment';
import {
  near_send,
  near_signer,
  near_view,
  call,
  finalize_near_transfer,
} from '@testnet/deploy-near';
import { live_plan } from '@testnet/live-setup';
import { execute_outgoing } from '@testnet/live-outgoing';
import { refresh_prices } from '@testnet/live-loans';

export async function finalize_live(release: Release, transfer_id: string) {
  const { deployment: d } = await live_plan(release);
  await finalize_near_transfer(release, d.near.coordinator, transfer_id);
}
export async function settle_live(release: Release) {
  const { deployment: d, offers } = await live_plan(release);
  const solver = await near_signer(release, 'solver'),
    borrower = await near_signer(release, 'borrower');
  await refresh_prices();
  for (const offer of offers) {
    const leg = offer.legs[0]!;
    if (process.env.LIVE_CHAIN && leg.leg_id !== process.env.LIVE_CHAIN)
      continue;
    let loan = await near_view<Loan>(d.near.coordinator, 'get_loan', {
      loan_id: offer.offer_id,
    });
    if (loan.state !== 'active') continue;
    const c = d.chains.find((c) => c.manifest.chain_id === leg.leg_id);
    const liquidation = offer.duration_seconds === 1;
    const operation_id = `sale_${loan.loan_id}`;
    const transfer_id = `delivery_${loan.loan_id}`;
    let settlement = await near_view<Settlement | null>(
      d.near.coordinator,
      'get_settlement',
      { operation_id },
    );
    if (!settlement) {
      await refresh_prices();
      const price = await near_view<{
        price_atomic: string;
        confidence_bps: number;
        published_at: number;
      }>(d.near.coordinator, 'get_asset_price', { asset_id: leg.asset_id });
      if (Date.now() / 1000 - price.published_at > 180)
        throw new Error('Refresh oracle before quoting');
      const conservative =
        (BigInt(price.price_atomic) * BigInt(10000 - price.confidence_bps)) /
        10000n;
      const scale = 10n ** BigInt(c?.manifest.decimals ?? 24);
      const summary = await near_view<LoanSummary>(
        d.near.coordinator,
        'loan_summary',
        { loan_id: loan.loan_id },
      );
      const fee = c?.manifest.family === 'bitcoin' ? 1000n : 0n;
      const cost = (fee * conservative + scale - 1n) / scale;
      const target = liquidation
        ? BigInt(summary.debt_atomic) +
          BigInt(offer.principal_atomic) / 100n +
          10n
        : BigInt(offer.principal_atomic) / 2n;
      const input =
        ((target + cost) * scale + conservative - 1n) / conservative;
      const fair = (input * conservative) / scale;
      const plan: SettlementPlan = {
        operation_id,
        loan_id: loan.loan_id,
        expected_revision: String(loan.revision),
        leg_id: leg.leg_id,
        input_atomic: input.toString(),
        net_output_atomic: (fair - cost).toString(),
        execution_cost_atomic: cost.toString(),
        max_source_fee_atomic: fee.toString(),
        solver: solver.accountId,
        source_recipient: solver.accountId,
        remote_recipient:
          leg.custody.family === 'remote' ? leg.custody.source_owner : [],
        expires_at: Math.floor(Date.now() / 1000) + 7200,
        kind: liquidation ? 'liquidation' : 'repayment',
        conditional_version: 0,
      };
      release.journal.contracts[`sale-plan-${loan.loan_id}`] = plan;
      await release.save();
      await near_send(
        release,
        `quote-${loan.loan_id}`,
        solver,
        d.near.coordinator,
        [call('quote_settlement', { plan })],
      );
      settlement = await near_view(d.near.coordinator, 'get_settlement', {
        operation_id,
      });
    }
    if (!settlement) throw new Error('Quoted settlement absent');
    if (settlement.state === 'quoted') {
      await near_send(
        release,
        `escrow-${loan.loan_id}`,
        solver,
        d.near.settlement_token,
        [
          call('ft_transfer_call', {
            receiver_id: d.near.coordinator,
            amount: settlement.plan.net_output_atomic,
            msg: JSON.stringify({ kind: 'solver_escrow', operation_id }),
          }),
        ],
      );
      settlement = await near_view<Settlement>(
        d.near.coordinator,
        'get_settlement',
        { operation_id },
      );
      if (settlement.state !== 'funded')
        throw new Error(`Solver escrow not funded: ${loan.loan_id}`);
    }
    if (settlement.state === 'funded') {
      await near_send(
        release,
        `commit-${loan.loan_id}`,
        liquidation ? solver : borrower,
        d.near.coordinator,
        [call('commit_settlement', { operation_id, transfer_id })],
      );
      settlement = await near_view<Settlement>(
        d.near.coordinator,
        'get_settlement',
        { operation_id },
      );
    }
    if (settlement.state === 'committed') {
      if (c) {
        if (!(await execute_outgoing(release, c, transfer_id, 'solver')))
          continue;
      } else await finalize_live(release, transfer_id);
      settlement = await near_view<Settlement>(
        d.near.coordinator,
        'get_settlement',
        { operation_id },
      );
    }
    if (settlement.state === 'delivered')
      await near_send(
        release,
        `apply-${loan.loan_id}`,
        solver,
        d.near.coordinator,
        [call('apply_settlement', { operation_id }, 0n)],
      );
    settlement = await near_view<Settlement>(
      d.near.coordinator,
      'get_settlement',
      { operation_id },
    );
    if (settlement.state !== 'applied')
      throw new Error(`Settlement is not applied: ${loan.loan_id}`);
    loan = await near_view<Loan>(d.near.coordinator, 'get_loan', {
      loan_id: loan.loan_id,
    });
    if (loan.state === 'active') {
      const summary = await near_view<LoanSummary>(
        d.near.coordinator,
        'loan_summary',
        { loan_id: loan.loan_id },
      );
      const amount =
        BigInt(summary.debt_atomic) +
        BigInt(offer.principal_atomic) / 100n +
        10n;
      await near_send(
        release,
        `repay-${loan.loan_id}`,
        borrower,
        d.near.settlement_token,
        [
          call('ft_transfer_call', {
            receiver_id: d.near.coordinator,
            amount: amount.toString(),
            msg: JSON.stringify({
              kind: 'repayment',
              loan_id: loan.loan_id,
              operation_id: `repay_${loan.loan_id}`,
            }),
          }),
        ],
      );
    }
    loan = await near_view<Loan>(d.near.coordinator, 'get_loan', {
      loan_id: loan.loan_id,
    });
    if (loan.state !== 'repaid')
      throw new Error('Repayment did not clear debt');
    console.log(
      `${loan.loan_id}: verified settlement applied and debt cleared`,
    );
  }
}
export async function release_live(release: Release) {
  const { deployment: d, offers } = await live_plan(release);
  const borrower = await near_signer(release, 'borrower');
  for (const offer of offers) {
    const leg = offer.legs[0]!;
    if (process.env.LIVE_CHAIN && process.env.LIVE_CHAIN !== leg.leg_id)
      continue;
    const loan = await near_view<Loan>(d.near.coordinator, 'get_loan', {
      loan_id: offer.offer_id,
    });
    if (loan.state !== 'repaid' || loan.locks[0]!.locked_atomic === '0')
      continue;
    const amount = loan.locks[0]!.locked_atomic;
    const operation_id = `release_${loan.loan_id}`;
    const c = d.chains.find((c) => c.manifest.chain_id === leg.leg_id);
    if (!c) {
      await near_send(
        release,
        `release-${loan.loan_id}`,
        borrower,
        d.near.coordinator,
        [
          call('release_collateral', {
            loan_id: loan.loan_id,
            leg_id: leg.leg_id,
            transfer_id: operation_id,
          }),
        ],
      );
      await finalize_live(release, operation_id);
    } else {
      const bitcoin = c.manifest.family === 'bitcoin';
      const existing = await near_view(
        d.near.coordinator,
        bitcoin ? 'get_bitcoin_spend' : 'get_remote_operation',
        { operation_id },
      );
      if (!existing)
        await near_send(
          release,
          `release-${loan.loan_id}`,
          borrower,
          d.near.coordinator,
          [
            call(
              bitcoin ? 'prepare_bitcoin_release' : 'prepare_remote_release',
              {
                operation_id,
                loan_id: loan.loan_id,
                leg_id: leg.leg_id,
                expected_revision: String(loan.revision),
                amount_atomic: bitcoin
                  ? (BigInt(amount) - 1000n).toString()
                  : amount,
                ...(bitcoin
                  ? { max_fee_atomic: '1000' }
                  : { deadline: Math.floor(Date.now() / 1000) + 7200 }),
              },
            ),
          ],
        );
      if (!(await execute_outgoing(release, c, operation_id, 'borrower')))
        continue;
    }
    const complete = await near_view<Loan>(d.near.coordinator, 'get_loan', {
      loan_id: loan.loan_id,
    });
    if (
      complete.locks.some(
        (l) => l.locked_atomic !== '0' || l.reserved_atomic !== '0',
      )
    )
      throw new Error(`Custody not fully released: ${loan.loan_id}`);
    console.log(`${loan.loan_id}: collateral release verified`);
  }
}
