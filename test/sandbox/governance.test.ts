import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coordinator_views } from '@kanso/bindings';
import { create_sandbox, GAS, NEAR, signed } from '@test/sandbox/context';
import type { Sandbox } from '@test/sandbox/context';

describe('coordinator upgrades on actual WASM', () => {
  let sandbox: Sandbox;
  beforeAll(async () => {
    sandbox = await create_sandbox({ epoch_length: 100_000 });
  });
  afterAll(async () => {
    await sandbox?.node.tearDown();
  });
  it('rolls back a failed migration and preserves live accounting through a successful upgrade', async () => {
    const {
      coordinator,
      root,
      borrower,
      lp,
      worker,
      create_pool,
      offer,
      loan,
      now,
      token_balance,
    } = sandbox;
    await create_pool('upgrade');
    await borrower.call(
      coordinator,
      'accept_offer',
      { offer: await offer('upgrade_loan', 'upgrade') },
      signed,
    );
    await borrower.call(
      coordinator,
      'lock_native',
      { loan_id: 'upgrade_loan', leg_id: 'near' },
      { gas: GAS, attachedDeposit: 100n * NEAR },
    );
    await borrower.call(
      coordinator,
      'fund_loan',
      { loan_id: 'upgrade_loan', transfer_id: 'upgrade_fund' },
      signed,
    );
    const pool = await coordinator.view('get_pool', { pool_id: 'upgrade' });
    const position = await coordinator.view('get_position', {
      pool_id: 'upgrade',
      account_id: lp.accountId,
    });
    const funded = await loan('upgrade_loan');
    const balance = await token_balance(coordinator);
    const wasm = new URL('../../contracts/near/target/near/', import.meta.url);
    await root.call(
      coordinator,
      'storage_deposit',
      {},
      { attachedDeposit: 30n * NEAR },
    );
    async function schedule(code: Buffer) {
      const code_hash = Array.from(createHash('sha256').update(code).digest());
      await root.call(
        coordinator,
        'schedule_upgrade',
        { code_hash, execute_after: (await now()) + 3601 },
        signed,
      );
      await expect(
        root.call(coordinator, 'execute_upgrade', { code: null }, signed),
      ).rejects.toThrow('UPGRADE_TIMELOCK');
      for (let offset = 0; offset < code.length; offset += 120_000) {
        await root.call(
          coordinator,
          'stage_upgrade_chunk',
          {
            code_hash,
            offset,
            chunk: code.subarray(offset, offset + 120_000).toString('base64'),
          },
          signed,
        );
      }
      await worker.provider.fastForward(15_000);
      const execute_after = coordinator_views.get_upgrade_status.parse(
        await coordinator.view('get_upgrade_status', {}),
      ).governance.pending_upgrade!.execute_after;
      await expect
        .poll(now, { timeout: 10_000, interval: 100 })
        .toBeGreaterThanOrEqual(execute_after);
      return code_hash;
    }
    const incompatible = await readFile(new URL('kanso_test_usdc.wasm', wasm));
    const failed_hash = await schedule(incompatible);
    await expect(
      root.call(coordinator, 'execute_upgrade', { code: null }, signed),
    ).rejects.toThrow();
    expect(await coordinator.view('get_pool', { pool_id: 'upgrade' })).toEqual(
      pool,
    );
    expect(
      coordinator_views.get_upgrade_status.parse(
        await coordinator.view('get_upgrade_status', {}),
      ).governance.pending_upgrade?.code_hash,
    ).toEqual(failed_hash);
    await root.call(
      coordinator,
      'cancel_upgrade',
      { code_hash: failed_hash },
      signed,
    );

    const code = await readFile(new URL('kanso_coordinator.wasm', wasm));
    const code_hash = await schedule(code);
    await root.call(coordinator, 'execute_upgrade', { code: null }, signed);
    const status = coordinator_views.get_upgrade_status.parse(
      await coordinator.view('get_upgrade_status', {}),
    );
    expect(status.governance.pending_upgrade).toBeNull();
    expect(status.staged_bytes).toBe(0);
    expect(status.governance.last_upgrade_hash).toEqual(code_hash);
    expect(await coordinator.view('get_pool', { pool_id: 'upgrade' })).toEqual(
      pool,
    );
    expect(
      await coordinator.view('get_position', {
        pool_id: 'upgrade',
        account_id: lp.accountId,
      }),
    ).toEqual(position);
    const upgraded = await loan('upgrade_loan');
    expect(upgraded.offer).toEqual(funded.offer);
    expect(upgraded.policy).toEqual(funded.policy);
    expect(upgraded.locks).toEqual(funded.locks);
    expect(upgraded.principal_outstanding_atomic).toEqual(
      funded.principal_outstanding_atomic,
    );
    expect(BigInt(upgraded.interest_atomic)).toBeGreaterThan(
      BigInt(funded.interest_atomic),
    );
    expect(await token_balance(coordinator)).toBe(balance);
    await expect(
      root.call(coordinator, 'migrate', {
        expected_code_hash: code_hash,
        from_state_version: 1,
      }),
    ).rejects.toThrow();
    await sandbox.pay(borrower, '200000000', {
      kind: 'repayment',
      loan_id: 'upgrade_loan',
      operation_id: 'after_upgrade',
    });
    expect((await loan('upgrade_loan')).state).toBe('repaid');
  }, 240_000);
});
