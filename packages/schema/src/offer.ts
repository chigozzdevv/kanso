import { z } from 'zod';
import { development_network, identifier, near_account } from '@schema/account';
import {
  atomic_amount,
  basis_points,
  positive_amount,
  unix_seconds,
} from '@schema/amount';

const bytes = z.array(z.number().int().min(0).max(255));
export const custody = z.discriminatedUnion('family', [
  z.strictObject({ family: z.literal('near') }),
  z.strictObject({
    family: z.literal('remote'),
    chain_id: identifier,
    manifest_version: z.number().int().positive().max(0xffffffff),
    lock_id: bytes.length(32),
    source_owner: bytes.min(20).max(33),
    release_recipient: bytes.min(20).max(32),
    min_price_atomic: positive_amount,
    max_price_atomic: positive_amount,
  }),
]);
export const basket_leg = z.strictObject({
  asset_id: identifier,
  custody,
  leg_id: identifier,
  owner: near_account,
  amount_atomic: positive_amount,
  release_recipient: near_account,
});

export const loan_offer = z
  .strictObject({
    deployment_id: identifier,
    network: development_network,
    offer_id: identifier,
    pool_id: identifier,
    borrower: near_account,
    payout_account: near_account,
    policy_version: z.number().int().positive().max(0xffffffff),
    principal_atomic: positive_amount,
    apr_bps: basis_points,
    duration_seconds: unix_seconds.refine((value) => value > 0),
    origination_fee_atomic: atomic_amount,
    expires_at: unix_seconds,
    setup_deadline: unix_seconds,
    min_price_atomic: positive_amount,
    max_price_atomic: positive_amount,
    legs: z.array(basket_leg).min(1).max(16),
  })
  .refine(
    (value) =>
      new Set(value.legs.map((leg) => leg.leg_id)).size === value.legs.length,
    'Duplicate collateral leg',
  )
  .refine(
    (value) => value.legs.every((leg) => leg.owner === value.borrower),
    'Collateral source must authorize the offer as borrower',
  )
  .refine(
    (value) => value.expires_at <= value.setup_deadline,
    'Invalid setup deadline',
  )
  .refine(
    (value) =>
      positive_amount.safeParse(value.min_price_atomic).success &&
      positive_amount.safeParse(value.max_price_atomic).success &&
      BigInt(value.min_price_atomic) <= BigInt(value.max_price_atomic),
    'Invalid price bounds',
  );

export type Offer = z.infer<typeof loan_offer>;

export type BasketLeg = z.infer<typeof basket_leg>;
