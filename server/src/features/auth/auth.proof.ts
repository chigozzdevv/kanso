import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { verifyMessage } from 'viem';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import {
  Transaction,
  payments,
  script,
  address,
  networks,
} from 'bitcoinjs-lib';
import { typedData, hash } from 'starknet';
import { KansoError } from '@kanso/schema';
import type { AuthChallenge, OwnershipProof, Deployment } from '@kanso/schema';
import {
  JsonRpc,
  digest,
  to_hex,
  unbase64,
  nep413_message,
  starknet_auth_message,
} from '@kanso/sdk';
function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
export function verify_bitcoin(
  c: AuthChallenge,
  proof: OwnershipProof,
): boolean {
  if (proof.signature.startsWith('ful')) return false;
  const witness = unbase64(
    proof.signature.startsWith('smp')
      ? proof.signature.slice(3)
      : proof.signature,
  );
  if (witness[0] !== 2) return false;
  let at = 1;
  const length = witness[at++]!;
  const signature = witness.slice(at, at + length);
  at += length;
  const pubLength = witness[at++]!;
  const key = witness.slice(at, at + pubLength);
  if (
    at + pubLength !== witness.length ||
    pubLength !== 33 ||
    signature.at(-1) !== 1
  )
    return false;
  const p = payments.p2wpkh({ pubkey: key });
  if (
    !p.output ||
    to_hex(p.output) !==
      to_hex(address.toOutputScript(c.address, networks.testnet))
  )
    return false;
  const tag = digest('BIP0322-signed-message'),
    message = digest(concat(tag, tag, new TextEncoder().encode(c.message)));
  const spend = new Transaction();
  spend.version = 0;
  spend.addInput(
    new Uint8Array(32),
    0xffffffff,
    0,
    script.compile([0, message]),
  );
  spend.addOutput(p.output, 0n);
  const sign = new Transaction();
  sign.version = 0;
  sign.addInput(spend.getHash(), 0, 0);
  sign.addOutput(script.compile([106]), 0n);
  const code = payments.p2pkh({ pubkey: key }).output!;
  const messageHash = sign.hashForWitnessV0(
    0,
    code,
    0n,
    Transaction.SIGHASH_ALL,
  );
  return secp256k1.verify(
    secp256k1.Signature.fromDER(signature.slice(0, -1)).toCompactRawBytes(),
    messageHash,
    key,
  );
}
export async function verify_ownership(
  d: Deployment,
  c: AuthChallenge,
  p: OwnershipProof,
): Promise<boolean> {
  try {
    switch (c.family) {
      case 'near': {
        if (!p.public_key?.startsWith('ed25519:')) return false;
        const key = bs58.decode(p.public_key.slice(8));
        const signature = bs58.decode(p.signature.replace(/^ed25519:/, ''));
        if (!ed25519.verify(signature, nep413_message(c), key)) return false;
        const keys = await new JsonRpc(d.near.rpc_url).call<{
          keys: { public_key: string; access_key: { permission: unknown } }[];
        }>('query', {
          request_type: 'view_access_key_list',
          finality: 'final',
          account_id: c.address,
        });
        return keys.keys.some(
          (k) =>
            k.public_key === p.public_key &&
            k.access_key.permission === 'FullAccess',
        );
      }
      case 'evm':
        return verifyMessage({
          address: c.address as `0x${string}`,
          message: c.message,
          signature: p.signature as `0x${string}`,
        });
      case 'solana':
        return ed25519.verify(
          bs58.decode(p.signature),
          new TextEncoder().encode(c.message),
          bs58.decode(c.address),
        );
      case 'sui': {
        const key = await verifyPersonalMessageSignature(
          new TextEncoder().encode(c.message),
          p.signature,
        );
        return key.toSuiAddress().toLowerCase() === c.address.toLowerCase();
      }
      case 'bitcoin':
        return verify_bitcoin(c, p);
      case 'starknet': {
        const chain = d.chains.find((x) => x.manifest.chain_id === c.chain_id);
        if (!chain) return false;
        const signature: unknown = JSON.parse(p.signature);
        if (
          !Array.isArray(signature) ||
          signature.length > 128 ||
          !signature.every(
            (x) => typeof x === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(x),
          )
        )
          return false;
        const h = typedData.getMessageHash(
          starknet_auth_message(c.message),
          c.address,
        );
        const result = await new JsonRpc(chain.rpc_url).call<string[]>(
          'starknet_call',
          {
            request: {
              contract_address: c.address,
              entry_point_selector:
                hash.getSelectorFromName('is_valid_signature'),
              calldata: [h, String(signature.length), ...signature].map(
                (felt) => `0x${BigInt(felt).toString(16)}`,
              ),
            },
            block_id: 'latest',
          },
        );
        return result.length === 1 && BigInt(result[0]!) === 0x56414c4944n;
      }
    }
  } catch (error) {
    if (error instanceof KansoError && error.code === 'RPC_UNAVAILABLE')
      throw error;
    return false;
  }
}

export { nep413_message, starknet_auth_message } from '@kanso/sdk';
