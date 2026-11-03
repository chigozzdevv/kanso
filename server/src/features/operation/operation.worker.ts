import type { Runtime } from '@server/shared/runtime';
import { scoped_id } from '@kanso/sdk';
export async function reconcile_operation(r: Runtime, operation_id: string) {
  let snapshot = await r.operations.reconcile(operation_id);
  const plan = snapshot.plan;
  if (
    !['failed', 'cancelled', 'succeeded'].includes(snapshot.status) &&
    plan.kind === 'settlement' &&
    plan.plan.kind !== 'repayment' &&
    r.solver.signer
  ) {
    const step = snapshot.steps.find(
      (s) =>
        ['pending', 'submitted', 'unknown'].includes(s.state) &&
        !s.transaction_id &&
        s.action?.family === 'near' &&
        s.action.signer_id === r.solver.signer!.account.accountId,
    );
    if (step?.action?.family === 'near') {
      if (step.state === 'pending')
        snapshot = await r.operations.begin(
          snapshot.owner,
          snapshot.operation_id,
          step.step_id,
          snapshot.revision,
        );
      const sent = await r.solver.signer.send(
        step.action,
        scoped_id('keeper', snapshot.operation_id, step.step_id),
      );
      await r.operations.submit(
        snapshot.owner,
        snapshot.operation_id,
        step.step_id,
        sent.transaction_id,
      );
    }
  }
}
