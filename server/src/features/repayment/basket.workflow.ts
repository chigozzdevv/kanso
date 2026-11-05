import { KansoError } from '@kanso/schema';
import type { OperationSnapshot, OperationStep } from '@kanso/schema';
import { assert_basket_settlement, plan_hash, scoped_id } from '@kanso/sdk';
import type { CoordinatorClient } from '@kanso/sdk';
import type { SolverService } from '@server/features/solver/solver.service';

export async function reconcile_basket_repayment(
  previous: OperationSnapshot,
  near: CoordinatorClient,
  solver: SolverService,
  reconcile: (child: OperationSnapshot) => Promise<OperationSnapshot>,
): Promise<OperationSnapshot> {
  const state = structuredClone(previous);
  const plan = state.plan;
  if (plan.kind !== 'basket_repayment')
    throw new KansoError('INVALID_INPUT', 'Expected a basket repayment');
  const quotes = state.settlement_quotes ?? [];
  const steps: OperationStep[] = [];
  const finish = (status: OperationSnapshot['status']) => ({
    ...state,
    steps,
    status,
  });
  const priced = (index: number, done: boolean): OperationStep => ({
    step_id: `sale_${index}_quote`,
    label: 'Prepare collateral sale',
    family: 'near',
    chain_id: 'near',
    state: done ? 'confirmed' : 'pending',
    action: null,
    transaction_id: null,
    error: null,
  });
  let paid = 0n;
  for (let index = 0; index < plan.quote.allocations.length; index++) {
    const allocation = plan.quote.allocations[index]!;
    const prefix = `sale_${index}_`;
    const loan = await near.view('get_loan', { loan_id: plan.loan_id });
    let quote = quotes[index];
    if (
      !quote &&
      (state.cancellation_requested ||
        paid >= BigInt(plan.quote.amount_atomic) ||
        loan.state === 'repaid')
    )
      break;
    if (!quote) {
      if (index === 0 && plan.quote.expires_at <= (await near.now()))
        throw new KansoError('OFFER_EXPIRED', 'Review your repayment again');
      const remaining = BigInt(plan.quote.amount_atomic) - paid;
      const summary = await near.view('loan_summary', {
        loan_id: plan.loan_id,
      });
      const target = [
        remaining,
        BigInt(allocation.amount_atomic),
        BigInt(summary.debt_atomic),
      ].reduce((a, b) => (a < b ? a : b));
      if (target <= 0n) break;
      let input = allocation.input_atomic;
      try {
        input = (
          await solver.estimate(loan, {
            mode: 'collateral',
            leg_id: allocation.leg_id,
            amount_atomic: target.toString(),
          })
        ).input_atomic;
      } catch (error) {
        // Prior sales can round up enough to leave a remainder below the network fee minimum.
        if (!(error instanceof KansoError) || error.code !== 'BUDGET_EXHAUSTED')
          throw error;
      }
      quote = await solver.quote({
        loan_id: plan.loan_id,
        leg_id: allocation.leg_id,
        input_atomic: input,
        max_execution_cost_atomic: allocation.execution_cost_atomic,
      });
      assert_basket_settlement(plan.quote, index, quote, target);
      quotes.push(quote);
      state.settlement_quotes = quotes;
      // Journal the quote before any escrow funding or signature request.
      steps.push(priced(index, false));
      return finish('running');
    }
    steps.push(priced(index, true));
    if (state.cancellation_requested) {
      const uncertain = previous.steps.some(
        (step) =>
          step.step_id === prefix + 'commit' &&
          ['submitted', 'unknown', 'confirmed'].includes(step.state),
      );
      if (!uncertain && (await solver.cancel_uncommitted(quote)))
        return finish('cancelled');
    }
    const childPlan = { kind: 'settlement' as const, plan: quote };
    const child: OperationSnapshot = {
      ...previous,
      operation_id: scoped_id(previous.operation_id, `sale_${index}`),
      plan: childPlan,
      plan_hash: plan_hash(childPlan),
      status: 'running',
      steps: previous.steps
        .filter(
          (step) =>
            step.step_id.startsWith(prefix) &&
            step.step_id !== prefix + 'quote',
        )
        .map((step) => ({
          ...step,
          step_id: step.step_id.slice(prefix.length),
        })),
    };
    delete child.settlement_quotes;
    const updated = await reconcile(child);
    steps.push(
      ...updated.steps.map((step) => ({
        ...step,
        step_id: prefix + step.step_id,
      })),
    );
    if (updated.status !== 'succeeded') {
      state.error = updated.error;
      state.next_poll_after_ms = updated.next_poll_after_ms;
      return finish(updated.status);
    }
    const settled = await near.view('get_settlement', {
      operation_id: quote.operation_id,
    });
    if (settled?.state !== 'applied')
      throw new KansoError(
        'SETTLEMENT_RECONCILING',
        'Waiting for the confirmed repayment',
        true,
      );
    paid += BigInt(settled.applied_atomic);
  }
  if (!steps.length)
    steps.push({
      ...priced(0, true),
      step_id: 'debt',
      label: 'Verify repaid balance',
    });
  return finish(state.cancellation_requested ? 'cancelled' : 'succeeded');
}
