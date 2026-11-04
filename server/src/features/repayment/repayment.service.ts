import { KansoError } from '@kanso/schema';
import type { OperationPlan, RepaymentEstimateInput } from '@kanso/schema';
import { plan_hash } from '@kanso/sdk';
import type { CoordinatorClient } from '@kanso/sdk';
import type { SolverService } from '@server/features/solver/solver.service';
import type { OperationService } from '@server/features/operation/operation.service';
import type { CatalogService } from '@server/features/catalog/catalog.service';
export class RepaymentService {
  constructor(
    private readonly near: CoordinatorClient,
    private readonly solver: SolverService,
    private readonly operations: OperationService,
    private readonly catalog: CatalogService,
  ) {}
  async estimate(
    owner: string,
    loan_id: string,
    input: RepaymentEstimateInput,
  ) {
    const loan = await this.near.view('get_loan', { loan_id });
    if (loan.state !== 'active')
      throw new KansoError(
        'INVALID_INPUT',
        'This loan is not open for repayment',
      );
    const summary = await this.near.view('loan_summary', { loan_id });
    if (BigInt(input.amount_atomic) > BigInt(summary.debt_atomic))
      throw new KansoError(
        'INVALID_INPUT',
        'Enter an amount up to the current debt',
      );
    if ('leg_id' in input) {
      const lock = loan.locks.find((l) => l.leg.leg_id === input.leg_id);
      if (!lock?.accepted)
        throw new KansoError(
          'LOCK_NOT_VERIFIED',
          'Repayment input has not been accepted',
        );
      if ((input.mode === 'wallet') !== (lock.purpose.kind === 'payment'))
        throw new KansoError(
          'INVALID_INPUT',
          'Repayment mode differs from the committed input purpose',
        );
      const payer =
        lock.purpose.kind === 'payment'
          ? lock.purpose.payer
          : loan.offer.borrower;
      if (owner !== payer)
        throw new KansoError(
          'FORBIDDEN',
          'Prove ownership of the repayment input',
        );
    } else {
      if (loan.locks.length >= 16)
        throw new KansoError(
          'INVALID_INPUT',
          'This loan has no room for another payment input',
        );
      const assets = await this.catalog.assets();
      if (!assets.some((a) => a.asset_id === input.asset_id && a.enabled))
        throw new KansoError(
          'CAPABILITY_DISABLED',
          'This payment asset is currently unavailable',
        );
    }
    return this.solver.estimate(loan, input);
  }
  async review(
    owner: string,
    loan_id: string,
    input:
      | { mode: 'direct'; amount_atomic: string }
      | {
          mode: 'collateral' | 'wallet';
          leg_id: string;
          input_atomic: string;
          max_execution_cost_atomic: string;
        },
  ) {
    let plan: OperationPlan;
    if (input.mode === 'direct')
      plan = { kind: 'repayment', loan_id, amount_atomic: input.amount_atomic };
    else {
      const loan = await this.near.view('get_loan', { loan_id });
      const lock = loan.locks.find((l) => l.leg.leg_id === input.leg_id);
      if (!lock) throw new KansoError('NOT_FOUND', 'Repayment input not found');
      if ((input.mode === 'wallet') !== (lock.purpose.kind === 'payment'))
        throw new KansoError(
          'INVALID_INPUT',
          'Repayment mode differs from the committed input purpose',
        );
      const payer =
        lock.purpose.kind === 'payment'
          ? lock.purpose.payer
          : loan.offer.borrower;
      if (owner !== payer)
        throw new KansoError(
          'FORBIDDEN',
          'Prove ownership of the repayment input',
        );
      plan = {
        kind: 'settlement',
        plan: await this.solver.quote({
          loan_id,
          leg_id: input.leg_id,
          input_atomic: input.input_atomic,
          max_execution_cost_atomic: input.max_execution_cost_atomic,
        }),
      };
    }
    return {
      plan,
      plan_hash: plan_hash(plan),
      expires_at: (await this.near.now()) + 120,
    };
  }
  async prepare(
    owner: string,
    loan_id: string,
    input: {
      review: { plan: OperationPlan; plan_hash: string };
      idempotency_key: string;
    },
  ) {
    const { plan } = input.review;
    if (plan_hash(plan) !== input.review.plan_hash)
      throw new KansoError('INVALID_INPUT', 'Repayment review was changed');
    if (
      (plan.kind !== 'repayment' && plan.kind !== 'settlement') ||
      (plan.kind === 'repayment' ? plan.loan_id : plan.plan.loan_id) !== loan_id
    )
      throw new KansoError('INVALID_INPUT', 'Review belongs to another loan');
    return this.operations.prepare(owner, plan, input.idempotency_key);
  }
}
