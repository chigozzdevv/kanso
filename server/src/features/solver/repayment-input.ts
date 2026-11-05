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

export function repayment_sources(
  sources: { minimum: bigint; maximum: bigint; fee: bigint }[],
  target: bigint,
): number[] {
  let best: number[] | null = null;
  let bestFee: bigint | null = null;
  const search = (
    index: number,
    selected: number[],
    minimum: bigint,
    maximum: bigint,
    fee: bigint,
  ) => {
    if (minimum > target || (bestFee !== null && fee > bestFee)) return;
    if (maximum >= target) {
      if (
        bestFee === null ||
        fee < bestFee ||
        (fee === bestFee && selected.length < best!.length)
      ) {
        best = selected;
        bestFee = fee;
      }
      return;
    }
    if (
      index === sources.length ||
      (bestFee === fee && selected.length >= best!.length)
    )
      return;
    const source = sources[index]!;
    if (source.minimum > 0n && source.maximum >= source.minimum)
      search(
        index + 1,
        [...selected, index],
        minimum + source.minimum,
        maximum + source.maximum,
        fee + source.fee,
      );
    search(index + 1, selected, minimum, maximum, fee);
  };
  if (sources.length > 16 || target <= 0n)
    throw new KansoError('INVALID_INPUT', 'Invalid collateral basket');
  search(0, [], 0n, 0n, 0n);
  if (!best)
    throw new KansoError(
      'INSUFFICIENT_BALANCE',
      'Your collateral basket cannot cover this repayment within its fee limits',
    );
  return best;
}
