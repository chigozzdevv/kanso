import { createHash } from 'node:crypto';

export function leading_zero_bits(hash: Uint8Array) {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}
export function starknet_proof(prefix: string, difficulty: number) {
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 32)
    throw new Error('Unsupported faucet proof difficulty');
  const deadline = Date.now() + 45_000;
  for (let nonce = 0; Date.now() < deadline; nonce++) {
    if (
      leading_zero_bits(
        createHash('sha256')
          .update(prefix + nonce)
          .digest(),
      ) >= difficulty
    )
      return nonce.toString();
  }
  throw new Error(
    'Faucet proof deadline exceeded before submission; no payout requested',
  );
}
