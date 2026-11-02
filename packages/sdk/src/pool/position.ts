import type { Context } from '@sdk/client/context';
export class Position {
  constructor(
    private readonly c: Context,
    private readonly pool_id: string,
    private readonly account_id: string,
  ) {}
  async summary() {
    return this.c.coordinator.view('get_position', {
      pool_id: this.pool_id,
      account_id: this.account_id,
    });
  }
  async request_withdrawal(input: { shares: string; idempotency_key: string }) {
    return this.c.prepare(
      { kind: 'lp_withdrawal', pool_id: this.pool_id, shares: input.shares },
      input.idempotency_key,
    );
  }
  async claim_withdrawal(input: {
    withdrawal_id: string;
    idempotency_key: string;
  }) {
    return this.c.prepare(
      { kind: 'withdrawal_claim', withdrawal_id: input.withdrawal_id },
      input.idempotency_key,
    );
  }
  async cancel_withdrawal(input: {
    withdrawal_id: string;
    idempotency_key: string;
  }) {
    return this.c.prepare(
      { kind: 'withdrawal_cancel', withdrawal_id: input.withdrawal_id },
      input.idempotency_key,
    );
  }
}
