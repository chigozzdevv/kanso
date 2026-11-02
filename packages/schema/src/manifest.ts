import { z } from 'zod';
import { identifier, near_account } from '@schema/account';
import {
  atomic_amount,
  basis_points,
  positive_amount,
  unix_seconds,
} from '@schema/amount';
import { bytes, hash32, version } from '@schema/bytes';

export const chain_manifest = z.strictObject({
  chain_id: identifier,
  version,
  family: z.enum(['evm', 'solana', 'sui', 'starknet', 'bitcoin']),
  network_fingerprint: z.string().min(1),
  vault: bytes,
  controller: bytes,
  controller_public_key: bytes,
  asset_id: identifier,
  asset_address: bytes,
  decimals: z.number().int().min(0).max(38),
  max_collateral_atomic: positive_amount,
  ltv_bps: basis_points,
  liquidation_threshold_bps: basis_points,
  mpc_account: near_account,
  read_domain: unix_seconds,
  read_public_key: bytes.length(64),
  sign_domain: unix_seconds,
  derivation_path: z.string().min(1),
  minimum_confirmations: unix_seconds,
  initial_account_nonce: unix_seconds,
  max_gas: unix_seconds,
  max_fee_per_gas: atomic_amount,
  max_network_cost_atomic: atomic_amount,
  capability_evidence_hash: hash32,
  new_locks_enabled: z.boolean(),
  signing_enabled: z.boolean(),
});

export type ChainManifest = z.infer<typeof chain_manifest>;
