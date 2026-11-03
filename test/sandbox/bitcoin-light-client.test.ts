import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bitcoin_proof, from_hex } from '@kanso/sdk';
import { create_sandbox, policy, signed } from '@test/sandbox/context';
import type { Sandbox } from '@test/sandbox/context';
import fixture from '@test/fixtures/coordinator-wire.json';
import { bitcoin_block as block } from '@test/fixtures/bitcoin-block';

describe('Bitcoin verification callbacks on actual WASM', () => {
  let s: Sandbox;
  beforeAll(async () => {
    s = await create_sandbox();
  });
  afterAll(async () => {
    await s?.node.tearDown();
  });
  it('blocks unconfigured custody and private callback forgery, and preserves balances after a failed verifier receipt', async () => {
    const genesis =
      '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';
    const controller = Array.from(
      from_hex(
        '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      ),
    );
    await s.root.call(
      s.coordinator,
      'register_chain_manifest',
      {
        manifest: {
          ...fixture.manifest,
          chain_id: 'bitcoin',
          family: 'bitcoin',
          network_fingerprint: genesis,
          asset_id: 'btc',
          decimals: 8,
          controller,
          controller_public_key: controller,
          vault: [],
          max_collateral_atomic: '1000000000',
          minimum_confirmations: 1,
        },
      },
      signed,
    );
    await s.create_pool('bitcoin');
    await s.lp.call(
      s.coordinator,
      'update_pool_policy',
      {
        pool_id: 'bitcoin',
        policy: {
          ...policy,
          version: 2,
          eligible_assets: ['near', 'btc'],
          asset_caps: [
            ...policy.asset_caps,
            { asset_id: 'btc', max_collateral_value_atomic: '1000000000000' },
          ],
        },
      },
      signed,
    );
    await s.root.call(s.coordinator, 'publish_asset_price', {
      asset_id: 'btc',
      price: {
        price_atomic: '100000000000',
        confidence_bps: 0,
        published_at: await s.now(),
        sequence: 1,
      },
    });
    const script = Array.from(
      from_hex('00141e924674ae5cb059d606f4c294088bc71a999938'),
    );
    const offer = await s.offer('bitcoin_loan', 'bitcoin', {
      policy_version: 2,
      principal_atomic: '1000000',
      legs: [
        {
          leg_id: 'bitcoin',
          asset_id: 'btc',
          owner: s.borrower.accountId,
          amount_atomic: '37241',
          release_recipient: s.borrower.accountId,
          custody: {
            family: 'remote',
            chain_id: 'bitcoin',
            manifest_version: 1,
            lock_id: Array(32).fill(1),
            source_owner: script,
            release_recipient: script,
            min_price_atomic: '90000000000',
            max_price_atomic: '110000000000',
          },
        },
      ],
    });
    await expect(
      s.borrower.call(s.coordinator, 'accept_offer', { offer }, signed),
    ).rejects.toThrow('BITCOIN_VERIFIER_NOT_CONFIGURED');
    const verifier = {
      account_id: s.token.accountId,
      network_fingerprint: genesis,
      max_tip_age_seconds: 7200,
    };
    await expect(
      s.borrower.call(
        s.coordinator,
        'register_bitcoin_verifier',
        { manifest_version: 1, verifier },
        signed,
      ),
    ).rejects.toThrow('OWNER_REQUIRED');
    await s.root.call(
      s.coordinator,
      'register_bitcoin_verifier',
      { manifest_version: 1, verifier },
      signed,
    );
    await expect(
      s.root.call(
        s.coordinator,
        'register_bitcoin_verifier',
        {
          manifest_version: 1,
          verifier: { ...verifier, account_id: s.root.accountId },
        },
        signed,
      ),
    ).rejects.toThrow('BITCOIN_VERIFIER_IMMUTABLE');
    await s.borrower.call(s.coordinator, 'accept_offer', { offer }, signed);
    const before = await s.loan(offer.offer_id);
    await expect(
      s.borrower.call(s.coordinator, 'complete_bitcoin_verification', {
        action: {
          Lock: { loan_id: offer.offer_id, leg_id: 'bitcoin', vout: 0 },
        },
        raw_transaction: Array.from(from_hex(block.hex)),
        payer: s.borrower.accountId,
      }),
    ).rejects.toThrow('private');
    const observation = bitcoin_proof(
      block.hex,
      block.hash,
      block.tx,
      block.merkleroot,
    );
    await expect(
      s.borrower.call(
        s.coordinator,
        'submit_bitcoin_lock',
        { loan_id: offer.offer_id, leg_id: 'bitcoin', vout: 0, ...observation },
        signed,
      ),
    ).rejects.toThrow('BITCOIN_INCLUSION_FAILED');
    expect(await s.loan(offer.offer_id)).toEqual(before);
    await s.borrower.call(
      s.coordinator,
      'abort_setup',
      { loan_id: offer.offer_id },
      signed,
    );
    expect((await s.loan(offer.offer_id)).state).toBe('cancelled');
  });
});
