import { KeyPair, transactions } from 'near-api-js';
import { NEAR_TESTNET_USDC } from '@kanso/bindings';
import { near_signer, near_send, near_view, call } from '@testnet/deploy-near';
import { rpc, NEAR_RPC } from '@testnet/network';
import { read_json } from '@testnet/store';
import type { Release } from '@testnet/deployment';

const NEAR = 10n ** 24n;
export async function configure_near(release: Release) {
  const owner = await near_signer(release, 'owner'),
    coordinator = await near_signer(release, 'coordinator'),
    manager = await near_signer(release, 'manager');
  const config = await near_view<{
    owner: string;
    settlement_token: string;
    deployment_id: string;
  }>(coordinator.accountId, 'get_config');
  if (
    config.owner !== owner.accountId ||
    config.settlement_token !== NEAR_TESTNET_USDC ||
    config.deployment_id !== release.journal.deployment_id
  )
    throw new Error('NEAR deployment configuration mismatch');
  const policy = {
    version: 1,
    apr_bps: 1000,
    origination_fee_atomic: '0',
    min_principal_atomic: '1000000',
    max_principal_atomic: '1000000000',
    max_duration_seconds: 2_592_000,
    setup_duration_seconds: 3600,
    grace_seconds: 60,
    interest_buffer_seconds: 86_400,
    ltv_bps: 5000,
    liquidation_threshold_bps: 7000,
    min_liquidity_atomic: '0',
    withdrawal_health_ppm: 1_200_000,
    min_conditional_trigger_health_ppm: 1_100_000,
    max_liquidation_surplus_atomic: '1000000',
    recovery_health_ppm: 1_300_000,
    max_execution_cost_bps: 500,
    max_slippage_bps: 500,
    max_execution_cost_atomic: '10000000',
    eligible_assets: ['near'],
    asset_caps: [
      { asset_id: 'near', max_collateral_value_atomic: '1000000000000' },
    ],
    max_outstanding_principal_atomic: '10000000000',
  };
  await near_send(
    release,
    'near-manager-storage',
    manager,
    coordinator.accountId,
    [call('storage_deposit', {}, NEAR / 4n)],
  );
  await near_send(release, 'near-pool-create', manager, coordinator.accountId, [
    call('create_pool', { pool_id: 'usdc', policy }),
  ]);
  for (const role of ['lp', 'borrower', 'solver']) {
    const account = await near_signer(release, role);
    await near_send(
      release,
      `near-${role}-storage`,
      account,
      coordinator.accountId,
      [call('storage_deposit', {}, NEAR / 4n)],
    );
  }
  {
    const role = 'coordinator',
      account = coordinator;
    const key = await read_json<{ private_key: `ed25519:${string}` }>(
      release.key_folder,
      `near-${role}.json`,
    );
    const public_key = KeyPair.fromString(key.private_key).getPublicKey();
    const keys = await rpc<{ keys: { public_key: string }[] }>(
      NEAR_RPC,
      'query',
      {
        request_type: 'view_access_key_list',
        account_id: account.accountId,
        finality: 'final',
      },
    );
    if (keys.keys.some((k) => k.public_key !== public_key.toString()))
      throw new Error(`Unexpected NEAR access key on ${role}`);
    if (
      keys.keys.length === 0 &&
      !release.journal.effects[`near-remove-${role}-key`]
    )
      throw new Error(`Unrecorded access key removal on ${role}`);
    await near_send(
      release,
      `near-remove-${role}-key`,
      account,
      account.accountId,
      [transactions.deleteKey(public_key)],
    );
    const after = await rpc<{ keys: unknown[] }>(NEAR_RPC, 'query', {
      request_type: 'view_access_key_list',
      account_id: account.accountId,
      finality: 'final',
    });
    if (after.keys.length !== 0)
      throw new Error(`NEAR access keys remain on ${role}`);
  }
  const near = release.journal.contracts.near as Record<string, unknown>;
  near.pool = await near_view(coordinator.accountId, 'get_pool', {
    pool_id: 'usdc',
  });
  near.account_keys_removed = true;
  near.coordinator_upgrades =
    'owner-controlled, minimum one-minute testnet contract timelock';
  near.recovery_trust = '2 of 3 keys on one development machine';
  near.verified_at = new Date().toISOString();
  await release.save();
  console.log(
    'NEAR: USDC pool configured; direct deployment key removed; coordinator timelock enforced',
  );
}
