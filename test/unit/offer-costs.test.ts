import { describe, expect, it } from 'vitest';
import { loan_offer, U128_MAX } from '@kanso/schema';
import { estimate_offer_costs } from '@kanso/sdk';
import fixture from '@test/fixtures/coordinator-wire.json';

describe('full-term borrowing cost estimates', () => {
  const offer = loan_offer.parse(fixture.loan.offer);
  it('includes principal, simple Actual/365 interest and the origination fee', () => {
    expect(
      estimate_offer_costs({
        ...offer,
        principal_atomic: '100000000',
        apr_bps: 1000,
        duration_seconds: 31_536_000,
        origination_fee_atomic: '1000000',
      }),
    ).toEqual({
      interest_atomic: '10000000',
      total_repayment_atomic: '111000000',
    });
  });
  it('rounds a fractional obligation up to the smallest settlement unit', () => {
    expect(
      estimate_offer_costs({
        ...offer,
        principal_atomic: '1',
        apr_bps: 1,
        duration_seconds: 1,
        origination_fee_atomic: '0',
      }),
    ).toEqual({ interest_atomic: '1', total_repayment_atomic: '2' });
  });
  it('preserves a zero-rate loan without adding interest', () => {
    expect(
      estimate_offer_costs({
        ...offer,
        principal_atomic: '1000000',
        apr_bps: 0,
        origination_fee_atomic: '0',
      }).total_repayment_atomic,
    ).toBe('1000000');
  });
  it('rejects a repayment obligation exceeding the contract amount limit', () => {
    expect(() =>
      estimate_offer_costs({
        ...offer,
        principal_atomic: U128_MAX.toString(),
        apr_bps: 10_000,
        duration_seconds: 31_536_000,
      }),
    ).toThrow();
  });
});
