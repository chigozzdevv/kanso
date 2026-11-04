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
