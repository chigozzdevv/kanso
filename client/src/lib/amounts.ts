import { positive_amount } from '@kanso/schema';

export function parseAmount(value: string, decimals: number): string {
  const input = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d*)?$/.test(input))
    throw new Error('Enter a valid amount.');
  const [whole = '0', fraction = ''] = input.split('.');
  if (fraction.length > decimals)
    throw new Error(`Use no more than ${decimals} decimal places.`);
  const atomic = (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0') || '0')
  ).toString();
  if (!positive_amount.safeParse(atomic).success)
    throw new Error(
      'Enter an amount greater than zero within the supported limit.',
    );
  return atomic;
}

export function formatAmount(
  value: string,
  decimals = 6,
  precision = 2,
): string {
  const atomic = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const whole = (atomic / scale).toLocaleString('en-US');
  const fraction = (atomic % scale)
    .toString()
    .padStart(decimals, '0')
    .slice(0, precision);
  return precision && decimals
    ? `${whole}.${fraction.padEnd(Math.min(decimals, precision), '0')}`
    : whole;
}

export function shortAddress(value: string): string {
  return value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

export function inputAmount(value: string, decimals = 6): string {
  const scale = 10n ** BigInt(decimals);
  const atomic = BigInt(value);
  const fraction = (atomic % scale)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '');
  return `${atomic / scale}${fraction ? `.${fraction}` : ''}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Something went wrong. Please try again.';
}
