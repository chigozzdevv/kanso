import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { OperationRepo } from '@server/features/operation/operation.repo';
export class Queues {
  readonly redis;
  readonly operations;
  constructor(url: string) {
    this.redis = new Redis(url, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    this.operations = new Queue('kanso-operations', {
      connection: this.redis,
      defaultJobOptions: {
        attempts: 10,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    });
  }
  async ready() {
    if (this.redis.status === 'wait') await this.redis.connect();
    await this.redis.ping();
  }
  async publish(repo: OperationRepo) {
    const records = await repo.outbox
      .find({ published: false })
      .sort({ _id: 1 })
      .limit(100)
      .lean();
    for (const record of records) {
      await this.operations.add(
        'reconcile',
        { operation_id: record.operation_id },
        { jobId: `${record.operation_id}-${record.revision}` },
      );
      await repo.outbox.updateOne(
        { _id: record._id, published: false },
        { $set: { published: true } },
      );
    }
    for (const id of await repo.due())
      await this.operations.add(
        'reconcile',
        { operation_id: id },
        { jobId: `${id}-tick-${Math.floor(Date.now() / 3000)}` },
      );
  }
  async close() {
    await this.operations.close();
    await this.redis.quit();
  }
}
