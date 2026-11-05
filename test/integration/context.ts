import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'near-api-js';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { NearAccount } from 'near-workspaces';
import { deployment } from '@kanso/schema';
import type { TransactionAction } from '@kanso/schema';
import { create_kanso } from '@kanso/sdk';
import type { WalletPort } from '@kanso/sdk';
import {
  build_app,
  create_runtime,
  connect_database,
  start_workers,
  nep413_message,
} from '@kanso/server';
import type { Runtime } from '@kanso/server';
type FastifyInstance = Awaited<ReturnType<typeof build_app>>;
import { create_sandbox } from '@test/sandbox/context';
export async function unused_port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No ephemeral port');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  return port;
}
export async function integration_context() {
  const sandbox = await create_sandbox();
  let mongo: MongoMemoryReplSet | undefined;
  const directory = await mkdtemp(join(tmpdir(), 'kanso-redis-'));
  const port = await unused_port();
  const redis = spawn(
    process.env.REDIS_SERVER_BIN ?? 'redis-server',
    [
      '--bind',
      '127.0.0.1',
      '--port',
      String(port),
      '--dir',
      directory,
      '--save',
      '',
      '--appendonly',
      'no',
    ],
    { stdio: 'pipe' },
  );
  let redis_error: Error | undefined;
  redis.on('error', (e) => {
    redis_error = e;
  });
  try {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.2.2' },
      instanceOpts: [{ launchTimeout: 60000 }],
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    if (redis_error) throw redis_error;
    const db = await connect_database(mongo.getUri());
    const d = deployment.parse({
      deployment_id: 'sandbox',
      network: 'sandbox',
      near: {
        rpc_url: sandbox.node.rpcUrl,
        coordinator: sandbox.coordinator.accountId,
        settlement_token: sandbox.token.accountId,
        settlement_decimals: 6,
      },
      pool_ids: ['sdk_pool'],
      chains: [],
    });
    const solver_key = await sandbox.lp.getKey();
    if (!solver_key) throw new Error('Missing local solver key');
    let runtime = await create_runtime({
      db,
      deployment: d,
      auth_domain: 'kanso.local.test',
      solver: {
        account_id: sandbox.lp.accountId,
        private_key: solver_key.toString(),
      },
    });
    let app = await build_app(runtime, { logger: false, rate_limit: 10000 });
    let workers = await start_workers(runtime, `redis://127.0.0.1:${port}`, {
      tick_ms: 500,
      on_error: (e) => {
        if (e instanceof Error && !e.message.includes('POOL_NOT_FOUND'))
          console.error(e.message);
      },
    });
    const fetcher = async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== 'http://kanso.local.test')
        return globalThis.fetch(input, init);
      const result = await app.inject({
        method: (init?.method ?? 'GET') as 'GET' | 'POST',
        url: url.pathname + url.search,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
      });
      return new Response(result.body, {
        status: result.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    };
    function near_wallet(
      account: NearAccount,
      options: { lose_reply?: () => boolean } = {},
    ): WalletPort<'near'> {
      return {
        family: 'near',
        accounts: async () => [
          { address: account.accountId, chain_id: 'near' },
        ],
        network: async () => d.network,
        prove_ownership: async (challenge) => {
          const key = await account.getKey();
          if (!key) throw new Error('Missing sandbox account key');
          return {
            public_key: key.getPublicKey().toString(),
            signature: utils.serialize.base_encode(
              key.sign(nep413_message(challenge)).signature,
            ),
          };
        },
        send_transaction: async (
          action: Extract<TransactionAction, { family: 'near' }>,
        ) => {
          if (action.signer_id !== account.accountId)
            throw new Error('Wrong signer');
          let id = '';
          for (const call of action.calls) {
            const result = await account.callRaw(
              action.receiver_id,
              call.method,
              call.args,
              { gas: BigInt(call.gas), attachedDeposit: BigInt(call.deposit) },
            );
            if (result.failed) throw new Error(result.summary());
            id = result.transactionReceipt.hash;
          }
          if (options.lose_reply?.())
            throw new Error('Connection lost after broadcast');
          return { transaction_id: id };
        },
      };
    }
    const client = (
      account: NearAccount,
      options: { lose_reply?: () => boolean } = {},
    ) =>
      create_kanso({
        deployment: d,
        api_url: 'http://kanso.local.test',
        fetch: fetcher,
        wallets: async (request) =>
          request.family === 'near' ? near_wallet(account, options) : undefined,
      });
    async function restart() {
      await workers.close();
      await app.close();
      runtime = await create_runtime({
        db,
        deployment: d,
        auth_domain: 'kanso.local.test',
        solver: {
          account_id: sandbox.lp.accountId,
          private_key: solver_key!.toString(),
        },
      });
      app = await build_app(runtime, { logger: false, rate_limit: 10000 });
      workers = await start_workers(runtime, `redis://127.0.0.1:${port}`, {
        tick_ms: 500,
        on_error: (e) => console.error(e instanceof Error ? e.message : e),
      });
    }
    return {
      sandbox,
      db,
      deployment: d,
      client,
      fetcher,
      get runtime(): Runtime {
        return runtime;
      },
      get app(): FastifyInstance {
        return app;
      },
      get workers() {
        return workers;
      },
      restart,
      async close() {
        await workers.close();
        await app.close();
        await db.close();
        await mongo!.stop();
        redis.kill('SIGTERM');
        await sandbox.node.tearDown();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    redis.kill('SIGTERM');
    await mongo?.stop();
    await sandbox.node.tearDown();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export type IntegrationContext = Awaited<
  ReturnType<typeof integration_context>
>;
