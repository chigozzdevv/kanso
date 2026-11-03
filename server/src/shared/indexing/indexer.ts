import { Schema } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import type { RuntimeOptions } from '@server/shared/runtime';
import type { CoordinatorClient } from '@kanso/sdk';
import type { OperationRepo } from '@server/features/operation/operation.repo';
import { KansoError } from '@kanso/schema';
import { scoped_id } from '@kanso/sdk';
import { projection_models } from '@server/features/loan/loan.model';
export class Indexer {
  readonly projections;
  readonly cursors;
  readonly events;
  constructor(
    private readonly db: Connection,
    private readonly r: {
      options: Pick<RuntimeOptions, 'deployment'>;
      coordinator: CoordinatorClient;
      repo: OperationRepo;
    },
  ) {
    this.projections = projection_models(db);
    this.cursors =
      (db.models.IndexCursor as Model<{ _id: string; finished: boolean }>) ??
      db.model(
        'IndexCursor',
        new Schema({ _id: String, finished: Boolean }, { versionKey: false }),
      );
    this.events =
      (db.models.ChainEvent as Model<{
        _id: string;
        deployment_id: string;
        object_id: string;
        event: string;
        revision: string;
        record: unknown;
        transaction_id: string;
        observed_at: Date;
      }>) ??
      db.model(
        'ChainEvent',
        new Schema(
          {
            _id: String,
            deployment_id: String,
            object_id: String,
            event: String,
            revision: String,
            record: Schema.Types.Mixed,
            transaction_id: String,
            observed_at: Date,
          },
          { versionKey: false },
        ),
      );
  }
  async initialize() {
    await Promise.all([
      this.projections.loans.init(),
      this.projections.pools.init(),
      this.cursors.init(),
      this.events.init(),
    ]);
  }
  async tick() {
    const d = this.r.options.deployment,
      deployment_id = d.deployment_id;
    const operations = await this.r.repo.model
      .find({ deployment_id })
      .select('snapshot.plan snapshot.steps snapshot.owner')
      .lean();
    const pool_ids = new Set([
        ...d.pool_ids,
        ...(await this.projections.pools.find({ deployment_id }).lean()).map(
          (p) => p.pool_id,
        ),
      ]),
      loan_ids = new Set(
        (await this.projections.loans.find({ deployment_id }).lean()).map(
          (l) => l.loan_id,
        ),
      );
    for (const row of operations) {
      const p = row.snapshot.plan;
      if ('pool_id' in p) pool_ids.add(p.pool_id);
      if ('loan_id' in p) loan_ids.add(p.loan_id);
      if (p.kind === 'setup') loan_ids.add(p.offer.offer_id);
      if (p.kind === 'settlement') loan_ids.add(p.plan.loan_id);
    }
    for (const pool_id of pool_ids) {
      const pool = await this.r.coordinator.maybe_view('get_pool', { pool_id });
      if (!pool) continue;
      for (const id of pool.loan_ids) loan_ids.add(id);
      await this.projections.pools.updateOne(
        { _id: scoped_id(deployment_id, pool_id) },
        { $set: { deployment_id, pool_id, record: pool } },
        { upsert: true },
      );
    }
    for (const loan_id of loan_ids) {
      const loan = await this.r.coordinator.maybe_view('get_loan', { loan_id });
      if (!loan) continue;
      const summary = await this.r.coordinator.view('loan_summary', {
        loan_id,
      });
      if (!pool_ids.has(loan.offer.pool_id)) {
        const pool = await this.r.coordinator.maybe_view('get_pool', {
          pool_id: loan.offer.pool_id,
        });
        if (pool)
          await this.projections.pools.updateOne(
            { _id: scoped_id(deployment_id, pool.pool_id) },
            { $set: { deployment_id, pool_id: pool.pool_id, record: pool } },
            { upsert: true },
          );
        pool_ids.add(loan.offer.pool_id);
      }
      await this.projections.loans.updateOne(
        { _id: scoped_id(deployment_id, loan_id) },
        {
          $set: {
            deployment_id,
            loan_id,
            borrower: loan.offer.borrower,
            record: loan,
            summary,
          },
        },
        { upsert: true },
      );
    }
    const seen = new Set<string>();
    for (const row of operations)
      for (const step of row.snapshot.steps)
        if (
          step.family === 'near' &&
          step.transaction_id &&
          !seen.has(step.transaction_id)
        ) {
          seen.add(step.transaction_id);
          try {
            await this.index_transaction(
              step.transaction_id,
              step.action?.signer_id ?? row.snapshot.owner,
            );
          } catch (e) {
            if (!(e instanceof KansoError && e.retryable)) throw e;
          }
        }
  }
  async index_transaction(transaction_id: string, signer_id: string) {
    const d = this.r.options.deployment;
    const cursor_id = scoped_id(d.deployment_id, transaction_id);
    if (await this.cursors.exists({ _id: cursor_id, finished: true })) return;
    const result = await this.r.coordinator.rpc.call<{
      status: unknown;
      receipts_outcome: { outcome: { executor_id: string; logs: string[] } }[];
    }>('tx', {
      tx_hash: transaction_id,
      sender_account_id: signer_id,
      wait_until: 'FINAL',
    });
    if (
      typeof result.status !== 'object' ||
      result.status === null ||
      !('SuccessValue' in result.status || 'Failure' in result.status)
    )
      return;
    await this.db.transaction(async (session) => {
      for (const receipt of result.receipts_outcome) {
        if (receipt.outcome.executor_id !== d.near.coordinator) continue;
        for (const log of receipt.outcome.logs) {
          if (!log.startsWith('EVENT_JSON:')) continue;
          const event = JSON.parse(log.slice(11)) as {
            standard: string;
            event: string;
            data: {
              event_id: string;
              deployment_id: string;
              object_id: string;
              revision: string;
              record: unknown;
            }[];
          };
          if (event.standard !== 'kanso') continue;
          for (const item of event.data) {
            if (item.deployment_id !== d.deployment_id) continue;
            await this.events.updateOne(
              { _id: item.event_id },
              {
                $setOnInsert: {
                  deployment_id: item.deployment_id,
                  object_id: item.object_id,
                  event: event.event,
                  revision: item.revision,
                  record: item.record,
                  transaction_id,
                  observed_at: new Date(),
                },
              },
              { upsert: true, session },
            );
          }
        }
      }
      await this.cursors.updateOne(
        { _id: cursor_id },
        { $set: { finished: true } },
        { upsert: true, session },
      );
    });
  }
  async activity(object_id: string, cursor?: string) {
    return this.events
      .find({
        deployment_id: this.r.options.deployment.deployment_id,
        object_id,
        ...(cursor ? { _id: { $gt: cursor } } : {}),
      })
      .sort({ _id: 1 })
      .limit(100)
      .lean();
  }
}
