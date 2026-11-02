import { z } from 'zod';
import { near_account } from '@schema/account';
const bitcoin_hash = z.string().regex(/^[a-f0-9]{64}$/);
export const bitcoin_verifier = z.strictObject({
  account_id: near_account,
  network_fingerprint: bitcoin_hash,
  max_tip_age_seconds: z.number().int().min(1200).max(86400),
});
export const bitcoin_inclusion_proof = z
  .strictObject({
    tx_id: bitcoin_hash,
    tx_block_blockhash: bitcoin_hash,
    tx_index: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    merkle_proof: z.array(bitcoin_hash).min(1).max(32),
    coinbase_tx_id: bitcoin_hash,
    coinbase_merkle_proof: z.array(bitcoin_hash).min(1).max(32),
  })
  .superRefine((proof, ctx) => {
    if (
      proof.merkle_proof.length !== proof.coinbase_merkle_proof.length ||
      proof.tx_index >= 2 ** proof.merkle_proof.length
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid Bitcoin proof depth' });
  });
export type BitcoinVerifier = z.infer<typeof bitcoin_verifier>;
export type BitcoinInclusionProof = z.infer<typeof bitcoin_inclusion_proof>;
