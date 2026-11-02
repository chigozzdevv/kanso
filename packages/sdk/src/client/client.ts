import { operation_snapshot, loan_record, KansoError } from '@kanso/schema';
import type { PoolPolicy } from '@kanso/schema';
import type { BorrowInput } from '@sdk/types/client.types';
import type { KansoConfig } from '@sdk/client/config';
import { Context } from '@sdk/client/context';
import { Catalog } from '@sdk/catalog/catalog';
import { BorrowRequest } from '@sdk/request/request';
import { Loan } from '@sdk/loan/loan';
import { Pool } from '@sdk/pool/pool';
import { validate_checkpoint } from '@sdk/operation/checkpoint';
export function create_kanso(config: KansoConfig) {
  const c = new Context(config);
  const load = async (id: string) =>
    c.operation(
      operation_snapshot.parse(
        await c.http.request('GET', `/v1/operations/${id}`),
      ),
    );
  return {
    deployment: c.deployment,
    catalog: new Catalog(c),
    session: c.session,
    request: (input: BorrowInput) => new BorrowRequest(c, input),
    loan: (id: string) => new Loan(c, id),
    loans: {
      list: async () =>
        loan_record.array().parse(await c.http.request('GET', '/v1/loans')),
    },
    pool: (id: string) => new Pool(c, id),
    operation: load,
    operations: {
      resume: async (input: unknown) => {
        const checkpoint = validate_checkpoint(input, c.deployment);
        const op = await load(checkpoint.operation_id);
        const current = op.checkpoint();
        if (
          current.owner !== checkpoint.owner ||
          current.plan_hash !== checkpoint.plan_hash
        )
          throw new KansoError(
            'UNAUTHORIZED',
            'Checkpoint identity does not match canonical operation',
          );
        return op;
      },
    },
    pools: {
      review_create: async (input: { pool_id: string; policy: PoolPolicy }) =>
        c.http.request('POST', '/v1/pools/review', input),
      create: async (input: {
        pool_id: string;
        policy: PoolPolicy;
        idempotency_key: string;
      }) =>
        c.prepare(
          { kind: 'pool_create', pool_id: input.pool_id, policy: input.policy },
          input.idempotency_key,
        ),
    },
    storage: {
      withdraw: (input: { amount_atomic: string; idempotency_key: string }) =>
        c.prepare(
          { kind: 'storage_withdraw', amount_atomic: input.amount_atomic },
          input.idempotency_key,
        ),
      balance: (account_id: string) =>
        c.coordinator.view('storage_balance', { account_id }),
      deposit: async (input: {
        account_id: string;
        amount_atomic: string;
        idempotency_key: string;
      }) => {
        const owner = c.session.account_id;
        if (owner !== input.account_id)
          throw new KansoError(
            'FORBIDDEN',
            'Connect the storage funding account',
          );
        return c.prepare(
          { kind: 'storage_deposit', amount_atomic: input.amount_atomic },
          input.idempotency_key,
        );
      },
    },
    coordinator: c.coordinator,
  };
}
export type Kanso = ReturnType<typeof create_kanso>;
