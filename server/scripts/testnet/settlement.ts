import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NEAR_TESTNET_USDC } from '@kanso/bindings';
import { deployment } from '@kanso/schema';
import type { Loan, Pool, PoolPolicy, Refund, Transfer } from '@kanso/schema';
import { scoped_id } from '@kanso/sdk';
import { Release } from '@testnet/deployment';
import { read_json } from '@testnet/store';
import type { KeyIndex } from '@testnet/store';
import {
  call,
  near_send,
  near_signer,
  near_view,
  finalize_near_transfer,
} from '@testnet/deploy-near';
import { near_map_keys, read_batch } from '@testnet/near-state';
import { upgrade_near } from '@testnet/upgrade-near';
import { NEAR_RPC } from '@testnet/network';

const pool_id = 'usdc';
const legacy_pools = ['live-verification', 'test-usdc'];
type Position = { shares: string; reserved_shares: string };
type Migration = {
  previous_token: string;
  policy: PoolPolicy;
  prepared_at: string;
  completed_at?: string;
};

async function runtime(release: Release) {
  return deployment.parse(
    JSON.parse(
      await readFile(
        join(release.folder, '..', 'deployments/testnet.json'),
        'utf8',
      ),
    ),
  );
}

export async function settlement_status(release: Release) {
  const d = await runtime(release),
    coordinator = d.near.coordinator;
  const config = await near_view<{ settlement_token: string }>(
    coordinator,
    'get_config',
  );
  const ids =
    config.settlement_token === NEAR_TESTNET_USDC ? [pool_id] : legacy_pools;
  const pools = await read_batch(ids, async (pool_id) => {
    try {
      return await near_view<Pool>(coordinator, 'get_pool', { pool_id });
    } catch (error) {
      if (error instanceof Error && error.message.includes('POOL_NOT_FOUND'))
        return null;
      throw error;
    }
  });
  const index = await read_json<KeyIndex>(release.folder, 'index.json');
  const balances = await read_batch(
    index.wallets.filter(
      (w) =>
        w.family === 'near' && ['lp', 'borrower', 'solver'].includes(w.role),
    ),
    async (w) => ({
      role: w.role,
      account: w.address,
      usdc_atomic: await near_view<string>(NEAR_TESTNET_USDC, 'ft_balance_of', {
        account_id: w.address,
      }),
    }),
  );
  return {
    settlement_token: config.settlement_token,
    pools: pools.filter((value) => value !== null),
    balances,
    upgrade: await near_view(coordinator, 'get_upgrade_status'),
  };
}

async function assert_resolved(coordinator: string) {
  const ids = await near_map_keys(coordinator, 'l');
  const loans = await read_batch(ids, ([loan_id]) =>
    near_view<Loan>(coordinator, 'get_loan', { loan_id }),
  );
  const unresolved = loans.filter(
    (l) =>
      !['repaid', 'cancelled', 'written_off'].includes(l.state) ||
      l.active_outflow ||
      l.locks.some(
        (lock) => lock.locked_atomic !== '0' || lock.reserved_atomic !== '0',
      ),
  );
  if (unresolved.length)
    throw new Error(
      `Resolve existing loans before migration: ${unresolved.map((l) => l.loan_id).join(', ')}`,
    );
  const transfers = await read_batch(
    await near_map_keys(coordinator, 't'),
    ([transfer_id]) =>
      near_view<Transfer>(coordinator, 'get_transfer', { transfer_id }),
  );
  if (transfers.some((t) => !t.finalized || t.outcome === 'unknown'))
    throw new Error('Resolve existing transfers before migration');
  const liabilities = await near_view<[string, string]>(
    coordinator,
    'settlement_liabilities',
  );
  if (liabilities.some((value) => value !== '0'))
    throw new Error('Resolve solver escrow and refunds before migration');
}

async function return_legacy_refunds(release: Release, coordinator: string) {
  const index = await read_json<KeyIndex>(release.folder, 'index.json');
  const refunds = await read_batch(
    await near_map_keys(coordinator, 'rf'),
    ([refund_id]) =>
      near_view<Refund>(coordinator, 'get_refund', { refund_id }),
  );
  for (const refund of refunds.filter((value) => !value.paid)) {
    const wallet = index.wallets.find(
      (value) => value.family === 'near' && value.address === refund.owner,
    );
    if (!wallet)
      throw new Error(
        `The refund belongs to an external account: ${refund.owner}`,
      );
    const transfer_id =
      refund.transfer_id ?? scoped_id('return-legacy-refund', refund.refund_id);
    if (!refund.transfer_id)
      await near_send(
        release,
        `refund-${refund.refund_id}`,
        await near_signer(release, wallet.role),
        coordinator,
        [call('claim_refund', { refund_id: refund.refund_id, transfer_id })],
      );
    await finalize_near_transfer(release, coordinator, transfer_id);
    if (
      !(
        await near_view<Refund>(coordinator, 'get_refund', {
          refund_id: refund.refund_id,
        })
      ).paid
    )
      throw new Error('The legacy refund is unfinished');
  }
}

export async function migrate_settlement(release: Release) {
  const d = await runtime(release),
    coordinator = d.near.coordinator;
  const owner = await near_signer(release, 'owner');
  const config = await near_view<{ settlement_token: string }>(
    coordinator,
    'get_config',
  );
  let migration = release.journal.contracts.settlement_migration as
    Migration | undefined;
  if (
    migration?.completed_at &&
    config.settlement_token === NEAR_TESTNET_USDC
  ) {
    console.log('Circle USDC migration already completed');
    return;
  }
  if (config.settlement_token !== NEAR_TESTNET_USDC) {
    await near_send(release, 'usdc-migration-pause', owner, coordinator, [
      call('set_pause_flags', {
        flags: {
          origination: true,
          collateral_withdrawals: true,
          settlements: true,
        },
      }),
    ]);
    const scheduled = await near_view<{
      governance: { pending_upgrade: { execute_after: number } | null };
    }>(coordinator, 'get_upgrade_status');
    if (
      scheduled.governance.pending_upgrade &&
      Date.now() / 1000 < scheduled.governance.pending_upgrade.execute_after
    ) {
      console.log(
        `Upgrade execution opens at ${new Date(scheduled.governance.pending_upgrade.execute_after * 1000).toISOString()}; lending is paused`,
      );
      return;
    }
    await upgrade_near(release);
    if (
      (
        await near_view<{ governance: { pending_upgrade: unknown } }>(
          coordinator,
          'get_upgrade_status',
        )
      ).governance.pending_upgrade
    )
      return;
    const pools = (await near_map_keys(coordinator, 'p'))
      .map(([id]) => id!)
      .sort();
    if (
      pools.some((id) => !legacy_pools.includes(id)) ||
      (!migration && JSON.stringify(pools) !== JSON.stringify(legacy_pools))
    )
      throw new Error(
        'The full legacy pool set changed; inspect it before upgrading',
      );
    await return_legacy_refunds(release, coordinator);
    await assert_resolved(coordinator);
    if (!migration) {
      const current = await near_view<Pool>(coordinator, 'get_pool', {
        pool_id: 'test-usdc',
      });
      migration = {
        previous_token: config.settlement_token,
        policy: { ...current.policy, version: 1 },
        prepared_at: new Date().toISOString(),
      };
      release.journal.contracts.settlement_migration = migration;
      await release.save();
    }
    const index = await read_json<KeyIndex>(release.folder, 'index.json');
    const positions = await near_map_keys(coordinator, 's', 2);
    for (const legacy of pools) {
      for (const [position_pool, account_id] of positions) {
        if (position_pool !== legacy) continue;
        const position = await near_view<Position>(
          coordinator,
          'get_position',
          { pool_id: legacy, account_id },
        );
        const withdrawal_id = scoped_id(
          'retire-usdc-pool',
          legacy,
          account_id!,
        );
        const transfer_id = scoped_id(withdrawal_id, 'payout');
        const existing = await near_view<Transfer | null>(
          coordinator,
          'get_transfer',
          { transfer_id },
        );
        if (existing) {
          await finalize_near_transfer(release, coordinator, transfer_id);
          continue;
        }
        if (position.shares === '0') continue;
        if (position.reserved_shares !== '0')
          throw new Error(`Cancel pending withdrawals for ${account_id}`);
        const wallet = index.wallets.find(
          (w) => w.family === 'near' && w.address === account_id,
        );
        if (!wallet)
          throw new Error(
            `The pool position belongs to an external account: ${account_id}`,
          );
        const lp = await near_signer(release, wallet.role);
        await near_send(release, `request-${withdrawal_id}`, lp, coordinator, [
          call('request_withdrawal', {
            pool_id: legacy,
            withdrawal_id,
            shares: position.shares,
          }),
        ]);
        await near_send(release, `claim-${withdrawal_id}`, lp, coordinator, [
          call('claim_withdrawal', { withdrawal_id, transfer_id }),
        ]);
        await finalize_near_transfer(release, coordinator, transfer_id);
      }
      const pool = await near_view<Pool>(coordinator, 'get_pool', {
        pool_id: legacy,
      });
      if (
        [
          pool.cash_atomic,
          pool.reserved_atomic,
          pool.in_flight_atomic,
          pool.total_shares,
        ].some((value) => value !== '0') ||
        pool.loan_ids.length ||
        pool.pending_withdrawal
      )
        throw new Error(`Legacy pool still has balances: ${legacy}`);
    }
    if (
      (await near_view<string>(migration.previous_token, 'ft_balance_of', {
        account_id: coordinator,
      })) !== '0'
    )
      throw new Error('The old settlement token balance is not empty');
    const actual = (await near_map_keys(coordinator, 'p'))
      .map(([id]) => id!)
      .sort();
    if (
      actual.some((id) => !legacy_pools.includes(id)) ||
      (await near_view<number>(coordinator, 'get_pool_count')) !== actual.length
    )
      throw new Error(
        'Pool registry backfill does not match complete onchain storage',
      );
    for (const legacy of actual) {
      const pool = await near_view<Pool>(coordinator, 'get_pool', {
        pool_id: legacy,
      });
      const manager_role = index.wallets.find(
        (w) => w.family === 'near' && w.address === pool.manager,
      )?.role;
      if (!manager_role)
        throw new Error(`Unknown pool manager: ${pool.manager}`);
      await near_send(
        release,
        `close-${legacy}`,
        await near_signer(release, manager_role),
        coordinator,
        [call('close_pool', { pool_id: legacy })],
      );
    }
    await near_send(release, 'use-circle-usdc', owner, coordinator, [
      call('migrate_testnet_usdc', {}),
    ]);
  }
  if (!migration)
    throw new Error(
      'The migration journal is missing the verified pool policy',
    );
  for (const role of ['coordinator', 'lp', 'borrower', 'solver']) {
    const account_id = (await near_signer(release, role)).accountId;
    if (
      await near_view(NEAR_TESTNET_USDC, 'storage_balance_of', { account_id })
    )
      continue;
    const bounds = await near_view<{ min: string }>(
      NEAR_TESTNET_USDC,
      'storage_balance_bounds',
    );
    await near_send(
      release,
      `circle-register-${role}`,
      owner,
      NEAR_TESTNET_USDC,
      [
        call(
          'storage_deposit',
          { account_id, registration_only: true },
          BigInt(bounds.min),
        ),
      ],
    );
  }
  if (!(await near_map_keys(coordinator, 'p')).some(([id]) => id === pool_id)) {
    await near_send(
      release,
      'create-usdc-pool',
      await near_signer(release, 'manager'),
      coordinator,
      [call('create_pool', { pool_id, policy: migration.policy })],
    );
  }
  const pool = await near_view<Pool>(coordinator, 'get_pool', { pool_id });
  if (pool.total_shares === '0') {
    const lp = await near_signer(release, 'lp');
    const balance = BigInt(
      await near_view<string>(NEAR_TESTNET_USDC, 'ft_balance_of', {
        account_id: lp.accountId,
      }),
    );
    if (balance < 20_000_000n)
      throw new Error(
        `Fund ${lp.accountId} with 20 Circle USDC on NEAR Testnet`,
      );
    await near_send(release, 'fund-circle-usdc-pool', lp, NEAR_TESTNET_USDC, [
      call('ft_transfer_call', {
        receiver_id: coordinator,
        amount: '20000000',
        msg: JSON.stringify({
          kind: 'pool_deposit',
          pool_id,
          operation_id: 'circle_usdc_pool_fund_v1',
        }),
      }),
    ]);
  }
  const funded = await near_view<Pool>(coordinator, 'get_pool', { pool_id });
  const backing = await near_view<string>(NEAR_TESTNET_USDC, 'ft_balance_of', {
    account_id: coordinator,
  });
  if (
    BigInt(funded.cash_atomic) < 20_000_000n ||
    funded.total_shares === '0' ||
    backing !== funded.cash_atomic
  )
    throw new Error(
      'Circle USDC deposit did not credit and fully back the pool',
    );
  const updated = deployment.parse({
    ...d,
    near: {
      ...d.near,
      rpc_url: NEAR_RPC,
      settlement_token: NEAR_TESTNET_USDC,
      settlement_decimals: 6,
    },
    pool_ids: [pool_id],
  });
  await writeFile(
    join(release.folder, '..', 'deployments/testnet.json'),
    JSON.stringify(updated, null, 2) + '\n',
  );
  const primary = await Release.load();
  const near = primary.journal.contracts.near as Record<string, unknown>;
  near.settlement_token = NEAR_TESTNET_USDC;
  near.config = await near_view(coordinator, 'get_config');
  near.pool = await near_view(coordinator, 'get_pool', { pool_id });
  near.upgrade = await near_view(coordinator, 'get_upgrade_status');
  near.code_sha256 = (
    await release.artifact('contracts/near/target/near/kanso_coordinator.wasm')
  ).sha256;
  near.coordinator_upgrades =
    'owner-controlled, minimum one-minute testnet contract timelock';
  delete near.token_sha256;
  delete near.settlement_token_immutable;
  await primary.save();
  migration.completed_at = new Date().toISOString();
  await release.save();
  console.log(
    'Circle NEAR Testnet USDC configured; legacy pools removed; origination remains paused for live verification',
  );
}
