import { KansoError, mul_div_floor } from '@kanso/schema';
import type { Loan, ConditionalAuthorization } from '@kanso/schema';
import { scoped_id } from '@kanso/sdk';
import type { Runtime } from '@server/shared/runtime';
export function bounded_input(
  max: bigint,
  allowed: (input: bigint) => boolean,
): bigint {
  let low = 0n,
    high = max;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (allowed(mid)) low = mid;
    else high = mid - 1n;
  }
  return low;
}
export class KeeperService {
  constructor(private readonly r: Runtime) {}
  async tick() {
    const errors: unknown[] = [];
    if (!this.r.solver.signer) return errors;
    const expired = this.r.repo.model
      .find({
        deployment_id: this.r.options.deployment.deployment_id,
        'snapshot.plan.kind': 'settlement',
        'snapshot.status': 'failed',
        'snapshot.plan.plan.expires_at': {
          $lte: await this.r.coordinator.now(),
        },
      })
      .cursor();
    for await (const row of expired) {
      try {
        const snapshot = row.snapshot;
        if (snapshot.plan.kind !== 'settlement') continue;
        await this.r.solver.cancel_expired(snapshot.plan.plan);
        const settlement = await this.r.coordinator.view('get_settlement', {
          operation_id: snapshot.plan.plan.operation_id,
        });
        if (settlement?.state === 'cancelled')
          await this.r.repo.update(
            { ...snapshot, status: 'cancelled' },
            snapshot.revision,
          );
      } catch (error) {
        if (!(error instanceof KansoError && error.retryable))
          errors.push(error);
      }
    }

    const rows = await this.r.indexer.projections.loans
      .find({
        deployment_id: this.r.options.deployment.deployment_id,
        'record.state': 'active',
      })
      .select('loan_id')
      .lean();
    for (const row of rows) {
      try {
        await this.reconcile(row.loan_id);
      } catch (e) {
        if (!(
          e instanceof KansoError &&
          [
            'PRICE_STALE',
            'CAPABILITY_DISABLED',
            'INSUFFICIENT_BALANCE',
            'REVISION_CONFLICT',
            'SETTLEMENT_RECONCILING',
          ].includes(e.code)
        ))
          errors.push(e);
      }
    }
    return errors;
  }
  async reconcile(loan_id: string) {
    const r = this.r,
      signer = r.solver.signer;
    if (!signer) return;
    const pending = await r.repo.model
      .findOne({
        deployment_id: r.options.deployment.deployment_id,
        'snapshot.plan.kind': 'settlement',
        'snapshot.plan.plan.loan_id': loan_id,
        'snapshot.status': { $nin: ['succeeded', 'cancelled', 'failed'] },
      })
      .lean();
    if (pending) {
      if (pending.snapshot.plan.kind === 'settlement')
        await r.solver.cancel_expired(pending.snapshot.plan.plan);
      return;
    }
    const loan = await r.coordinator.view('get_loan', { loan_id });
    if (
      loan.state !== 'active' ||
      loan.active_outflow ||
      loan.recovery_outflows.length
    )
      return;
    const risk = await r.coordinator.view('basket_risk', { loan_id }),
      debt = BigInt(risk.debt_atomic);
    if (!debt) return;
    const liquidation = risk.defaulted || BigInt(risk.health_ppm) <= 1000000n;
    const authorization = liquidation
      ? null
      : await r.coordinator.view('get_conditional_repayment', { loan_id });
    const now = await r.coordinator.now();
    if (
      !liquidation &&
      (!authorization?.terms.enabled ||
        (authorization.terms.expires_at !== null &&
          authorization.terms.expires_at <= now) ||
        BigInt(risk.health_ppm) >
          BigInt(authorization.terms.trigger_health_ppm))
    )
      return;
    const prices = await r.risk.prices(
      loan.locks
        .filter((x) => x.purpose.kind === 'collateral' && x.accepted)
        .map((x) => x.leg),
    );
    for (const lock of loan.locks) {
      if (lock.purpose.kind !== 'collateral' || !lock.accepted) continue;
      let max = BigInt(lock.locked_atomic) - BigInt(lock.reserved_atomic);
      if (authorization) {
        const limit = authorization.terms.max_collateral_spend.find(
            (x) => x.asset_id === lock.leg.asset_id,
          ),
          usage = authorization.spend.find(
            (x) => x.asset_id === lock.leg.asset_id,
          );
        if (!limit || !usage) continue;
        max = min(
          max,
          BigInt(limit.max_total_atomic) -
            BigInt(usage.consumed_atomic) -
            BigInt(usage.reserved_atomic),
        );
      }
      if (max <= 0n) continue;
      const manifest =
        lock.leg.custody.family === 'remote'
          ? await r.coordinator.view('get_chain_manifest', {
              chain_id: lock.leg.custody.chain_id,
              version: lock.leg.custody.manifest_version,
            })
          : null;
      const fee =
        manifest?.family === 'bitcoin'
          ? BigInt(manifest.max_network_cost_atomic)
          : 0n;
      const fee_value = r.risk.value(
        lock.leg,
        fee,
        prices.get(lock.leg.asset_id)!,
      );
      const estimate = (input: bigint) => {
        const fair = r.risk.value(
          lock.leg,
          input,
          prices.get(lock.leg.asset_id)!,
        );
        const cost =
          mul_div_floor(fair, BigInt(r.solver.fee_bps), 10000n) + fee_value;
        return { output: fair - cost, cost };
      };
      const budget = authorization
        ? min(
            debt,
            BigInt(authorization.terms.max_total_repayment_atomic) -
              BigInt(authorization.consumed_repayment_atomic) -
              BigInt(authorization.reserved_repayment_atomic),
          )
        : debt + BigInt(loan.policy.max_liquidation_surplus_atomic);
      const cost_budget = authorization
        ? min(
            BigInt(loan.policy.max_execution_cost_atomic),
            BigInt(authorization.terms.max_execution_cost_atomic) -
              BigInt(authorization.consumed_cost_atomic) -
              BigInt(authorization.reserved_cost_atomic),
          )
        : BigInt(loan.policy.max_execution_cost_atomic);
      if (budget <= 0n || cost_budget < 0n) continue;
      const post_health = (input: bigint, output: bigint) => {
        const post_debt = debt - min(debt, output);
        if (post_debt === 0n) return null;
        const legs = loan.locks
          .filter((x) => x.purpose.kind === 'collateral' && x.accepted)
          .map((x) => ({
            ...x.leg,
            amount_atomic: (
              BigInt(x.locked_atomic) -
              BigInt(x.reserved_atomic) -
              (x.leg.leg_id === lock.leg.leg_id ? input : 0n)
            ).toString(),
          }));
        return (
          (r.risk.capacity(legs, loan.policy, prices, true) * 1000000n) /
          post_debt
        );
      };
      let input = bounded_input(max, (n) => {
        const q = estimate(n);
        if (q.output > budget || q.cost > cost_budget) return false;
        if (authorization && q.output > 0n) {
          const h = post_health(n, q.output);
          if (h !== null && h > BigInt(authorization.terms.target_health_ppm))
            return false;
        }
        return true;
      });
      if (liquidation && !risk.defaulted && input > 0n) {
        let low = 1n,
          high = input;
        while (low < high) {
          const mid = (low + high) / 2n,
            q = estimate(mid),
            h = q.output > 0n ? post_health(mid, q.output) : 0n;
          if (h === null || h >= BigInt(loan.policy.recovery_health_ppm + 1000))
            high = mid;
          else low = mid + 1n;
        }
        input = low;
      }
      if (input <= fee || input <= 0n) continue;
      const key =
        'keeper_' +
        scoped_id(
          loan_id,
          loan.revision,
          liquidation ? 'liquidation' : 'conditional',
          String(authorization?.version ?? 0),
          ...Array.from(prices, ([asset, value]) => asset + ':' + value),
        );
      const operation_id = scoped_id(
        r.options.deployment.deployment_id,
        signer.account.accountId,
        key,
      );
      if (await r.repo.model.exists({ _id: operation_id })) return;
      const plan = await r.solver.quote({
        loan_id,
        leg_id: lock.leg.leg_id,
        input_atomic: input.toString(),
        max_execution_cost_atomic: cost_budget.toString(),
        kind: liquidation ? 'liquidation' : 'conditional',
        conditional_version: authorization?.version ?? 0,
      });
      if (
        plan.expected_revision !== loan.revision ||
        BigInt(plan.net_output_atomic) > budget
      )
        continue;
      if (
        authorization &&
        BigInt(plan.execution_cost_atomic) * 10000n >
          (BigInt(plan.net_output_atomic) +
            BigInt(plan.execution_cost_atomic)) *
            BigInt(authorization.terms.max_execution_cost_bps)
      )
        continue;
      const health = post_health(input, BigInt(plan.net_output_atomic));
      if (
        !valid_repair(
          loan,
          authorization,
          liquidation,
          risk.defaulted,
          BigInt(risk.health_ppm),
          health,
        )
      )
        continue;
      await r.operations.prepare(
        signer.account.accountId,
        { kind: 'settlement', plan },
        key,
      );
      return;
    }
  }
}
const min = (a: bigint, b: bigint) => (a < b ? a : b);
export function valid_repair(
  loan: Loan,
  a: ConditionalAuthorization | null,
  liquidation: boolean,
  defaulted: boolean,
  before: bigint,
  after: bigint | null,
) {
  if (after === null) return true;
  if (liquidation)
    return defaulted || after >= BigInt(loan.policy.recovery_health_ppm);
  return !!a && after > before && after <= BigInt(a.terms.target_health_ppm);
}
