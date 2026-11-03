import { expect, it } from 'vitest';
import { proof_hash } from '@testnet/sui-proof';
import { leading_zero_bits } from '@testnet/starknet-proof';

it('matches the official Sui faucet Argon2d conformance vector', () => {
  const preimage = [
    'sui-faucet-pow/1',
    '8wWZfv1HjQxjB5ncmC9CQqqRqUMBiEZXnc5FhS9zRe1v',
    '1713342',
    'GzBdc9tbUe3s2PK1iVJcyQBj5TvdX7bJiAHWbhBDYiYb',
    'mJ4ZqDXQasy17GTiGfp0/OYAGCR+7reLM5+Gb39YtoAIaPuh1wj+z5J7po+eSze3',
    '0x949cd75a2485cc18b8258634ffd9b849a687e2e2a0b4c2444a21f007fc79adc4',
    '0x1111111111111111111111111111111111111111111111111111111111111111',
    '0',
  ].join('\n');
  expect(proof_hash(preimage).toString('hex')).toBe(
    '31f6ec0e9169705f6105219eebbbc77420f1d9273d407db5df17b4d090afb92d',
  );
});
it('checks non-nibble-aligned Starknet faucet difficulty', () => {
  expect(leading_zero_bits(Uint8Array.of(0, 0, 0x20, 0xff))).toBe(18);
  expect(leading_zero_bits(Uint8Array.of(0x80))).toBe(0);
  expect(leading_zero_bits(new Uint8Array(32))).toBe(256);
});
