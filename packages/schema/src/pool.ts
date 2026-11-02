import { z } from 'zod';
import { identifier, near_account } from '@schema/account';
import {
  atomic_amount,
  basis_points,
  positive_amount,
  unix_seconds,
  revision,
} from '@schema/amount';

export const pool_policy = z
  .strictObject({
    version: z.number().int().positive().max(0xffffffff),
    apr_bps: basis_points,
    origination_fee_atomic: atomic_amount,
    min_principal_atomic: positive_amount,
    max_principal_atomic: positive_amount,
    max_duration_seconds: unix_seconds.refine((value) => value > 0),
    setup_duration_seconds: unix_seconds.refine((value) => value > 0),
    grace_seconds: unix_seconds,
    interest_buffer_seconds: unix_seconds,
    ltv_bps: basis_points,
    liquidation_threshold_bps: basis_points,
    min_liquidity_atomic: atomic_amount,
    min_conditional_trigger_health_ppm: z
      .number()
      .int()
      .min(1_000_001)
      .max(0xffffffff),
    max_liquidation_surplus_atomic: atomic_amount,
    withdrawal_health_ppm: z.number().int().min(1_000_001).max(0xffffffff),
    recovery_health_ppm: z.number().int().min(1_000_001).max(0xffffffff),
    max_execution_cost_bps: basis_points,
    max_slippage_bps: basis_points,
    max_execution_cost_atomic: atomic_amount,
    eligible_assets: z.array(identifier).min(1).max(11),
    asset_caps: z
      .array(
        z.strictObject({
          asset_id: identifier,
          max_collateral_value_atomic: positive_amount,
        }),
      )
      .min(1)
      .max(11),
    max_outstanding_principal_atomic: positive_amount,
  })
  .refine(
    (value) =>
      value.ltv_bps > 0 &&
      value.ltv_bps < value.liquidation_threshold_bps &&
      value.liquidation_threshold_bps < 10_000,
    'Risk thresholds must satisfy 0 < LTV < liquidation threshold < 10000',
  )
  .refine(
    (value) =>
      positive_amount.safeParse(value.min_principal_atomic).success &&
      positive_amount.safeParse(value.max_principal_atomic).success &&
      BigInt(value.min_principal_atomic) <= BigInt(value.max_principal_atomic),
    'Minimum principal exceeds maximum',
  );

export type PoolPolicy = z.infer<typeof pool_policy>;

export const pool_record = z.strictObject({
  pool_id: identifier,
  manager: near_account,
  policy: pool_policy,
  cash_atomic: atomic_amount,
  reserved_atomic: atomic_amount,
  in_flight_atomic: atomic_amount,
  total_shares: atomic_amount,
  pending_withdrawal: z.boolean(),
  recognized_loss_atomic: atomic_amount,
  loan_ids: z.array(identifier).max(32),
  revision,
});

export const lp_position = z.strictObject({
  shares: atomic_amount,
  reserved_shares: atomic_amount,
});

export const pool_withdrawal = z.strictObject({
  withdrawal_id: identifier,
  pool_id: identifier,
  owner: near_account,
  shares: positive_amount,
  state: z.enum(['requested', 'pending', 'paid', 'cancelled']),
});

export type Pool = z.infer<typeof pool_record>;
export type LpPosition = z.infer<typeof lp_position>;
export type PoolWithdrawal = z.infer<typeof pool_withdrawal>;
