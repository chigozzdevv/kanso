import { z } from 'zod';
import { identifier, near_account } from '@schema/account';
import { positive_amount, unix_seconds } from '@schema/amount';
import { basket_leg, loan_offer } from '@schema/offer';
import { conditional_terms } from '@schema/conditional-repayment';
export const borrowing_request = z.strictObject({
  basket: z.array(basket_leg).min(1).max(16),
  loan_terms: z.strictObject({
    principal_atomic: positive_amount,
    duration_seconds: unix_seconds.refine((x) => x > 0),
    payout_account: near_account,
  }),
  conditional_repayment: conditional_terms.nullable(),
});
export const request_record = z.strictObject({
  request_id: identifier,
  owner: near_account,
  input: borrowing_request,
  created_at: unix_seconds,
});
export const offer_response = z.strictObject({
  offers: z.array(loan_offer),
  rejections: z.array(
    z.strictObject({ pool_id: identifier, reason: z.string() }),
  ),
});
export type BorrowingRequest = z.infer<typeof borrowing_request>;
export type RequestRecord = z.infer<typeof request_record>;
