import { workspace_root } from '@testnet/store';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { deployment } from '@kanso/schema';
import { Release } from '@testnet/deployment';
import { NEAR_RPC, rpc } from '@testnet/network';
import { near_view } from '@testnet/deploy-near';
import { NEAR_TESTNET_USDC } from '@kanso/bindings';

export async function deployment_config() {
  const primary = await Release.load();
  const near = primary.journal.contracts.near as
    | {
        coordinator: string;
        pool?: unknown;
      }
    | undefined;
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
      'Official Circle USDC is required before publishing the runtime deployment',
    );
  const pause = await near_view<{ origination: boolean }>(
    coordinator,
    'get_pause_flags',
  );
  const coordinator_keys = await rpc<{ keys: unknown[] }>(NEAR_RPC, 'query', {
    request_type: 'view_access_key_list',
    account_id: coordinator,
    finality: 'final',
  });
  if (coordinator_keys.keys.length)
    throw new Error('Coordinator deployment keys have not been removed');
  const folder = join(workspace_root, 'deployments');
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
      settlement_token: config.settlement_token,
      settlement_decimals: 6,
      max_mpc_deposit_atomic: '1',
    },
    pool_ids: prior_runtime?.pool_ids ?? (near.pool ? ['usdc'] : []),
    chains: prior_runtime?.chains ?? [],
  });
  await mkdir(folder, { recursive: true });
  const path = join(folder, 'testnet.json');
  await writeFile(
    path,
    await format(JSON.stringify(runtime), {
      ...(await resolveConfig(path)),
      parser: 'json',
    }),
    { mode: 0o644 },
  );
  console.log(
    `Runtime deployment written to ${path}; origination ${pause.origination ? 'paused' : 'enabled'}`,
  );
}
