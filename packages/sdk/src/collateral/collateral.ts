import type { BasketLeg } from '@kanso/schema';
import type { Context } from '@sdk/client/context';
export class Collateral {
  constructor(
    private readonly c: Context,
    private readonly loan_id: string,
  ) {}
  async top_up(input: { leg: BasketLeg; idempotency_key: string }) {
    return this.c.prepare(
      { kind: 'topup', loan_id: this.loan_id, leg: input.leg },
      input.idempotency_key,
    );
  }
  async review_withdrawal(input: { leg_id: string; amount_atomic: string }) {
    const loan = await this.c.coordinator.view('get_loan', {
      loan_id: this.loan_id,
    });
    return this.c.http.request(
      'POST',
      `/v1/loans/${this.loan_id}/collateral/withdraw/review`,
      { ...input, expected_revision: loan.revision },
    );
  }
  async withdraw(input: {
    leg_id: string;
    amount_atomic: string;
    expected_revision: string;
    idempotency_key: string;
  }) {
    return this.c.prepare(
      {
        kind: 'withdraw',
        loan_id: this.loan_id,
        leg_id: input.leg_id,
        amount_atomic: input.amount_atomic,
        expected_revision: input.expected_revision,
      },
      input.idempotency_key,
    );
  }
  async review_replacement(input: {
    incoming: BasketLeg;
    outgoing_leg_id: string;
    outgoing_amount_atomic: string;
  }) {
    return this.c.http.request(
      'POST',
      `/v1/loans/${this.loan_id}/collateral/replace/review`,
      input,
    );
  }
  async replace(input: {
    incoming: BasketLeg;
    outgoing_leg_id: string;
    outgoing_amount_atomic: string;
    expected_revision: string;
    idempotency_key: string;
  }) {
    const { idempotency_key, ...plan } = input;
    return this.c.prepare(
      { kind: 'replacement', loan_id: this.loan_id, ...plan },
      idempotency_key,
    );
  }
  async release(input: { leg_id: string; idempotency_key: string }) {
    return this.c.prepare(
      { kind: 'release', loan_id: this.loan_id, leg_id: input.leg_id },
      input.idempotency_key,
    );
  }
}
