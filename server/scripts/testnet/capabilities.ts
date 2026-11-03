import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { chain_manifest, deployment } from '@kanso/schema';
import type {
  ChainConfiguration,
  Deployment,
  Loan,
  PoolPolicy,
  Pool,
  LoanSummary,
} from '@kanso/schema';
import type { Release } from '@testnet/deployment';
import { confirmed_effect_id, digest } from '@testnet/deployment';
import { canonical_json, scoped_id } from '@kanso/sdk';
import { NEAR_TESTNET_USDC } from '@kanso/bindings';
import { near_send, near_signer, near_view, call } from '@testnet/deploy-near';
import { read_json } from '@testnet/store';
import { refresh_prices } from '@testnet/oracle';
import { Queues } from '@server/shared/queue/queue.client';

const value_of = <T>(effect: { result?: unknown }): T => {
  const result = effect.result as { status: { SuccessValue: string } };
  return JSON.parse(
    Buffer.from(result.status.SuccessValue, 'base64').toString(),
  ) as T;
};

async function json_file(path: string, value: unknown) {
  await writeFile(
    path,
    await format(JSON.stringify(value), {
      ...(await resolveConfig(path)),
      parser: 'json',
    }),
  );
}
export async function prepare_capabilities(release: Release) {
  const primary = await read_json<Release['journal']>(
    release.folder,
    'deployment-verification.json',
  );
  const security = await read_json<Release['journal']>(
    release.folder,
    'deployment-security.json',
  );
  const basket = await read_json<Release['journal']>(
    release.folder,
    'deployment-basket.json',
  );
  const wallets = await read_json<Release['journal']>(
    release.folder,
    'deployment-wallets.json',
  );
  const authentication = wallets.contracts.authentication as
    | {
        connections: {
          chain_id: string;
          address: string;
          verified_at: string;
        }[];
      }
    | undefined;
  const d = deployment.parse(
    JSON.parse(
      await readFile(
        join(release.folder, '..', 'deployments/testnet.json'),
        'utf8',
      ),
    ),
  );
  const config = await near_view<{ settlement_token: string }>(
    d.near.coordinator,
    'get_config',
  );
  if (config.settlement_token !== d.near.settlement_token)
    throw new Error('Runtime settlement token does not match the coordinator');
  if (
    !primary.contracts.accounting ||
    !primary.contracts.pool_governance ||
    !basket.contracts.complete
  )
    throw new Error(
      'Complete the live basket, pool accounting and governance checks before preparing enablement',
    );
  const flags = await near_view<{ origination: boolean }>(
    d.near.coordinator,
    'get_pause_flags',
  );
  if (!flags.origination)
    throw new Error('Prepare capability records while origination is paused');
  type Evidence = {
    chain_id: string;
    manifest: ChainConfiguration['manifest'] | null;
    authority_check: unknown;
    wallet_authentication: unknown;
    cases: { loan: Loan; transactions: Record<string, string | null> }[];
    complete: boolean;
    verified_at: string;
  };
  const records: Evidence[] = [];
  for (const chain_id of [
    'near',
    ...d.chains.map((c) => c.manifest.chain_id),
  ]) {
    const c = d.chains.find((c) => c.manifest.chain_id === chain_id),
      cases = [];
    const connection = authentication?.connections.find(
      (c) => c.chain_id === chain_id,
    );
    let complete = !!security.contracts[chain_id] && !!connection;
    for (const kind of ['repay', 'liquidate']) {
      const loan_id = `live_${chain_id}_${kind}_v1`;
      const loan = await near_view<Loan>(d.near.coordinator, 'get_loan', {
        loan_id,
      });
      const ids = {
        deposit: `deposit-${loan_id}`,
        lock_proof:
          confirmed_effect_id(primary.effects, `verify-${loan_id}`) ??
          `verify-${loan_id}`,
        funding:
          confirmed_effect_id(primary.effects, `fund-${loan_id}`) ??
          `fund-${loan_id}`,
        sale: `outgoing-delivery_${loan_id}`,
        sale_proof:
          confirmed_effect_id(primary.effects, `deliver-delivery_${loan_id}`) ??
          `deliver-delivery_${loan_id}`,
        settlement: `apply-${loan_id}`,
        release: `outgoing-release_${loan_id}`,
        release_proof:
          confirmed_effect_id(primary.effects, `deliver-release_${loan_id}`) ??
          `deliver-release_${loan_id}`,
        native_release: `release-${loan_id}`,
      };
      const tx = Object.fromEntries(
        Object.entries(ids).map(([name, id]) => [
          name,
          primary.effects[id]?.transaction_id ?? null,
        ]),
      );
      const confirmed = (id: string) =>
        primary.effects[id]?.state === 'confirmed';
      complete =
        complete &&
        loan.state === 'repaid' &&
        loan.principal_outstanding_atomic === '0' &&
        loan.interest_atomic === '0' &&
        loan.fees_due_atomic === '0' &&
        loan.active_outflow === null &&
        loan.locks.every(
          (l) =>
            l.accepted &&
            l.receipt_verified &&
            l.locked_atomic === '0' &&
            l.reserved_atomic === '0',
        ) &&
        confirmed(ids.deposit) &&
        confirmed(ids.funding) &&
        confirmed(ids.settlement) &&
        (chain_id === 'near'
          ? confirmed(ids.native_release)
          : confirmed(ids.lock_proof) &&
            confirmed(ids.sale_proof) &&
            confirmed(ids.release_proof));
      cases.push({ loan, transactions: tx });
    }
    records.push({
      chain_id,
      manifest: c?.manifest ?? null,
      authority_check: security.contracts[chain_id] ?? null,
      wallet_authentication: connection ?? null,
      cases,
      complete,
      verified_at: new Date().toISOString(),
    });
  }
  const waiting = records.filter((r) => !r.complete).map((r) => r.chain_id);
  const unfinished = waiting.filter(
    (id) => !['bitcoin', 'starknet'].includes(id),
  );
  if (unfinished.length)
    throw new Error(
      `Live lifecycle verification remains incomplete: ${unfinished.join(', ')}`,
    );
  const output = join(release.folder, '..', 'deployments');
  await mkdir(output, { recursive: true });
  const owner = await near_signer(release, 'owner');
  let saved = release.journal.contracts.targets as
    ChainConfiguration[] | undefined;
  const prior_records = release.journal.contracts.evidence as
    Evidence[] | undefined;
  const prepared_runtime = release.journal.contracts.runtime as
    Deployment | undefined;
  const batch_prepared =
    saved &&
    prepared_runtime &&
    canonical_json(saved.map((c) => c.manifest)) ===
      canonical_json(prepared_runtime.chains.map((c) => c.manifest));
  const current = await Promise.all(
    d.chains.map(async (c) => ({
      ...c,
      manifest: chain_manifest.parse(
        await near_view(d.near.coordinator, 'get_chain_manifest', {
          chain_id: c.manifest.chain_id,
        }),
      ),
    })),
  );
  if (
    saved &&
    batch_prepared &&
    prior_records &&
    (current.some(
      (c) =>
        canonical_json(c.manifest) !==
        canonical_json(
          saved!.find((s) => s.manifest.chain_id === c.manifest.chain_id)
            ?.manifest,
        ),
    ) ||
      records.some(
        (r) =>
          prior_records.find((p) => p.chain_id === r.chain_id)?.complete !==
          r.complete,
      ))
  ) {
    saved = undefined;
    delete release.journal.contracts.public_policy;
    delete release.journal.contracts.activation;
  }
  const targets =
    saved ??
    current.map((c) => {
      const record = records.find((r) => r.chain_id === c.manifest.chain_id)!;
      const fee =
        c.manifest.family === 'evm'
          ? 100000000000n
          : BigInt(c.manifest.max_fee_per_gas);
      const cost =
        c.manifest.family === 'evm'
          ? fee * 750000n
          : BigInt(c.manifest.max_network_cost_atomic);
      return {
        ...c,
        manifest: chain_manifest.parse({
          ...c.manifest,
          version: c.manifest.version + 1,
          new_locks_enabled: record.complete,
          signing_enabled: true,
          max_fee_per_gas: fee.toString(),
          max_network_cost_atomic: cost.toString(),
          capability_evidence_hash: Array.from(
            Buffer.from(digest(JSON.stringify(record)), 'hex'),
          ),
        }),
        evidence: null,
      };
    });
  if (!saved) {
    release.journal.contracts.targets = targets;
    release.journal.contracts.evidence = records;
    await release.save();
  }
  const original_records = release.journal.contracts.evidence as Evidence[];
  const generation = Math.max(...targets.map((c) => c.manifest.version));
  const credit = BigInt(
    await near_view<string>(d.near.coordinator, 'storage_balance', {
      account_id: owner.accountId,
    }),
  );
  if (credit < 500000000000000000000000n)
    await near_send(
      release,
      `enable-owner-storage-v${generation}`,
      owner,
      d.near.coordinator,
      [call('storage_deposit', {}, 500000000000000000000000n)],
    );
  const suffix = generation === 2 ? '' : `-v${generation}`;
  for (const c of targets) {
    const m = c.manifest;
    const record = original_records.find((r) => r.chain_id === m.chain_id)!;
    const effect = await near_send(
      release,
      `capability-${m.chain_id}-manifest-${m.version}`,
      owner,
      d.near.coordinator,
      [call('register_chain_manifest', { manifest: m })],
    );
    if (m.family === 'bitcoin') {
      const verifier = await near_view(
        d.near.coordinator,
        'get_bitcoin_verifier',
        { manifest_version: m.version - 1 },
      );
      if (!verifier)
        throw new Error(
          'Previous Bitcoin manifest has no reviewed light client',
        );
      await near_send(
        release,
        `capability-bitcoin-verifier-${m.version}`,
        owner,
        d.near.coordinator,
        [
          call('register_bitcoin_verifier', {
            manifest_version: m.version,
            verifier,
          }),
        ],
      );
    }
    const verified = await near_send(
      release,
      `capability-key-${m.chain_id}-manifest-${m.version}`,
      owner,
      d.near.coordinator,
      [
        call('verify_controller_key', {
          chain_id: m.chain_id,
          version: m.version,
        }),
      ],
    );
    if (value_of(verified) !== true)
      throw new Error(`Controller verification failed: ${m.chain_id}`);
    if (record.complete) {
      c.evidence = {
        verified_at: Math.floor(Date.parse(record.verified_at) / 1000),
        record_url: `https://testnet.nearblocks.io/txns/${effect.transaction_id}`,
        deposit_transaction: record.cases[0]!.transactions.deposit!,
        release_transaction: record.cases[0]!.transactions.release!,
      };
    }
    await release.save();
  }
  const manager = await near_signer(release, 'manager');
  const public_pool = await near_view<{ policy: PoolPolicy }>(
    d.near.coordinator,
    'get_pool',
    { pool_id: d.pool_ids[0]! },
  );
  const policy = (release.journal.contracts.public_policy as
    PoolPolicy | undefined) ?? {
    ...public_pool.policy,
    version: public_pool.policy.version + 1,
    eligible_assets: records
      .filter((r) => r.complete)
      .map((r) =>
        r.chain_id === 'near'
          ? 'near'
          : d.chains.find((c) => c.manifest.chain_id === r.chain_id)!.manifest
              .asset_id,
      ),
  };
  policy.asset_caps = policy.eligible_assets.map((asset_id) => ({
    asset_id,
    max_collateral_value_atomic: '1000000000000',
  }));
  release.journal.contracts.public_policy = policy;
  await release.save();
  await near_send(
    release,
    `public-pool-policy${suffix}`,
    manager,
    d.near.coordinator,
    [call('update_pool_policy', { pool_id: d.pool_ids[0]!, policy })],
  );
  const runtime = deployment.parse({
    ...d,
    pool_ids: d.pool_ids,
    chains: targets,
  });
  release.journal.contracts.runtime = runtime;
  release.journal.contracts.waiting = waiting;
  await release.save();
  await json_file(join(output, 'testnet.json'), runtime);
  console.log(
    `Verified capabilities prepared; waiting: ${waiting.join(', ') || 'none'}; origination remains paused`,
  );
}
export async function activate_lending(release: Release) {
  const d = deployment.parse(
    JSON.parse(
      await readFile(
        join(release.folder, '..', 'deployments/testnet.json'),
        'utf8',
      ),
    ),
  );
  const config = await near_view<{
    settlement_token: string;
    settlement_decimals: number;
  }>(d.near.coordinator, 'get_config');
  if (
    config.settlement_token !== NEAR_TESTNET_USDC ||
    config.settlement_decimals !== 6 ||
    d.near.settlement_token !== NEAR_TESTNET_USDC
  )
    throw new Error('Official Circle USDC configuration is required');
  const verified = await read_json<Release['journal']>(
    release.folder,
    'deployment-usdc.json',
  );
  const proof = Object.values(verified.contracts)
    .map((value) => (value as { complete?: unknown }).complete)
    .find((value) => {
      if (!value || typeof value !== 'object') return false;
      const evidence = value as { settlement_token?: string; loan?: Loan };
      return (
        evidence.settlement_token === NEAR_TESTNET_USDC &&
        evidence.loan &&
        d.pool_ids.includes(evidence.loan.offer.pool_id)
      );
    }) as { loan: Loan } | undefined;
  if (!proof)
    throw new Error(
      'Verify the Circle USDC SDK/API lifecycle before activation',
    );
  const loan = await near_view<Loan>(d.near.coordinator, 'get_loan', {
    loan_id: proof.loan.loan_id,
  });
  const summary = await near_view<LoanSummary>(
    d.near.coordinator,
    'loan_summary',
    { loan_id: loan.loan_id },
  );
  if (
    summary.debt_atomic !== '0' ||
    !summary.custody_resolved ||
    loan.state !== 'repaid'
  )
    throw new Error(
      'The Circle USDC verification loan has not fully completed',
    );
  const liquidity_key = scoped_id(
    'circle-liquidity',
    d.near.settlement_token,
    ...d.pool_ids,
  );
  const refund_key = scoped_id('circle-refund', loan.loan_id);
  if (
    !(verified.contracts[liquidity_key] as { complete?: boolean } | undefined)
      ?.complete ||
    !(verified.contracts[refund_key] as { complete?: boolean } | undefined)
      ?.complete
  )
    throw new Error(
      'Verify Circle USDC LP withdrawals and solver refunds before activation',
    );
  const settings = process.env;
  if (!settings.PORT || !settings.REDIS_URL)
    throw new Error(
      'PORT and REDIS_URL are required for activation readiness checks',
    );
  const api_url = `http://127.0.0.1:${settings.PORT}`;
  const response = await fetch(api_url + '/health/ready', {
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('Testnet API is not ready');
  const health = (await response.json()) as {
    deployment_id: string;
    relayer: boolean;
    solver: boolean;
  };
  if (
    health.deployment_id !== d.deployment_id ||
    !health.relayer ||
    !health.solver
  )
    throw new Error('Testnet runtime signer configuration is incomplete');
  const queues = new Queues(settings.REDIS_URL!);
  try {
    await queues.ready();
    if (!(await queues.operations.getWorkers()).length)
      throw new Error('No reconciliation worker is connected');
  } finally {
    await queues.close();
  }
  const capabilities_response = await fetch(
    api_url + '/v1/catalog/capabilities',
    {
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!capabilities_response.ok)
    throw new Error('Testnet capability catalog is unavailable');
  const capabilities = (await capabilities_response.json()) as {
    chain_id: string;
    read_mpc: boolean;
    light_client: boolean;
    signing: boolean;
  }[];
  for (const c of d.chains.filter((c) => c.manifest.new_locks_enabled)) {
    const capability = capabilities.find(
      (x) => x.chain_id === c.manifest.chain_id,
    );
    if (
      !(c.manifest.family === 'bitcoin'
        ? capability?.light_client
        : capability?.read_mpc) ||
      !capability?.signing
    )
      throw new Error(
        `API capabilities are unavailable: ${c.manifest.chain_id}`,
      );
  }
  await refresh_prices();
  for (const c of d.chains) {
    const actual = await near_view(d.near.coordinator, 'get_chain_manifest', {
      chain_id: c.manifest.chain_id,
    });
    if (JSON.stringify(actual) !== JSON.stringify(c.manifest)) {
      if (canonical_json(actual) !== canonical_json(c.manifest))
        throw new Error(`Runtime manifest changed: ${c.manifest.chain_id}`);
    }
    if (c.manifest.new_locks_enabled && !c.evidence)
      throw new Error('Enabled chain has no verified lifecycle evidence');
  }
  for (const pool_id of d.pool_ids) {
    const pool = await near_view<Pool>(d.near.coordinator, 'get_pool', {
      pool_id,
    });
    if (
      BigInt(pool.cash_atomic) - BigInt(pool.reserved_atomic) <
        BigInt(pool.policy.min_principal_atomic) ||
      pool.in_flight_atomic !== '0' ||
      pool.total_shares === '0'
    )
      throw new Error('Public Testnet pool is not funded and reconciled');
  }
  if (
    (
      await near_view<[string, string]>(
        d.near.coordinator,
        'settlement_liabilities',
      )
    ).some((value) => value !== '0')
  )
    throw new Error('Circle USDC escrow or refund liability remains');
  const activation_id = scoped_id(
    'enable-origination',
    d.near.settlement_token,
    ...d.pool_ids,
    loan.loan_id,
  );
  await near_send(
    release,
    activation_id,
    await near_signer(release, 'owner'),
    d.near.coordinator,
    [
      call('set_pause_flags', {
        flags: {
          origination: false,
          collateral_withdrawals: false,
          settlements: false,
        },
      }),
    ],
  );
  const flags = await near_view<{ origination: boolean }>(
    d.near.coordinator,
    'get_pause_flags',
  );
  if (flags.origination) throw new Error('Origination did not activate');
  release.journal.contracts.activation = {
    api_url,
    transaction_id: release.journal.effects[activation_id]!.transaction_id,
    enabled_chains: [
      'near',
      ...d.chains
        .filter((c) => c.manifest.new_locks_enabled)
        .map((c) => c.manifest.chain_id),
    ],
    waiting: d.chains
      .filter((c) => !c.manifest.new_locks_enabled)
      .map((c) => c.manifest.chain_id),
    verified_at: new Date().toISOString(),
  };
  await release.save();
  console.log('Verified Testnet lending activated');
}
