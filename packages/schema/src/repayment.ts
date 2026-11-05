import { z } from 'zod';
import { identifier } from '@schema/account';
import { atomic_amount, positive_amount, unix_seconds } from '@schema/amount';

export const repayment_estimate_input = z.union([
  z.strictObject({
    mode: z.enum(['collateral', 'wallet']),
    leg_id: identifier,
    amount_atomic: positive_amount,
  }),
  z.strictObject({
    mode: z.literal('wallet'),
    asset_id: identifier,
    amount_atomic: positive_amount,
  }),
]);

export const repayment_estimate = z.strictObject({
  mode: z.enum(['collateral', 'wallet']),
  loan_id: identifier,
  leg_id: identifier.nullable(),
  asset_id: identifier,
  chain_id: identifier,
  decimals: z.number().int().min(0).max(38),
  amount_atomic: positive_amount,
  input_atomic: positive_amount,
  net_output_atomic: positive_amount,
  execution_cost_atomic: atomic_amount,
  max_source_fee_atomic: atomic_amount,
  expires_at: unix_seconds,
});

export type RepaymentEstimateInput = z.infer<typeof repayment_estimate_input>;
export type RepaymentEstimate = z.infer<typeof repayment_estimate>;

export const basket_repayment_quote = z
  .strictObject({
    loan_id: identifier,
    amount_atomic: positive_amount,
    basket_value_atomic: atomic_amount,
    execution_cost_atomic: atomic_amount,
    net_output_atomic: positive_amount,
    expires_at: unix_seconds,
    sources: z
      .array(
        z.strictObject({
          leg_id: identifier,
          asset_id: identifier,
          chain_id: identifier,
          decimals: z.number().int().min(0).max(38),
          available_atomic: atomic_amount,
          value_atomic: atomic_amount,
        }),
      )
      .min(1)
      .max(16),
    allocations: z
      .array(
        repayment_estimate.extend({
          mode: z.literal('collateral'),
          leg_id: identifier,
        }),
      )
      .min(1)
      .max(16),
  })
  .superRefine((quote, context) => {
    const sources = new Map(
      quote.sources.map((source) => [source.leg_id, source]),
    );
    const ids = quote.allocations.map((allocation) => allocation.leg_id);
    const total = (
      key: 'amount_atomic' | 'execution_cost_atomic' | 'net_output_atomic',
    ) =>
      quote.allocations.reduce(
        (sum, allocation) => sum + BigInt(allocation[key]),
        0n,
      );
    if (
      sources.size !== quote.sources.length ||
      new Set(ids).size !== ids.length ||
      total('amount_atomic') !== BigInt(quote.amount_atomic) ||
      total('execution_cost_atomic') !== BigInt(quote.execution_cost_atomic) ||
      total('net_output_atomic') !== BigInt(quote.net_output_atomic) ||
      total('net_output_atomic') < BigInt(quote.amount_atomic) ||
      quote.allocations.some((allocation) => {
        const source = sources.get(allocation.leg_id);
        return (
          !source ||
          allocation.loan_id !== quote.loan_id ||
          allocation.asset_id !== source.asset_id ||
          allocation.chain_id !== source.chain_id ||
          allocation.decimals !== source.decimals ||
          BigInt(allocation.input_atomic) > BigInt(source.available_atomic)
        );
      })
    )
      context.addIssue({
        code: 'custom',
        message:
          'Basket repayment allocations do not match the reviewed limits',
      });
  });
export type BasketRepaymentQuote = z.infer<typeof basket_repayment_quote>;
