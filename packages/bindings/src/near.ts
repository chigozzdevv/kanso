import { remote_operation, bitcoin_spend } from '@kanso/schema';
import { bitcoin_verifier, bitcoin_recovery } from '@kanso/schema';
import { z } from 'zod';
import {
  atomic_amount,
  development_network,
  identifier,
  near_account,
  unix_seconds,
  loan_record,
  loan_summary,
  pool_record,
  lp_position,
  pool_withdrawal,
  transfer,
  price,
  chain_manifest,
  conditional_authorization,
  settlement,
  refund,
  topup,
  replacement,
  risk_snapshot,
} from '@kanso/schema';
import { coordinator_methods } from '@bindings/generated';
export const coordinator_config = z.strictObject({
  deployment_id: identifier,
  network: development_network,
  owner: near_account,
  oracle_account: near_account,
  settlement_token: near_account,
  settlement_decimals: z.number().int().min(0).max(24),
  max_price_age_seconds: unix_seconds,
  max_confidence_bps: z.number().int(),
  max_ltv_bps: z.number().int(),
  max_liquidation_threshold_bps: z.number().int(),
  operational_reserve_atomic: atomic_amount,
});
export const coordinator_views = {
  get_pool_count: z.number().int().nonnegative(),
  get_upgrade_status: z.strictObject({
    staged_bytes: z.number().int().min(0).max(4_000_000),
    state_version: z.number().int().positive(),
    minimum_delay_seconds: unix_seconds,
    governance: z.strictObject({
      pending_owner: near_account.nullable(),
      pending_upgrade: z
        .strictObject({
          code_hash: z.array(z.number().int().min(0).max(255)).length(32),
          execute_after: unix_seconds,
          from_state_version: z.number().int().positive(),
        })
        .nullable(),
      last_upgrade_hash: z
        .array(z.number().int().min(0).max(255))
        .length(32)
        .nullable(),
      revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
  }),
  get_pending_pool_manager: near_account.nullable(),
  get_remote_operation: remote_operation.nullable(),
  get_bitcoin_spend: bitcoin_spend.nullable(),
  get_bitcoin_verifier: bitcoin_verifier.nullable(),
  get_bitcoin_recovery: bitcoin_recovery.nullable(),
  get_payment: z
    .strictObject({
      intent: z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('pool_deposit'),
          pool_id: identifier,
          operation_id: identifier,
        }),
        z.strictObject({
          kind: z.literal('repayment'),
          loan_id: identifier,
          operation_id: identifier,
        }),
        z.strictObject({
          kind: z.literal('solver_escrow'),
          operation_id: identifier,
        }),
      ]),
      amount_atomic: atomic_amount,
      used_atomic: atomic_amount,
    })
    .nullable(),
  get_config: coordinator_config,
  get_loan: loan_record,
  loan_summary,
  get_pool: pool_record,
  pool_nav: atomic_amount,
  pool_available_cash: atomic_amount,
  get_position: lp_position,
  get_withdrawal: pool_withdrawal.nullable(),
  get_transfer: transfer.nullable(),
  get_price: price.nullable(),
  get_asset_price: price.nullable(),
  get_chain_manifest: chain_manifest,
  get_conditional_repayment: conditional_authorization.nullable(),
  get_settlement: settlement.nullable(),
  get_refund: refund.nullable(),
  get_topup: topup.nullable(),
  get_replacement: replacement.nullable(),
  basket_risk: risk_snapshot,
  storage_balance: atomic_amount,
  debt_state: z.enum([
    'pending_funding',
    'active',
    'due',
    'defaulted',
    'repaid',
    'cancelled',
    'written_off',
  ]),
  wallet_payment_leg_id: z.string(),
  bitcoin_deposit_script: z.array(z.number().int().min(0).max(255)),
  settlement_liabilities: z.tuple([atomic_amount, atomic_amount]),
  get_pause_flags: z.strictObject({
    origination: z.boolean(),
    collateral_withdrawals: z.boolean(),
    settlements: z.boolean(),
  }),
};
export type ViewMethod = keyof typeof coordinator_views;
export type ViewResult<M extends ViewMethod> = z.infer<
  (typeof coordinator_views)[M]
>;
export function assert_public_change(method: string): void {
  const entry = coordinator_methods[method as keyof typeof coordinator_methods];
  if (
    !entry ||
    entry.private ||
    method === 'new' ||
    method in coordinator_views
  )
    throw new Error(`Not a public coordinator mutation: ${method}`);
}
