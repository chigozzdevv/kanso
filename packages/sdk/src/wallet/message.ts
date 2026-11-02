import type { AuthChallenge } from '@kanso/schema';
import { digest, from_hex } from '@sdk/transport/codec';
function text(value: string) {
  const b = new TextEncoder().encode(value);
  const n = new Uint8Array(4);
  new DataView(n.buffer).setUint32(0, b.length, true);
  return concat(n, b);
}
function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
export function nep413_message(c: AuthChallenge) {
  const tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint32(0, 2 ** 31 + 413, true);
  return digest(
    concat(
      tag,
      text(c.message),
      from_hex(c.nonce),
      text(c.domain),
      Uint8Array.of(0),
    ),
  );
}
export function starknet_auth_message(message: string) {
  return {
    types: {
      StarknetDomain: [
        { name: 'name', type: 'shortstring' },
        { name: 'version', type: 'shortstring' },
        { name: 'chainId', type: 'shortstring' },
        { name: 'revision', type: 'shortstring' },
      ],
      KansoOwnership: [{ name: 'challenge', type: 'string' }],
    },
    primaryType: 'KansoOwnership',
    domain: {
      name: 'Kanso',
      version: '1',
      chainId: '0x534e5f5345504f4c4941',
      revision: '1',
    },
    // Printable JSON preserves every UTF-8 character without relying on wallet string encoders handling control characters.
    message: {
      challenge: JSON.stringify(message).replace(
        /[\u007f-\uffff]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      ),
    },
  };
}
