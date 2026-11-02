import type { PoolPolicy } from '@kanso/schema';
import type { Context } from '@sdk/client/context';
import { Position } from '@sdk/pool/position';
export class Pool {
  constructor(
    private readonly c: Context,
    readonly pool_id: string,
  ) {}
  async summary() {
    const [pool, nav, available_cash] = await Promise.all([
      this.c.coordinator.view('get_pool', { pool_id: this.pool_id }),
      this.c.coordinator.view('pool_nav', { pool_id: this.pool_id }),
      this.c.coordinator.view('pool_available_cash', { pool_id: this.pool_id }),
    ]);
    return { pool, nav_atomic: nav, available_cash_atomic: available_cash };
  }
  async policy() {
    return (
      await this.c.coordinator.view('get_pool', { pool_id: this.pool_id })
    ).policy;
  }
  async activity(): Promise<unknown> {
    return this.c.http.request('GET', `/v1/pools/${this.pool_id}/activity`);
  }
  position(account_id: string) {
    return new Position(this.c, this.pool_id, account_id);
  }
  async deposit(input: { amount_atomic: string; idempotency_key: string }) {
    return this.c.prepare(
      {
        kind: 'pool_deposit',
        pool_id: this.pool_id,
        amount_atomic: input.amount_atomic,
      },
      input.idempotency_key,
    );
  }
  async recognize_loss(input: {
    loan_id: string;
    expected_revision: string;
    idempotency_key: string;
  }) {
    const loan = await this.c.coordinator.view('get_loan', {
      loan_id: input.loan_id,
    });
    if (loan.offer.pool_id !== this.pool_id)
      throw new Error('Loan belongs to another pool');
    return this.c.prepare(
      {
        kind: 'loss_recognition',
        loan_id: input.loan_id,
        expected_revision: input.expected_revision,
      },
      input.idempotency_key,
    );
  }
  async update_policy(input: { policy: PoolPolicy; idempotency_key: string }) {
    return this.c.prepare(
      { kind: 'pool_policy', pool_id: this.pool_id, policy: input.policy },
      input.idempotency_key,
    );
  }
}
