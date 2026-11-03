import { describe, expect, it } from 'vitest';
import { loan_record, conditional_authorization } from '@kanso/schema';
import {
  bounded_input,
  valid_repair,
} from '@server/features/liquidation/liquidation.service';
import fixture from '@test/fixtures/coordinator-wire.json';

describe('keeper bounds', () => {
  it('finds the largest affordable integer input without losing precision', () => {
    const max = 2n ** 120n,
      budget = 2n ** 100n;
    expect(bounded_input(max, (n) => n * 7n <= budget)).toBe(budget / 7n);
    expect(bounded_input(100n, () => false)).toBe(0n);
    expect(bounded_input(100n, () => true)).toBe(100n);
  });
  it('requires an improvement within the cumulative authorization target or full repayment', () => {
    const l = loan_record.parse(fixture.loan),
      a = conditional_authorization.parse(fixture.authorization);
    a.terms.target_health_ppm = 2200000;
    expect(valid_repair(l, a, false, false, 1500000n, 1500000n)).toBe(false);
    expect(valid_repair(l, a, false, false, 1500000n, 1800000n)).toBe(true);
    expect(valid_repair(l, a, false, false, 1500000n, 2300000n)).toBe(false);
    expect(valid_repair(l, a, false, false, 1500000n, null)).toBe(true);
    expect(valid_repair(l, null, true, false, 900000n, 1000000n)).toBe(false);
    expect(valid_repair(l, null, true, true, 900000n, 1000000n)).toBe(true);
  });
});
