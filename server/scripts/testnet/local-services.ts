import { spawn } from 'node:child_process';
import { mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Redis } from 'ioredis';
import type { Release } from '@testnet/deployment';
import { read_json, private_text } from '@testnet/store';
import type { LivePlan } from '@testnet/live-setup';

export async function local_services(release: Release) {
  for (const name of ['mongo', 'redis']) {
    const path = join(release.folder, name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(path)).isSymbolicLink())
      throw new Error('Service data cannot use a symlink');
  }
  const port = Number(process.env.TESTNET_REDIS_PORT ?? 6381);
  const redis = spawn(
    process.env.REDIS_SERVER_BIN ?? 'redis-server',
    [
      '--bind',
      '127.0.0.1',
      '--port',
      String(port),
      '--dir',
      join(release.folder, 'redis'),
      '--save',
      '',
      '--appendonly',
      'yes',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let redis_error: Error | undefined;
  redis.once('error', (error) => {
    redis_error = error;
  });
  let redis_stderr = '';
  redis.stderr.on('data', (data) => {
    redis_stderr = (redis_stderr + String(data)).slice(-2000);
  });
  const redis_client = new Redis(`redis://127.0.0.1:${port}`, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redis_client.on('error', () => {});
  let mongo: MongoMemoryReplSet | undefined;
  try {
    await pause(500);
    if (redis_error) throw redis_error;
    if (redis.exitCode !== null)
      throw new Error(`Redis failed to start: ${redis_stderr}`);
    await redis_client.connect();
    await redis_client.ping();
    mongo = await MongoMemoryReplSet.create({
      binary: {
        version: '8.2.2',
        ...(process.env.MONGOMS_DOWNLOAD_DIR
          ? { downloadDir: process.env.MONGOMS_DOWNLOAD_DIR }
          : {}),
      },
      instanceOpts: [
        {
          dbPath: join(release.folder, 'mongo'),
          port: Number(process.env.TESTNET_MONGO_PORT ?? 27021),
        },
      ],
      replSet: { name: 'kanso-testnet', count: 1, storageEngine: 'wiredTiger' },
    });
    const mongo_uri = mongo.getUri('kanso_testnet'),
      redis_url = `redis://127.0.0.1:${port}`;
    const primary = await read_json<{ contracts: { plan: LivePlan } }>(
      release.folder,
      'deployment-verification.json',
    );
    const role = async (name: string) =>
      read_json<{ account_id: string; private_key: string }>(
        release.folder,
        `keys/near-${name}.json`,
      );
    const relayer = await role('relayer'),
      solver = await role('solver');
    const recipients = Object.fromEntries(
      primary.contracts.plan.offers
        .flatMap((o) => o.legs)
        .flatMap((leg) =>
          leg.custody.family === 'remote'
            ? [
                [
                  leg.custody.chain_id,
                  '0x' + Buffer.from(leg.custody.source_owner).toString('hex'),
                ],
              ]
            : [],
        ),
    );
    const env = {
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: process.env.TESTNET_API_PORT ?? '55203',
      WORKER_TICK_MS: '15000',
      MONGODB_URI: mongo_uri,
      REDIS_URL: redis_url,
      DEPLOYMENT_FILE: join(
        release.folder,
        '..',
        'deployments',
        'testnet.json',
      ),
      AUTH_DOMAIN: 'localhost',
      LOG_LEVEL: 'info',
      WORKER_CONCURRENCY: '2',
      MPC_DEPOSIT_ATOMIC: '1',
      SOLVER_FEE_BPS: '0',
      RELAYER_ACCOUNT: relayer.account_id,
      RELAYER_PRIVATE_KEY: relayer.private_key,
      SOLVER_ACCOUNT: solver.account_id,
      SOLVER_PRIVATE_KEY: solver.private_key,
    };
    const env_path = join(release.folder, 'server.env');
    try {
      await private_text(
        release.folder,
        'server.env',
        Object.entries(env)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n') + `\nSOLVER_RECIPIENTS='${JSON.stringify(recipients)}'\n`,
      );
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
      const existing = await lstat(env_path);
      if (
        !existing.isFile() ||
        existing.isSymbolicLink() ||
        (existing.mode & 0o077) !== 0
      )
        throw new Error('Unsafe runtime environment permissions', {
          cause: error,
        });
    }
    release.journal.contracts.services = {
      pid: process.pid,
      redis_pid: redis.pid,
      mongo_uri,
      redis_url,
      environment_file: env_path,
      started_at: new Date().toISOString(),
    };
    await release.save();
    console.log(
      `Local Testnet services ready; private runtime configuration: ${env_path}`,
    );
    await new Promise<void>((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
      redis.once('exit', resolve);
    });
  } finally {
    redis_client.disconnect();
    redis.kill('SIGTERM');
    await mongo?.stop({ doCleanup: false, force: false });
  }
}
