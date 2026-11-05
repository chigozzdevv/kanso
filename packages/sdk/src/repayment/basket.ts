import { KansoError } from '@kanso/schema';
import type { BasketRepaymentQuote, SettlementPlan } from '@kanso/schema';

export function assert_basket_settlement(
  quote: BasketRepaymentQuote,
  index: number,
  plan: SettlementPlan,
  minimum: bigint,
) {
  const limit = quote.allocations[index];
  if (
    !limit ||
    plan.kind !== 'repayment' ||
    plan.loan_id !== quote.loan_id ||
    plan.leg_id !== limit.leg_id ||
    BigInt(plan.input_atomic) > BigInt(limit.input_atomic) ||
    BigInt(plan.net_output_atomic) < minimum ||
    BigInt(plan.execution_cost_atomic) > BigInt(limit.execution_cost_atomic) ||
    BigInt(plan.max_source_fee_atomic) > BigInt(limit.max_source_fee_atomic)
  )
    throw new KansoError(
      'INVALID_INPUT',
      'Collateral sale exceeds the reviewed repayment limits',
    );
}
