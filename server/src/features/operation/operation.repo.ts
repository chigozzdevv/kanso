import { randomUUID } from 'node:crypto';
import type { Connection } from 'mongoose';
import { operation_snapshot, KansoError } from '@kanso/schema';
import type { OperationSnapshot } from '@kanso/schema';
import { operation_model } from '@server/features/operation/operation.model';
import { outbox_model } from '@server/shared/queue/outbox.model';
export class OperationRepo {
  readonly model;
  readonly outbox;
  constructor(private readonly db: Connection) {
    this.model = operation_model(db);
    this.outbox = outbox_model(db);
  }
  async initialize() {
    await Promise.all([this.model.init(), this.outbox.init()]);
  }
  async find(id: string): Promise<OperationSnapshot> {
    const r = await this.model.findById(id).lean();
    if (!r) throw new KansoError('NOT_FOUND', 'Operation not found');
    return operation_snapshot.parse(r.snapshot);
  }
  async create(
    snapshot: OperationSnapshot,
    key: string,
  ): Promise<OperationSnapshot> {
    try {
      await this.db.transaction(async (session) => {
        await this.model.create(
          [
            {
              _id: snapshot.operation_id,
              deployment_id: snapshot.deployment_id,
              owner: snapshot.owner,
              idempotency_key: key,
              plan_hash: snapshot.plan_hash,
              revision: 1,
              snapshot,
              lease_owner: null,
              lease_until: new Date(0),
              next_run_at: new Date(),
            },
          ],
          { session },
        );
        await this.outbox.create(
          [
            {
              operation_id: snapshot.operation_id,
              owner: snapshot.owner,
              deployment_id: snapshot.deployment_id,
              revision: 1,
              created_at: new Date(),
              published: false,
            },
          ],
          { session },
        );
      });
      return snapshot;
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 11000
      )
        throw error;
      const existing = await this.model
        .findOne({
          deployment_id: snapshot.deployment_id,
          owner: snapshot.owner,
          idempotency_key: key,
        })
        .lean();
      if (!existing || existing.plan_hash !== snapshot.plan_hash)
        throw new KansoError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key already belongs to another plan',
        );
      return operation_snapshot.parse(existing.snapshot);
    }
  }
  async update(
    snapshot: OperationSnapshot,
    expected_revision: string,
  ): Promise<OperationSnapshot> {
    const next = Number(expected_revision) + 1;
    if (!Number.isSafeInteger(next))
      throw new Error('Journal revision overflow');
    const updated = operation_snapshot.parse({
      ...snapshot,
      revision: String(next),
      updated_at: Math.floor(Date.now() / 1000),
    });
    await this.db.transaction(async (session) => {
      const result = await this.model.updateOne(
        { _id: snapshot.operation_id, revision: Number(expected_revision) },
        {
          $set: {
            snapshot: updated,
            revision: next,
            next_run_at: new Date(Date.now() + updated.next_poll_after_ms),
          },
        },
        { session },
      );
      if (!result.modifiedCount)
        throw new KansoError(
          'REVISION_CONFLICT',
          'Operation changed; reload its canonical snapshot',
          true,
        );
      await this.outbox.create(
        [
          {
            operation_id: snapshot.operation_id,
            owner: snapshot.owner,
            deployment_id: snapshot.deployment_id,
            revision: next,
            created_at: new Date(),
            published: false,
          },
        ],
        { session },
      );
    });
    return updated;
  }
  async claim(id: string) {
    const owner = randomUUID();
    const record = await this.model
      .findOneAndUpdate(
        { _id: id, lease_until: { $lt: new Date() } },
        {
          $set: {
            lease_owner: owner,
            lease_until: new Date(Date.now() + 60000),
          },
        },
        { returnDocument: 'after' },
      )
      .lean();
    return record
      ? { owner, snapshot: operation_snapshot.parse(record.snapshot) }
      : null;
  }
  async release(id: string, owner: string) {
    await this.model.updateOne(
      { _id: id, lease_owner: owner },
      { $set: { lease_owner: null, lease_until: new Date(0) } },
    );
  }
  async due(limit = 100) {
    const rows = await this.model
      .find({
        'snapshot.status': { $nin: ['succeeded', 'failed', 'cancelled'] },
        next_run_at: { $lte: new Date() },
        lease_until: { $lte: new Date() },
      })
      .limit(limit)
      .select('_id')
      .lean();
    return rows.map((r) => r._id);
  }
  async events(id: string, after?: string) {
    if (after && !/^[a-f0-9]{24}$/i.test(after))
      throw new KansoError('INVALID_INPUT', 'Invalid event cursor');
    const rows = await this.outbox
      .find({ operation_id: id, ...(after ? { _id: { $gt: after } } : {}) })
      .sort({ _id: 1 })
      .limit(100)
      .lean();
    return rows.map((x) => ({
      cursor: String(x._id),
      operation_id: x.operation_id,
      revision: String(x.revision),
      created_at: x.created_at.toISOString(),
    }));
  }
}
