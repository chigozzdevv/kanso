import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { KansoError } from '@kanso/schema';
import type { Runtime } from '@server/shared/runtime';
import { Queues } from '@server/shared/queue/queue.client';
import { KeeperService } from '@server/features/liquidation/liquidation.service';
import { reconcile_operation } from '@server/features/operation/operation.worker';
export async function start_workers(
  r: Runtime,
  redis_url: string,
  options: {
    concurrency?: number;
    tick_ms?: number;
    on_error?: (error: unknown) => void;
  } = {},
) {
  const queues = new Queues(redis_url);
  await queues.ready();
  const redis = new Redis(redis_url, { maxRetriesPerRequest: null });
  const indexer = r.indexer;
  const keeper = new KeeperService(r);
  let stopping = false;
  let ticking: Promise<void> | undefined;
  const worker = new Worker<{ operation_id: string }>(
    'kanso-operations',
    (job) => reconcile_operation(r, job.data.operation_id),
    { connection: redis, concurrency: options.concurrency ?? 4 },
  );
  worker.on('error', (error) => options.on_error?.(error));
  worker.on('failed', (_job, error) => {
    if (!(error instanceof KansoError && error.retryable))
      options.on_error?.(error);
  });
  function tick(): Promise<void> {
    if (stopping) return Promise.resolve();
    if (ticking) return ticking;
    ticking = (async () => {
      try {
        await queues.publish(r.repo);
        await indexer.tick();
        for (const error of await keeper.tick()) options.on_error?.(error);
      } catch (error) {
        options.on_error?.(error);
      } finally {
        ticking = undefined;
      }
    })();
    return ticking;
  }
  const timer = setInterval(() => void tick(), options.tick_ms ?? 3000);
  await worker.waitUntilReady();
  await tick();
  return {
    queues,
    worker,
    indexer,
    tick,
    async close() {
      stopping = true;
      clearInterval(timer);
      await ticking;
      await worker.close();
      await redis.quit();
      await queues.close();
    },
  };
}
