import { Transaction } from 'bitcoinjs-lib';
import { sha256 } from '@noble/hashes/sha256';
import { bitcoin_inclusion_proof } from '@kanso/schema';
import type { BitcoinInclusionProof } from '@kanso/schema';
import { from_hex, to_hex } from '@sdk/transport/codec';

const internal_hash = (value: string) => {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid Bitcoin hash');
  return from_hex(value).reverse();
};
const double_hash = (bytes: Uint8Array) => sha256(sha256(bytes));
function merkle_path(txids: string[], index: number) {
  let level = txids.map(internal_hash);
  const path: string[] = [];
  while (level.length > 1) {
    if (level.length % 2) level.push(level[level.length - 1]!);
    path.push(to_hex(level[index ^ 1]!.slice().reverse()));
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(double_hash(Uint8Array.from([...level[i]!, ...level[i + 1]!])));
    level = next;
    index = Math.floor(index / 2);
  }
  return { path, root: to_hex(level[0]!.slice().reverse()) };
}
export function bitcoin_proof(
  raw_transaction: string,
  block_hash: string,
  txids: string[],
  merkle_root: string,
) {
  if (
    !/^(?:[a-f0-9]{2})+$/.test(raw_transaction) ||
    raw_transaction.length > 200_000
  )
    throw new Error('Invalid Bitcoin transaction bytes');
  const bytes = from_hex(raw_transaction);
  const tx = Transaction.fromBuffer(bytes);
  if (tx.isCoinbase()) throw new Error('Coinbase collateral is unsupported');
  if (
    txids.length < 2 ||
    txids.length > 1_000_000 ||
    new Set(txids).size !== txids.length
  )
    throw new Error('Invalid Bitcoin block transaction list');
  const index = txids.indexOf(tx.getId());
  if (index <= 0)
    throw new Error('Transaction is absent from the Bitcoin block');
  const branch = merkle_path(txids, index);
  if (branch.root !== merkle_root)
    throw new Error('Bitcoin Merkle root mismatch');
  const proof = bitcoin_inclusion_proof.parse({
    tx_id: tx.getId(),
    tx_block_blockhash: block_hash,
    tx_index: index,
    merkle_proof: branch.path,
    coinbase_tx_id: txids[0],
    coinbase_merkle_proof: merkle_path(txids, 0).path,
  });
  return { proof, raw_transaction: Array.from(bytes) };
}
export function bitcoin_proof_args(
  proof: BitcoinInclusionProof,
  confirmations: number,
): Uint8Array {
  const p = bitcoin_inclusion_proof.parse(proof);
  if (!Number.isSafeInteger(confirmations) || confirmations <= 0)
    throw new Error('Positive Bitcoin confirmations required');
  const u64 = (value: number) => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    return Array.from(bytes);
  };
  const path = (hashes: string[]) => {
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, hashes.length, true);
    return [...count, ...hashes.flatMap((h) => Array.from(internal_hash(h)))];
  };
  return Uint8Array.from([
    ...internal_hash(p.tx_id),
    ...internal_hash(p.tx_block_blockhash),
    ...u64(p.tx_index),
    ...path(p.merkle_proof),
    ...internal_hash(p.coinbase_tx_id),
    ...path(p.coinbase_merkle_proof),
    ...u64(confirmations),
  ]);
}
