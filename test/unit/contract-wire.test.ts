import { describe, expect, it } from 'vitest';
import {
  chain_manifest,
  mpc_signature,
  k256_signature,
  conditional_authorization,
  conditional_terms,
  loan_record,
  replacement,
  risk_snapshot,
  settlement,
  topup,
} from '@kanso/schema';
import fixture from '@test/fixtures/coordinator-wire.json';

describe('coordinator wire types', () => {
  it('parses actual Rust contract records without losing fields', () => {
    expect(chain_manifest.parse(fixture.manifest)).toEqual(fixture.manifest);
    expect(loan_record.parse(fixture.loan)).toEqual(fixture.loan);
    expect(conditional_authorization.parse(fixture.authorization)).toEqual(
      fixture.authorization,
    );
    expect(settlement.parse(fixture.settlement)).toEqual(fixture.settlement);
    expect(topup.parse(fixture.topup)).toEqual(fixture.topup);
    expect(replacement.parse(fixture.replacement)).toEqual(fixture.replacement);
    expect(risk_snapshot.parse(fixture.risk)).toEqual(fixture.risk);
  });

  it('matches the pinned MPC signature JSON emitted by Rust', () => {
    expect(k256_signature.parse(fixture.k256_signature)).toEqual(
      fixture.k256_signature,
    );
    expect(mpc_signature.parse(fixture.mpc_signature)).toEqual(
      fixture.mpc_signature,
    );
    expect(mpc_signature.parse(fixture.ed25519_signature)).toEqual(
      fixture.ed25519_signature,
    );
    expect(
      mpc_signature.safeParse({ Secp256k1: fixture.k256_signature }).success,
    ).toBe(false);
    expect(
      k256_signature.safeParse({
        ...fixture.k256_signature,
        big_r: { affine_point: [2, ...new Array(32).fill(1)] },
      }).success,
    ).toBe(false);
  });

  it('keeps consumed budgets outside caller-controlled authorization terms', () => {
    expect(
      conditional_terms.safeParse({
        ...fixture.authorization.terms,
        consumed_repayment_atomic: '0',
      }).success,
    ).toBe(false);
    const terms = {
      ...fixture.authorization.terms,
      max_collateral_spend: [
        { asset_id: 'near', max_total_atomic: '100', consumed_atomic: '0' },
      ],
    };
    expect(conditional_terms.safeParse(terms).success).toBe(false);
  });

  it('rejects malformed manifest keys and imprecise settlement amounts', () => {
    expect(
      chain_manifest.safeParse({ ...fixture.manifest, read_public_key: [1] })
        .success,
    ).toBe(false);
    expect(
      settlement.safeParse({ ...fixture.settlement, escrow_atomic: 1e20 })
        .success,
    ).toBe(false);
  });
});
