import {
  lstat,
  mkdir,
  readFile,
  writeFile,
  chmod,
  rename,
  unlink,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspace_root = fileURLToPath(
  new URL('../../../', import.meta.url),
);

async function private_directory(folder: string) {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if ((await lstat(folder)).isSymbolicLink())
    throw new Error('Local storage cannot be a symlink');
  await chmod(folder, 0o700);
  return folder;
}

export async function keys_directory() {
  return private_directory(join(workspace_root, '.keys'));
}

export async function directory() {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
        : (process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'));
  const folder = process.env.KANSO_STATE_DIR ?? join(base, 'Kanso', 'testnet');
  if (!isAbsolute(folder))
    throw new Error('KANSO_STATE_DIR must be an absolute path');
  return private_directory(folder);
}
export async function private_json(
  folder: string,
  name: string,
  data: unknown,
) {
  await private_text(folder, name, JSON.stringify(data, null, 2) + '\n');
}
export async function private_text(folder: string, name: string, text: string) {
  await writeFile(join(folder, name), text, {
    mode: 0o600,
    flag: 'wx',
  });
}
export async function read_json<T>(folder: string, name: string): Promise<T> {
  const file = join(folder, name);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error(
      'Credential files must be regular files readable only by their owner',
    );
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
export async function replace_json(
  folder: string,
  name: string,
  data: unknown,
) {
  const file = join(folder, name);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error('Unsafe local record permissions');
  const temporary = join(folder, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
export interface WalletRecord {
  family: 'near' | 'evm' | 'solana' | 'sui' | 'bitcoin' | 'starknet';
  role: string;
  address: string;
  key_file: string;
}
export interface KeyIndex {
  version: 1;
  created_at: string;
  wallets: WalletRecord[];
}
