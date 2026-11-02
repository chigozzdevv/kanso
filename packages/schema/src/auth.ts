import { z } from 'zod';
import { chain_family } from '@schema/chain';
import { identifier } from '@schema/account';
import { unix_seconds } from '@schema/amount';
export const auth_challenge = z.strictObject({
  challenge_id: identifier,
  deployment_id: identifier,
  domain: z.string(),
  purpose: z.enum(['login', 'link_wallet']),
  family: chain_family,
  chain_id: identifier,
  address: z.string().min(1).max(256),
  message: z.string(),
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
  expires_at: unix_seconds,
});
export const ownership_proof = z.strictObject({
  challenge_id: identifier,
  signature: z.string().min(1).max(4096),
  public_key: z.string().max(256).optional(),
});
export const session = z.strictObject({
  token: z.string(),
  expires_at: unix_seconds,
  account_id: z.string(),
});
export type AuthChallenge = z.infer<typeof auth_challenge>;
export type OwnershipProof = z.infer<typeof ownership_proof>;
