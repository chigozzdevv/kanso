import { mul_div_ceil, positive_amount } from '@kanso/schema';
import type { Offer } from '@kanso/schema';

export function estimate_offer_costs(offer: Offer) {
  const interest = mul_div_ceil(
    BigInt(offer.principal_atomic) * BigInt(offer.apr_bps),
    BigInt(offer.duration_seconds),
    10_000n * 31_536_000n,
  );
  return {
    interest_atomic: interest.toString(),
    total_repayment_atomic: positive_amount.parse(
      (
        BigInt(offer.principal_atomic) +
        BigInt(offer.origination_fee_atomic) +
        interest
      ).toString(),
    ),
  };
}
