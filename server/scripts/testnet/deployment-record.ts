import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { deployment } from '@kanso/schema';
import { Release } from '@testnet/deployment';
import { NEAR_RPC, rpc } from '@testnet/network';
import { near_view } from '@testnet/deploy-near';
import { read_json } from '@testnet/store';
import bs58 from 'bs58';
import { NEAR_TESTNET_USDC } from '@kanso/bindings';

export async function deployment_record() {
  const primary = await Release.load();
  const migration = await Release.load('deployment-usdc.json');
  const journals = [primary];
  for (const chain of ['solana', 'sui', 'starknet'])
    journals.push(await Release.load(`deployment-${chain}.json`));
  const contracts = Object.assign(
    {},
    ...journals.map((r) => r.journal.contracts),
  ) as Record<string, Record<string, unknown>>;
  const near = contracts.near;
  if (!near)
    throw new Error(
      'Deploy and verify NEAR before writing the runtime deployment',
    );
  const coordinator = String(near.coordinator);
  const config = await near_view<{
    settlement_token: string;
    settlement_decimals: number;
  }>(coordinator, 'get_config');
  if (
    config.settlement_token !== NEAR_TESTNET_USDC ||
    config.settlement_decimals !== 6
  )
    throw new Error(
      'Migrate public testnet settlement to Circle USDC before publishing deployment metadata',
    );
  near.settlement_token = config.settlement_token;
  near.config = config;
  const pause = await near_view<{ origination: boolean }>(
    coordinator,
    'get_pause_flags',
  );
  const deployed_code = await rpc<{ code_hash: string }>(NEAR_RPC, 'query', {
    request_type: 'view_account',
    account_id: coordinator,
    finality: 'final',
  });
  near.code_sha256 = Buffer.from(bs58.decode(deployed_code.code_hash)).toString(
    'hex',
  );
  const coordinator_keys = await rpc<{ keys: unknown[] }>(NEAR_RPC, 'query', {
    request_type: 'view_access_key_list',
    account_id: coordinator,
    finality: 'final',
  });
  if (coordinator_keys.keys.length)
    throw new Error('Coordinator deployment keys have not been removed');
  near.paused = pause;
  near.upgrade = await near_view(coordinator, 'get_upgrade_status');
  near.verified_at = new Date().toISOString();
  const starknet_key = await read_json<{ address: string }>(
    primary.folder,
    'keys/starknet-deployer.json',
  );
  const folder = join(primary.folder, '..', 'deployments');
  let prior_runtime;
  try {
    prior_runtime = deployment.parse(
      JSON.parse(await readFile(join(folder, 'testnet.json'), 'utf8')),
    );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  if (
    prior_runtime &&
    prior_runtime.deployment_id !== primary.journal.deployment_id
  )
    throw new Error('Refusing to overwrite another deployment');
  const runtime = deployment.parse({
    deployment_id: primary.journal.deployment_id,
    network: 'testnet',
    near: {
      rpc_url: NEAR_RPC,
      coordinator: near.coordinator,
      settlement_token: near.settlement_token,
      settlement_decimals: 6,
      max_mpc_deposit_atomic: '1',
    },
    pool_ids: prior_runtime?.pool_ids ?? (near.pool ? ['usdc'] : []),
    chains: prior_runtime?.chains ?? [],
  });
  near.pool = await near_view(coordinator, 'get_pool', {
    pool_id: runtime.pool_ids[0]!,
  });
  const circle_lifecycle = Object.values(migration.journal.contracts)
    .map((value) => (value as { complete?: unknown }).complete)
    .filter(
      (value) =>
        value &&
        typeof value === 'object' &&
        (value as { settlement_token?: string }).settlement_token ===
          NEAR_TESTNET_USDC,
    )
    .map((value) => {
      const evidence = value as {
        loan_id: string;
        collateral_chains: string[];
        verified_at: string;
      };
      return {
        loan_id: evidence.loan_id,
        collateral_chains: evidence.collateral_chains,
        verified_at: evidence.verified_at,
      };
    });
  const receipts = [...journals, migration].flatMap((r) =>
    Object.entries(r.journal.effects).map(([step, effect]) => ({
      step,
      state: effect.state,
      transaction_id: effect.transaction_id,
    })),
  );
  const record = {
    version: 1,
    deployment_id: runtime.deployment_id,
    network: 'testnet',
    recorded_at: new Date().toISOString(),
    origination_enabled: !pause.origination,
    remote_integrations_enabled:
      !pause.origination &&
      runtime.chains.some(
        (c) =>
          c.evidence &&
          c.manifest.new_locks_enabled &&
          c.manifest.signing_enabled,
      ),
    enabled_chains: pause.origination
      ? []
      : [
          'near',
          ...runtime.chains
            .filter(
              (c) =>
                c.evidence &&
                c.manifest.new_locks_enabled &&
                c.manifest.signing_enabled,
            )
            .map((c) => c.manifest.chain_id),
        ],
    settlement_verification: circle_lifecycle,
    settlement_asset: {
      account: near.settlement_token,
      symbol: 'USDC',
      decimals: 6,
      description: 'Circle-issued USDC on NEAR Testnet',
    },
    contracts,
    transactions: receipts,
    remaining: {
      starknet: contracts.starknet
        ? null
        : {
            status: 'awaiting_additional_test_STRK',
            deployer: starknet_key.address,
            additional_test_STRK: 40,
            reason:
              'Funded account deployed; measured CollateralVault declaration maximum is approximately 17.93 STRK; approximately 4.96 STRK remains. Official faucet returned a 24-hour address cooldown.',
          },
      bitcoin: {
        status: 'no_application_contract',
        custody:
          'Per-loan MPC-derived Testnet3 P2WPKH keys; transaction inclusion, delivery and recovery verified by the configured NEAR Bitcoin light client',
        verifier: primary.journal.contracts.bitcoin_verifier ?? null,
        new_borrowing_enabled: runtime.chains.some(
          (c) =>
            c.manifest.family === 'bitcoin' &&
            c.manifest.new_locks_enabled &&
            c.evidence,
        ),
      },
      integration: runtime.chains
        .filter((c) => !c.evidence || !c.manifest.new_locks_enabled)
        .map((c) => c.manifest.chain_id),
    },
    recovery_trust:
      'Recovery attestors and protocol owner keys are on one development machine',
  };
  await mkdir(folder, { recursive: true });
  for (const [name, value] of [
    ['testnet.json', runtime],
    ['testnet-contracts.json', record],
  ] as const) {
    const path = join(folder, name);
    try {
      const prior = JSON.parse(await readFile(path, 'utf8')) as {
        deployment_id: string;
        chains?: unknown[];
      };
      if (prior.deployment_id !== runtime.deployment_id)
        throw new Error('Refusing to overwrite another deployment');
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    await writeFile(
      path,
      await format(JSON.stringify(value), {
        ...(await resolveConfig(path)),
        parser: 'json',
      }),
      {
        mode: 0o644,
      },
    );
  }
  console.log(
    `Deployment records written to ${folder}; origination ${pause.origination ? 'paused' : 'enabled'}`,
  );
}
