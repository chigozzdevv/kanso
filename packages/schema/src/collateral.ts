import { z } from 'zod';
import { identifier } from '@schema/account';
import { positive_amount } from '@schema/amount';
import { basket_leg } from '@schema/offer';

export const topup = z.strictObject({
  operation_id: identifier,
  loan_id: identifier,
  leg: basket_leg,
  accepted: z.boolean(),
});

export const replacement = z.strictObject({
  operation_id: identifier,
  loan_id: identifier,
  incoming_topup_id: identifier,
  outgoing_leg_id: identifier,
  outgoing_amount_atomic: positive_amount,
  transfer_id: identifier.nullable(),
});

export type TopUp = z.infer<typeof topup>;
export type Replacement = z.infer<typeof replacement>;
