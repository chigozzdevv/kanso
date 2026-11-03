import { KansoError } from '@kanso/schema';
import type { OperationPlan } from '@kanso/schema';
import { plan_hash } from '@kanso/sdk';
import type { CoordinatorClient } from '@kanso/sdk';
import type { SolverService } from '@server/features/solver/solver.service';
import type { OperationService } from '@server/features/operation/operation.service';
export class RepaymentService {
  constructor(
    private readonly near: CoordinatorClient,
    private readonly solver: SolverService,
    private readonly operations: OperationService,
  ) {}
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
