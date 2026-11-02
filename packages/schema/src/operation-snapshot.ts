import { z } from 'zod';
import { identifier, near_account, development_network } from '@schema/account';
import {
  atomic_amount,
  positive_amount,
  revision,
  unix_seconds,
} from '@schema/amount';
import { basket_leg, loan_offer } from '@schema/offer';
import { pool_policy } from '@schema/pool';
import { conditional_terms } from '@schema/conditional-repayment';
import { settlement_plan } from '@schema/settlement';
import { chain_family } from '@schema/chain';
export const hex = z.string().regex(/^0x(?:[a-fA-F0-9]{2})*$/);
export const near_call = z.strictObject({
  method: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  args: z.record(z.string(), z.json()),
  gas: positive_amount,
  deposit: atomic_amount,
});
export const transaction_action = z.discriminatedUnion('family', [
  z.strictObject({
    family: z.literal('near'),
    chain_id: z.literal('near'),
    signer_id: near_account,
    receiver_id: near_account,
    calls: z.array(near_call).min(1).max(8),
  }),
  z.strictObject({
    family: z.literal('evm'),
    chain_id: identifier,
    signer_id: hex,
    to: hex,
    data: hex,
    value: atomic_amount,
  }),
  z.strictObject({
    family: z.literal('solana'),
    chain_id: z.literal('solana'),
    signer_id: z.string(),
    transaction: z.string(),
  }),
  z.strictObject({
    family: z.literal('sui'),
    chain_id: z.literal('sui'),
    signer_id: z.string(),
    transaction: z.string(),
  }),
  z.strictObject({
    family: z.literal('starknet'),
    chain_id: z.literal('starknet'),
    signer_id: z.string(),
    calls: z
      .array(
        z.strictObject({
          contract_address: z.string(),
          entrypoint: z.string(),
          calldata: z.array(z.string()),
        }),
      )
      .min(1)
      .max(4),
  }),
  z.strictObject({
    family: z.literal('bitcoin'),
    chain_id: z.literal('bitcoin'),
    signer_id: z.string(),
    address: z.string(),
    amount_atomic: positive_amount,
    script: hex,
  }),
]);
export const operation_plan = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('setup'),
    offer: loan_offer,
    conditional_repayment: conditional_terms.nullable(),
  }),
  z.strictObject({
    kind: z.literal('pool_create'),
    pool_id: identifier,
    policy: pool_policy,
  }),
  z.strictObject({
    kind: z.literal('pool_policy'),
    pool_id: identifier,
    policy: pool_policy,
  }),
  z.strictObject({
    kind: z.literal('pool_deposit'),
    pool_id: identifier,
    amount_atomic: positive_amount,
  }),
  z.strictObject({
    kind: z.literal('lp_withdrawal'),
    pool_id: identifier,
    shares: positive_amount,
  }),
  z.strictObject({
    kind: z.literal('withdrawal_claim'),
    withdrawal_id: identifier,
  }),
  z.strictObject({
    kind: z.literal('withdrawal_cancel'),
    withdrawal_id: identifier,
  }),
  z.strictObject({
    kind: z.literal('repayment'),
    loan_id: identifier,
    amount_atomic: positive_amount,
  }),
  z.strictObject({
    kind: z.literal('conditional'),
    loan_id: identifier,
    expected_version: z.number().int().nonnegative(),
    terms: conditional_terms,
  }),
  z.strictObject({
    kind: z.literal('topup'),
    loan_id: identifier,
    leg: basket_leg,
  }),
  z.strictObject({
    kind: z.literal('withdraw'),
    loan_id: identifier,
    leg_id: identifier,
    amount_atomic: positive_amount,
    expected_revision: revision,
  }),
  z.strictObject({
    kind: z.literal('replacement'),
    loan_id: identifier,
    incoming: basket_leg,
    outgoing_leg_id: identifier,
    outgoing_amount_atomic: positive_amount,
    expected_revision: revision,
  }),
  z.strictObject({
    kind: z.literal('release'),
    loan_id: identifier,
    leg_id: identifier,
  }),
  z.strictObject({
    kind: z.literal('wallet_payment'),
    loan_id: identifier,
    payment_id: identifier,
    leg: basket_leg,
  }),
  z.strictObject({
    kind: z.literal('payment_refund'),
    loan_id: identifier,
    leg_id: identifier,
  }),
  z.strictObject({
    kind: z.literal('storage_deposit'),
    amount_atomic: positive_amount,
  }),
  z.strictObject({
    kind: z.literal('storage_withdraw'),
    amount_atomic: positive_amount,
  }),
  z.strictObject({
    kind: z.literal('loss_recognition'),
    loan_id: identifier,
    expected_revision: revision,
  }),
  z.strictObject({ kind: z.literal('refund'), refund_id: identifier }),
  z.strictObject({ kind: z.literal('settlement'), plan: settlement_plan }),
  z.strictObject({ kind: z.literal('setup_cancel'), loan_id: identifier }),
]);
export const operation_step = z.strictObject({
  step_id: identifier,
  label: z.string(),
  family: chain_family,
  chain_id: identifier,
  state: z.enum([
    'pending',
    'submitted',
    'unknown',
    'confirmed',
    'failed',
    'cancelled',
  ]),
  action: transaction_action.nullable(),
  transaction_id: z.string().nullable(),
  error: z.string().nullable(),
});
const common = {
  error: z
    .strictObject({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .nullable()
    .default(null),
  cancellation_requested: z.boolean(),
  operation_id: identifier,
  deployment_id: identifier,
  network: development_network,
  owner: near_account,
  revision,
  plan: operation_plan,
  plan_hash: z.string().regex(/^[a-f0-9]{64}$/),
  steps: z.array(operation_step),
  created_at: unix_seconds,
  updated_at: unix_seconds,
  next_poll_after_ms: z.number().int().min(100).max(60000),
};
export const operation_snapshot = z.discriminatedUnion('status', [
  z.strictObject({ ...common, status: z.literal('requires_action') }),
  z.strictObject({ ...common, status: z.literal('running') }),
  z.strictObject({ ...common, status: z.literal('reconciling') }),
  z.strictObject({ ...common, status: z.literal('succeeded') }),
  z.strictObject({ ...common, status: z.literal('failed') }),
  z.strictObject({ ...common, status: z.literal('cancelled') }),
]);
export const operation_checkpoint = z.strictObject({
  version: z.literal(1),
  deployment_id: identifier,
  network: development_network,
  operation_id: identifier,
  owner: near_account,
  plan_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type OperationPlan = z.infer<typeof operation_plan>;
export type OperationSnapshot = z.infer<typeof operation_snapshot>;
export type OperationStep = z.infer<typeof operation_step>;
export type TransactionAction = z.infer<typeof transaction_action>;
export type NearAction = Extract<TransactionAction, { family: 'near' }>;
export type OperationCheckpoint = z.infer<typeof operation_checkpoint>;
