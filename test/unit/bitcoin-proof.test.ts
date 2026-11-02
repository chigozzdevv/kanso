import { describe, expect, it } from 'vitest';
import { bitcoin_proof, bitcoin_proof_args, to_hex } from '@kanso/sdk';
import { bitcoin_inclusion_proof } from '@kanso/schema';
import { bitcoin_block as block } from '@test/fixtures/bitcoin-block';

describe('Bitcoin light-client proof encoding', () => {
  const observation = () =>
    bitcoin_proof(block.hex, block.hash, block.tx, block.merkleroot);
  it('builds transaction and coinbase paths for a real odd-width Testnet3 block', () => {
    const { proof, raw_transaction } = observation();
    expect(proof.tx_id).toBe(block.tx[2]);
    expect(proof.tx_index).toBe(2);
    expect(proof.merkle_proof).toEqual([
      block.tx[3],
      '7db24db52d9b9aca906648b46fc9edb8239d1e315277845be5782192ba280f48',
      '7458343e6fc5a784ab88613a3b1ff1783fa0a663ce0a5064a8812145ba4b7d87',
    ]);
    expect(proof.coinbase_merkle_proof).toEqual([
      block.tx[1],
      '10aa637285ee5e320f4b51be5f0b0bbf79aa07111fd549fa924cff33bbca544b',
      proof.merkle_proof[2],
    ]);
    expect(to_hex(raw_transaction)).toBe(block.hex);
  });
  it('encodes the v0.5.3 Borsh interface with internal little-endian hashes', () => {
    const { proof } = observation();
    const bytes = bitcoin_proof_args(proof, 3);
    expect(bytes.length).toBe(312);
    expect(to_hex(bytes.slice(0, 32).reverse())).toBe(proof.tx_id);
    expect(to_hex(bytes.slice(32, 64).reverse())).toBe(block.hash);
    expect(new DataView(bytes.buffer).getBigUint64(64, true)).toBe(2n);
    expect(new DataView(bytes.buffer).getUint32(72, true)).toBe(3);
    expect(
      new DataView(bytes.buffer).getBigUint64(bytes.length - 8, true),
    ).toBe(3n);
  });
  it('rejects a changed block, missing transaction, duplicate leaves and mismatched proof depths', () => {
    expect(() =>
      bitcoin_proof(block.hex, block.hash, block.tx, '00'.repeat(32)),
    ).toThrow('Merkle root');
    expect(() =>
      bitcoin_proof(
        block.hex,
        block.hash,
        block.tx.slice(0, 2),
        block.merkleroot,
      ),
    ).toThrow('absent');
    expect(() =>
      bitcoin_proof(
        block.hex,
        block.hash,
        [...block.tx, block.tx[0]!],
        block.merkleroot,
      ),
    ).toThrow('transaction list');
    expect(() =>
      bitcoin_inclusion_proof.parse({
        ...observation().proof,
        coinbase_merkle_proof: [],
      }),
    ).toThrow();
    expect(() => bitcoin_proof_args(observation().proof, 0)).toThrow(
      'confirmations',
    );
  });
});
