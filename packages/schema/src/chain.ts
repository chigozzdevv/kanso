import { z } from 'zod';
import { identifier, near_account, development_network } from '@schema/account';
import { atomic_amount, unix_seconds } from '@schema/amount';
import { chain_manifest } from '@schema/manifest';
export const chain_family = z.enum([
  'near',
  'evm',
  'solana',
  'sui',
  'starknet',
  'bitcoin',
]);
export const chain_configuration = z.strictObject({
  manifest: chain_manifest,
  rpc_url: z.url(),
  evidence: z
    .strictObject({
      verified_at: unix_seconds,
      record_url: z.url(),
      deposit_transaction: z.string().min(1),
      release_transaction: z.string().min(1),
    })
    .nullable(),
});
export const deployment = z
  .strictObject({
    deployment_id: identifier,
    network: development_network,
    near: z.strictObject({
      rpc_url: z.url(),
      coordinator: near_account,
      settlement_token: near_account,
      settlement_decimals: z.number().int().min(0).max(24),
      max_mpc_deposit_atomic: atomic_amount.default('1'),
    }),
    pool_ids: z.array(identifier),
    chains: z.array(chain_configuration),
  })
  .superRefine((d, c) => {
    const ids = d.chains.map((x) => x.manifest.chain_id);
    if (new Set(ids).size !== ids.length)
      c.addIssue({ code: 'custom', message: 'Duplicate chain configuration' });
  });
export const asset = z.strictObject({
  asset_id: identifier,
  chain_id: identifier,
  family: chain_family,
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(38),
  network_fingerprint: z.string(),
  token_address: z.string().nullable(),
  enabled: z.boolean(),
  reason: z.string().nullable(),
});
export const price = z.strictObject({
  price_atomic: atomic_amount,
  confidence_bps: z.number().int().min(0).max(10000),
  published_at: unix_seconds,
  sequence: unix_seconds,
});
export type Deployment = z.infer<typeof deployment>;
export type ChainConfiguration = z.infer<typeof chain_configuration>;
export type ChainFamily = z.infer<typeof chain_family>;
export type Asset = z.infer<typeof asset>;
