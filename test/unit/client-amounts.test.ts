import { describe, expect, it } from 'vitest';
import { U128_MAX } from '@kanso/schema';
import { parseAmount, formatAmount } from '@client/lib/amounts';

describe('browser token amounts', () => {
  it('preserves exact atomic quantities beyond floating-point precision', () => {
    expect(parseAmount('0.000000000000000000000001', 24)).toBe('1');
    expect(parseAmount('9007199254.740993', 6)).toBe('9007199254740993');
    expect(parseAmount(' 1.25 ', 8)).toBe('125000000');
    expect(parseAmount(U128_MAX.toString(), 0)).toBe(U128_MAX.toString());
  });
  it.each([
    '0',
    '-1',
    '1e3',
    'NaN',
    'Infinity',
    '1,000',
    '01',
    '',
    '1.0000001',
  ])('rejects ambiguous or invalid settlement amounts: %s', (value) => {
    expect(() => parseAmount(value, 6)).toThrow();
  });
  it('rejects an amount exceeding the contract limit', () => {
    expect(() => parseAmount((U128_MAX + 1n).toString(), 0)).toThrow();
  });
  it('formats large balances without converting the atomic quantity to a number', () => {
    expect(formatAmount('9007199254740993', 6, 6)).toBe('9,007,199,254.740993');
    expect(formatAmount('1', 24, 24)).toBe('0.000000000000000000000001');
    expect(formatAmount('10', 0, 0)).toBe('10');
  });
});
