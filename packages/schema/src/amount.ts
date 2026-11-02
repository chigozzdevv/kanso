import { z } from 'zod';

export const U128_MAX = (1n << 128n) - 1n;
export const U64_MAX = (1n << 64n) - 1n;
export const atomic_amount = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(39)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]*)$/.test(value) &&
      value.length <= 39 &&
      BigInt(value) <= U128_MAX,
    'Amount exceeds u128',
  );
export const positive_amount = atomic_amount.refine(
  (value) => value !== '0',
  'Amount must be positive',
);
export const revision = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(20)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]*)$/.test(value) &&
      value.length <= 20 &&
      BigInt(value) <= U64_MAX,
    'Revision exceeds u64',
  );
export const unix_seconds = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const basis_points = z.number().int().min(0).max(10_000);

export function mul_div_floor(
  a: bigint,
  b: bigint,
  denominator: bigint,
): bigint {
  if (a < 0n || b < 0n || denominator <= 0n) {
    throw new RangeError(
      'Expected unsigned operands and a positive denominator',
    );
  }
  return (a * b) / denominator;
}

export function mul_div_ceil(
  a: bigint,
  b: bigint,
  denominator: bigint,
): bigint {
  const floor = mul_div_floor(a, b, denominator);
  return floor + ((a * b) % denominator === 0n ? 0n : 1n);
}
