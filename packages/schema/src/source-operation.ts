import { z } from 'zod';
import { identifier, near_account } from '@schema/account';
import { atomic_amount, unix_seconds } from '@schema/amount';
import { bytes, hash32 } from '@schema/bytes';
import { chain_manifest } from '@schema/manifest';
const signature_fields = {
  big_r: z.strictObject({ affine_point: z.string().regex(/^[a-f0-9]{66}$/i) }),
  s: z.strictObject({ scalar: z.string().regex(/^[a-f0-9]{64}$/i) }),
  recovery_id: z.number().int().min(0).max(3),
};
export const k256_signature = z.strictObject(signature_fields);
export const mpc_signature = z.discriminatedUnion('scheme', [
  z.strictObject({ scheme: z.literal('Secp256k1'), ...signature_fields }),
  z.strictObject({ scheme: z.literal('Ed25519'), signature: bytes.length(64) }),
]);
export const source_state = z.enum([
  'prepared',
  'signing',
  'signed',
  'delivered',
  'invalidated',
  'cancelled',
]);
export const source_command = z.strictObject({
  operation_id: hash32,
  lock_id: hash32,
  agreement: hash32,
  settlement_id: hash32,
  recipient: bytes,
  amount_atomic: atomic_amount,
  nonce: unix_seconds,
  deadline: unix_seconds,
  kind: z.number().int().min(0).max(2),
});
export const remote_operation = z.strictObject({
  operation_id: identifier,
  settlement_id: identifier.nullable(),
  loan_id: identifier,
  leg_id: identifier,
  owner: near_account,
  manifest: chain_manifest,
  command: source_command,
  state: source_state,
  signing_attempts: z
    .array(
      z.strictObject({
        attempt_id: identifier,
        transaction: bytes,
        payload: bytes,
        ed25519: z.boolean(),
        signature: mpc_signature.nullable(),
        invalidation: z.boolean(),
        account_nonce: unix_seconds.nullable(),
        source_deadline: unix_seconds,
      }),
    )
    .max(8),
  network_cost_reserved_atomic: atomic_amount,
  revision: unix_seconds,
});
export const bitcoin_utxo = z.strictObject({
  txid: hash32,
  vout: z.number().int().nonnegative(),
  amount: unix_seconds,
  script: bytes,
  spent: z.boolean(),
  reserved_by: identifier.nullable(),
});
export const bitcoin_spend = z.strictObject({
  operation_id: identifier,
  settlement_id: identifier.nullable(),
  recovery_id: identifier.nullable(),
  loan_id: identifier,
  leg_id: identifier,
  owner: near_account,
  manifest: chain_manifest,
  input: bitcoin_utxo,
  recipient_script: bytes,
  amount_atomic: atomic_amount,
  max_fee_atomic: atomic_amount,
  expires_at: unix_seconds,
  state: source_state,
  attempts: z
    .array(
      z.strictObject({
        attempt_id: identifier,
        fee_atomic: atomic_amount,
        cancellation: z.boolean(),
        raw_unsigned: bytes,
        digest: hash32,
        signature: mpc_signature.nullable(),
      }),
    )
    .max(8),
});
export type RemoteOperation = z.infer<typeof remote_operation>;
export type BitcoinSpend = z.infer<typeof bitcoin_spend>;
export const bitcoin_recovery = z.strictObject({
  recovery_id: identifier,
  loan_id: identifier,
  leg_id: identifier,
  owner: near_account,
  manifest: chain_manifest,
  input: bitcoin_utxo,
  refund_script: bytes,
  completed: z.boolean(),
});
export type BitcoinRecovery = z.infer<typeof bitcoin_recovery>;
