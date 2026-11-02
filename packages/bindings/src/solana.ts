import { solana_layouts } from '@bindings/generated';
export type SolanaLayout = keyof typeof solana_layouts;
export function encode_solana_record(
  layout: SolanaLayout,
  values: Record<string, Uint8Array | bigint | number>,
): Uint8Array {
  const chunks = solana_layouts[layout].map((field) => {
    const value = values[field.name];
    if (field.type === '[u8; 8]' || field.type === '[u8; 32]') {
      const size = field.type === '[u8; 8]' ? 8 : 32;
      if (!(value instanceof Uint8Array) || value.length !== size)
        throw new Error(`Invalid ${field.name}`);
      return value;
    }
    const size = field.type === 'u64' ? 8 : field.type === 'u8' ? 1 : 0;
    if (!size || (typeof value !== 'bigint' && typeof value !== 'number'))
      throw new Error(`Unsupported ${field.name}`);
    let n = BigInt(value);
    if (n < 0n || n >= 1n << BigInt(8 * size))
      throw new Error(`Overflow ${field.name}`);
    return Uint8Array.from({ length: size }, () => {
      const b = Number(n & 255n);
      n >>= 8n;
      return b;
    });
  });
  const output = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const c of chunks) {
    output.set(c, offset);
    offset += c.length;
  }
  return output;
}
