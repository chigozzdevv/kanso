import { z } from 'zod';
import { identifier, positive_amount } from '@kanso/schema';
import type { OperationPlan, RepaymentEstimate } from '@kanso/schema';

export const repaymentCheckpoint = z.strictObject({
  operation_id: identifier,
  owner: z.string().min(1),
  phase: z.enum(['wallet_payment', 'repayment', 'refund']),
  amount_atomic: positive_amount.nullable(),
});
export type RepaymentCheckpoint = z.infer<typeof repaymentCheckpoint>;
export type RepaymentReview = {
  owner: string;
  amount: string;
  estimate?: RepaymentEstimate;
  review?: { plan: OperationPlan; plan_hash: string; expires_at: number };
};

export function checkedSettlement(
  estimate: RepaymentEstimate,
  review: NonNullable<RepaymentReview['review']>,
) {
  const plan = review.plan;
  if (
    plan.kind !== 'settlement' ||
    plan.plan.loan_id !== estimate.loan_id ||
    plan.plan.leg_id !== estimate.leg_id ||
    plan.plan.input_atomic !== estimate.input_atomic ||
    BigInt(plan.plan.net_output_atomic) < BigInt(estimate.amount_atomic) ||
    BigInt(plan.plan.execution_cost_atomic) >
      BigInt(estimate.execution_cost_atomic) ||
    BigInt(plan.plan.max_source_fee_atomic) >
      BigInt(estimate.max_source_fee_atomic)
  )
    throw new Error('The quote changed. Review your repayment again.');
  return {
    ...estimate,
    net_output_atomic: plan.plan.net_output_atomic,
    execution_cost_atomic: plan.plan.execution_cost_atomic,
    max_source_fee_atomic: plan.plan.max_source_fee_atomic,
    expires_at: Math.min(
      estimate.expires_at,
      plan.plan.expires_at,
      review.expires_at,
    ),
  };
}
