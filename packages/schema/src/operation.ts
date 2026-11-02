import { z } from 'zod';
import { identifier, near_account } from '@schema/account';
import { positive_amount, unix_seconds } from '@schema/amount';

export const transfer = z.strictObject({
  transfer_id: identifier,
  kind: z.enum([
    'disbursement',
    'collateral_release',
    'lp_withdrawal',
    'storage_withdrawal',
    'settlement_delivery',
    'refund',
  ]),
  owner: near_account,
  object_id: z.union([identifier, z.literal('')]),
  leg_id: z.union([identifier, z.literal('')]),
  recipient: near_account,
  amount_atomic: positive_amount,
  outcome: z.enum(['unknown', 'succeeded', 'failed']),
  finalized: z.boolean(),
  committed_at: unix_seconds,
  observed_at: unix_seconds,
});

export type Transfer = z.infer<typeof transfer>;
