import { createHash } from 'node:crypto';
import { readFile, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  directory,
  read_json,
  private_json,
  replace_json,
  keys_directory,
  workspace_root,
} from '@testnet/store';

export interface DeploymentEffect {
  intent: string;
  state: 'prepared' | 'confirmed' | 'failed';
  transaction_id: string;
  raw_transaction?: string;
  request?: unknown;
  result?: unknown;
  replacements?: { transaction_id: string; raw_transaction: string }[];
}
export interface DeploymentJournal {
  version: 1;
  deployment_id: string;
  effects: Record<string, DeploymentEffect>;
  contracts: Record<string, unknown>;
}
export const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

export function confirmed_effect_id(
  effects: DeploymentJournal['effects'],
  id: string,
) {
  return Object.keys(effects).find(
    (key) =>
      (key === id ||
        key.startsWith(`${id}-retry-`) ||
        key.startsWith(`${id}-spv-`)) &&
      effects[key]?.state === 'confirmed',
  );
}

export class Release {
  private saving: Promise<void> = Promise.resolve();
  private constructor(
    readonly folder: string,
    readonly journal: DeploymentJournal,
    readonly filename: string,
    readonly key_folder: string,
  ) {}
  static async load(filename = 'deployment.json') {
    if (!/^deployment(?:-[a-z]+)?\.json$/.test(filename))
      throw new Error('Invalid deployment journal name');
    const folder = await directory();
    const key_folder = await keys_directory();
    const coordinator = await read_json<{ account_id: string }>(
      key_folder,
      'near-coordinator.json',
    );
    const suffix = /^kanso-coordinator-([a-f0-9]+)\.testnet$/.exec(
      coordinator.account_id,
    )?.[1];
    if (!suffix) throw new Error('Unexpected Testnet coordinator account');
    const deployment_id = `kanso-testnet-${suffix}-v1`;
    try {
      const journal = await read_json<DeploymentJournal>(folder, filename);
      if (journal.version !== 1 || journal.deployment_id !== deployment_id)
        throw new Error('Deployment journal belongs to another key set');
      return new Release(folder, journal, filename, key_folder);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
      const journal: DeploymentJournal = {
        version: 1,
        deployment_id,
        effects: {},
        contracts: {},
      };
      await private_json(folder, filename, journal);
      return new Release(folder, journal, filename, key_folder);
    }
  }
  async save() {
    const snapshot = structuredClone(this.journal);
    const saving = this.saving.then(() =>
      replace_json(this.folder, this.filename, snapshot),
    );
    this.saving = saving.catch(() => {});
    await saving;
  }
  async artifact(path: string) {
    const bytes = await readFile(join(workspace_root, path));
    return { bytes, sha256: digest(bytes) };
  }
  async lock<T>(run: () => Promise<T>): Promise<T> {
    const path = join(this.folder, this.filename.replace('.json', '.lock'));
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          started_at: new Date().toISOString(),
        }),
      );
      return await run();
    } finally {
      await handle.close();
      await unlink(path);
    }
  }
}
