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
import { resolve, join } from 'node:path';
export async function directory() {
  const root = resolve(process.cwd(), '..');
  const pkg = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ) as { name: string };
  if (pkg.name !== 'kanso')
    throw new Error('Run through the Kanso workspace testnet commands');
  const folder = join(root, '.testnet');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if ((await lstat(folder)).isSymbolicLink())
    throw new Error('Credential directory cannot be a symlink');
  await chmod(folder, 0o700);
  await mkdir(join(folder, 'keys'), { recursive: true, mode: 0o700 });
  if ((await lstat(join(folder, 'keys'))).isSymbolicLink())
    throw new Error('Key directory cannot be a symlink');
  await chmod(join(folder, 'keys'), 0o700);
  return folder;
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
