import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  atomic_amount,
  encode_offer,
  mul_div_ceil,
  mul_div_floor,
  loan_offer,
  U128_MAX,
} from '@kanso/schema';
import fixture from '@test/fixtures/offer-v2.json';

describe('atomic amounts', () => {
  it.each(['-1', '1.0', '01', '1e6', '', 'hello', (U128_MAX + 1n).toString()])(
    'rejects %s without throwing outside schema validation',
    (value) => {
      expect(atomic_amount.safeParse(value).success).toBe(false);
    },
  );

  it('preserves the entire unsigned integer range', () => {
    expect(atomic_amount.parse(U128_MAX.toString())).toBe(U128_MAX.toString());
    expect(atomic_amount.parse('0')).toBe('0');
    expect(atomic_amount.safeParse(100).success).toBe(false);
  });

  it('rounds capacities down and obligations up without floating point', () => {
    expect(mul_div_floor(U128_MAX, U128_MAX, U128_MAX)).toBe(U128_MAX);
    expect(mul_div_floor(10n, 10n, 3n)).toBe(33n);
    expect(mul_div_ceil(10n, 10n, 3n)).toBe(34n);
    expect(() => mul_div_floor(1n, 1n, 0n)).toThrow(RangeError);
  });
});

describe('offer commitments', () => {
  it('returns a validation error for malformed price bounds', () => {
    expect(
      loan_offer.safeParse({ ...fixture.offer, min_price_atomic: 'invalid' })
        .success,
    ).toBe(false);
  });
  it('matches the Rust fixture byte for byte', () => {
    const bytes = encode_offer(loan_offer.parse(fixture.offer));
    expect(Buffer.from(bytes).toString('hex')).toBe(fixture.encoded_hex);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      fixture.sha256,
    );
  });

  it('is independent of JSON key order', () => {
    const reordered = Object.fromEntries(
      Object.entries(fixture.offer).reverse(),
    );
    expect(encode_offer(loan_offer.parse(reordered))).toEqual(
      encode_offer(loan_offer.parse(fixture.offer)),
    );
  });

  it('binds network, recipient and exact amounts', () => {
    const original = loan_offer.parse(fixture.offer);
    const commitment = encode_offer(original);
    expect(encode_offer({ ...original, network: 'testnet' })).not.toEqual(
      commitment,
    );
    expect(
      encode_offer({ ...original, payout_account: 'other.near' }),
    ).not.toEqual(commitment);
    expect(
      encode_offer({ ...original, principal_atomic: '100000001' }),
    ).not.toEqual(commitment);
  });

  it('rejects duplicate legs and unknown authorization fields', () => {
    expect(
      loan_offer.safeParse({
        ...fixture.offer,
        legs: [...fixture.offer.legs, ...fixture.offer.legs],
      }).success,
    ).toBe(false);
    expect(
      loan_offer.safeParse({ ...fixture.offer, arbitrary_call: 'spend' })
        .success,
    ).toBe(false);
  });
});
