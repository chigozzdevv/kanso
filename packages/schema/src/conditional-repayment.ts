import { z } from 'zod';
import { identifier } from '@schema/account';
import { atomic_amount, basis_points, unix_seconds } from '@schema/amount';
import { version } from '@schema/bytes';

export const conditional_terms = z.strictObject({
  enabled: z.boolean(),
  trigger_health_ppm: z.number().int().min(0).max(0xffff_ffff),
  target_health_ppm: z.number().int().min(0).max(0xffff_ffff),
  max_total_repayment_atomic: atomic_amount,
  max_collateral_spend: z
    .array(
      z.strictObject({
        asset_id: identifier,
        max_total_atomic: atomic_amount,
      }),
    )
    .min(1)
    .max(16),
  max_execution_cost_bps: basis_points,
  max_execution_cost_atomic: atomic_amount,
  expires_at: unix_seconds.nullable(),
});

export const conditional_authorization = z.strictObject({
  version,
  initial_terms: conditional_terms,
  terms: conditional_terms,
  spend: z
    .array(
      z.strictObject({
        asset_id: identifier,
        consumed_atomic: atomic_amount,
        reserved_atomic: atomic_amount,
      }),
    )
    .max(16),
  consumed_repayment_atomic: atomic_amount,
  reserved_repayment_atomic: atomic_amount,
  consumed_cost_atomic: atomic_amount,
  reserved_cost_atomic: atomic_amount,
});

export type ConditionalTerms = z.infer<typeof conditional_terms>;
export type ConditionalAuthorization = z.infer<
  typeof conditional_authorization
>;
