import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, lstat, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  directory,
  private_json,
  read_json,
  replace_json,
} from '@testnet/store';
import { prune_confirmed_prices } from '@testnet/oracle';
import type { DeploymentEffect, Release } from '@testnet/deployment';

const folders: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

describe('private operational storage', () => {
  it('stores state separately with private permissions and preserves records on replacement', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kanso-storage-'));
    folders.push(parent);
    vi.stubEnv('KANSO_STATE_DIR', join(parent, 'state'));
    const folder = await directory();
    expect(folder).toBe(join(parent, 'state'));
    expect((await lstat(folder)).mode & 0o777).toBe(0o700);
    await private_json(folder, 'deployment.json', {
      effects: { pending: { state: 'prepared', transaction_id: 'original' } },
    });
    expect((await lstat(join(folder, 'deployment.json'))).mode & 0o777).toBe(
      0o600,
    );
    await expect(
      private_json(folder, 'deployment.json', {}),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    await replace_json(folder, 'deployment.json', {
      transaction_id: 'original',
      state: 'confirmed',
    });
    expect(await read_json(folder, 'deployment.json')).toEqual({
      transaction_id: 'original',
      state: 'confirmed',
    });
    await chmod(join(folder, 'deployment.json'), 0o644);
    await expect(read_json(folder, 'deployment.json')).rejects.toThrow(
      'readable only by their owner',
    );
  });
  it('rejects relative state paths and symbolic-link destinations', async () => {
    vi.stubEnv('KANSO_STATE_DIR', 'relative-state');
    await expect(directory()).rejects.toThrow('absolute path');
    const parent = await mkdtemp(join(tmpdir(), 'kanso-storage-'));
    folders.push(parent);
    await mkdir(join(parent, 'actual'));
    await symlink(join(parent, 'actual'), join(parent, 'linked'));
    vi.stubEnv('KANSO_STATE_DIR', join(parent, 'linked'));
    await expect(directory()).rejects.toThrow('cannot be a symlink');
  });
});

it('prunes old confirmed prices while retaining storage setup and unresolved transactions', () => {
  const effect = (state: DeploymentEffect['state']): DeploymentEffect => ({
    intent: 'price',
    state,
    transaction_id: 'original',
  });
  const effects = {
    'oracle-storage': effect('confirmed'),
    'oracle-old': effect('confirmed'),
    'oracle-current': effect('confirmed'),
    'oracle-pending': effect('prepared'),
    'oracle-failed': effect('failed'),
    'other-operation': effect('confirmed'),
  };
  prune_confirmed_prices(
    { journal: { effects } } as unknown as Release,
    'oracle-current',
  );
  expect(Object.keys(effects)).toEqual([
    'oracle-storage',
    'oracle-current',
    'oracle-pending',
    'oracle-failed',
    'other-operation',
  ]);
});
