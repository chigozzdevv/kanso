import { z } from 'zod';
import { atomic_amount, revision, unix_seconds } from '@schema/amount';
import { identifier } from '@schema/account';
import { basket_leg, loan_offer } from '@schema/offer';
import { pool_policy } from '@schema/pool';

export const loan_record = z.strictObject({
  loan_id: identifier,
  offer_hash: z.array(z.number().int().min(0).max(255)).length(32),
  offer: loan_offer,
  policy: pool_policy,
  state: z.enum([
    'pending_funding',
    'active',
    'repaid',
    'cancelled',
    'written_off',
  ]),
  setup_state: z.enum([
    'reserved',
    'locking',
    'ready',
    'funding',
    'funded',
    'aborting',
    'aborted',
  ]),
  locks: z
    .array(
      z.strictObject({
        leg: basket_leg,
        purpose: z.discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('collateral') }),
          z.strictObject({
            kind: z.literal('payment'),
            payment_id: identifier,
            payer: z.string(),
          }),
        ]),
        agreement: z.array(z.number().int().min(0).max(255)).length(32),
        locked_atomic: atomic_amount,
        reserved_atomic: atomic_amount,
        accepted: z.boolean(),
        receipt_verified: z.boolean(),
        remote_nonce: unix_seconds,
      }),
    )
    .min(1)
    .max(16),
  principal_outstanding_atomic: atomic_amount,
  interest_atomic: atomic_amount,
  interest_remainder: z.number().int().nonnegative().max(315_359_999_999),
  fees_due_atomic: atomic_amount,
  started_at: unix_seconds,
  last_accrued_at: unix_seconds,
  matures_at: unix_seconds,
  active_outflow: identifier.nullable(),
  recovery_outflows: z.array(identifier).max(15),
  written_off_atomic: atomic_amount,
  revision,
});

export type Loan = z.infer<typeof loan_record>;

export const loan_summary = z.strictObject({
  loan_id: identifier,
  debt_state: z.enum([
    'pending_funding',
    'active',
    'due',
    'defaulted',
    'repaid',
    'cancelled',
    'written_off',
  ]),
  debt_atomic: atomic_amount,
  principal_atomic: atomic_amount,
  interest_atomic: atomic_amount,
  fees_atomic: atomic_amount,
  borrowing_capacity_atomic: atomic_amount.nullable(),
  liquidation_value_atomic: atomic_amount.nullable(),
  secured_recovery_atomic: atomic_amount,
  health_ppm: atomic_amount.nullable(),
  price_status: z.enum(['valid', 'stale', 'missing']),
  started_at: unix_seconds.nullable(),
  matures_at: unix_seconds.nullable(),
  custody_resolved: z.boolean(),
  revision,
});

export type LoanSummary = z.infer<typeof loan_summary>;

export const risk_snapshot = z.strictObject({
  debt_atomic: atomic_amount,
  borrowing_capacity_atomic: atomic_amount,
  liquidation_value_atomic: atomic_amount,
  secured_recovery_atomic: atomic_amount,
  health_ppm: atomic_amount,
  defaulted: z.boolean(),
  revision,
});

export type RiskSnapshot = z.infer<typeof risk_snapshot>;
