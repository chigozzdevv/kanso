import { KansoError } from '@kanso/schema';

export function repayment_input(
  target: bigint,
  maximum: bigint,
  output: (input: bigint) => bigint,
): bigint {
  if (target <= 0n || maximum <= 0n || output(maximum) < target)
    throw new KansoError(
      'INSUFFICIENT_BALANCE',
      'This asset cannot cover the repayment amount',
    );
  let low = 1n;
  let high = maximum;
  while (low < high) {
    const mid = low + (high - low) / 2n;
    if (output(mid) >= target) high = mid;
    else low = mid + 1n;
  }
  return low;
}
