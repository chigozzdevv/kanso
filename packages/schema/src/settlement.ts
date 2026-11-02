import { z } from 'zod';
import { identifier, near_account } from '@schema/account';
import {
  atomic_amount,
  positive_amount,
  revision,
  unix_seconds,
} from '@schema/amount';
import { bytes } from '@schema/bytes';

export const settlement_plan = z.strictObject({
  operation_id: identifier,
  loan_id: identifier,
  expected_revision: revision,
  leg_id: identifier,
  input_atomic: positive_amount,
  net_output_atomic: positive_amount,
  execution_cost_atomic: atomic_amount,
  max_source_fee_atomic: atomic_amount,
  solver: near_account,
  source_recipient: near_account,
  remote_recipient: bytes,
  expires_at: unix_seconds,
  kind: z.enum(['repayment', 'conditional', 'liquidation']),
  conditional_version: z.number().int().min(0).max(0xffff_ffff),
});

export const settlement = z.strictObject({
  plan: settlement_plan,
  state: z.enum([
    'quoted',
    'funded',
    'committed',
    'delivered',
    'applied',
    'cancelled',
  ]),
  escrow_atomic: atomic_amount,
  applied_atomic: atomic_amount,
  refund_id: identifier.nullable(),
  source_spent_atomic: atomic_amount,
  actual_cost_atomic: atomic_amount,
  reserved_source_fee_value_atomic: atomic_amount,
  transfer_id: identifier.nullable(),
  revision: unix_seconds,
});

export const refund = z.strictObject({
  refund_id: identifier,
  owner: near_account,
  amount_atomic: positive_amount,
  transfer_id: identifier.nullable(),
  paid: z.boolean(),
});

export type SettlementPlan = z.infer<typeof settlement_plan>;
export type Settlement = z.infer<typeof settlement>;
export type Refund = z.infer<typeof refund>;
