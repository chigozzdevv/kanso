import { sha256 } from '@noble/hashes/sha256';
export function to_hex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
export function from_hex(hex: string): Uint8Array {
  const value = hex.replace(/^0x/, '');
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(value))
    throw new Error('Invalid hex encoding');
  return Uint8Array.from(value.match(/../g) ?? [], (v) =>
    Number.parseInt(v, 16),
  );
}
export function digest(value: Uint8Array | string): Uint8Array {
  return sha256(
    typeof value === 'string' ? new TextEncoder().encode(value) : value,
  );
}
export function canonical_json(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return '[' + value.map(canonical_json).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical_json(v))
      .join(',') +
    '}'
  );
}
export function plan_hash(value: unknown): string {
  return to_hex(digest(canonical_json(value)));
}
export function scoped_id(...parts: string[]): string {
  return plan_hash(parts);
}
export function base64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
export function unbase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
