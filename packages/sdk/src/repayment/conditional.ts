import type { ConditionalTerms } from '@kanso/schema';
import type { Context } from '@sdk/client/context';
export class ConditionalRepayment {
  constructor(
    private readonly c: Context,
    private readonly loan_id: string,
  ) {}
  async get() {
    return this.c.coordinator.view('get_conditional_repayment', {
      loan_id: this.loan_id,
    });
  }
  async review_update(terms: ConditionalTerms) {
    return this.c.http.request(
      'POST',
      `/v1/loans/${this.loan_id}/conditional-repayment/review`,
      { terms },
    );
  }
  async update(input: {
    terms: ConditionalTerms;
    expected_version: number;
    idempotency_key: string;
  }) {
    return this.c.prepare(
      {
        kind: 'conditional',
        loan_id: this.loan_id,
        terms: input.terms,
        expected_version: input.expected_version,
      },
      input.idempotency_key,
    );
  }
  private async toggle(enabled: boolean, idempotency_key: string) {
    const a = await this.get();
    if (!a)
      throw new Error('Configure conditional repayment before toggling it');
    return this.update({
      terms: { ...a.terms, enabled },
      expected_version: a.version,
      idempotency_key,
    });
  }
  async pause(input: { idempotency_key: string }) {
    return this.toggle(false, input.idempotency_key);
  }
  async enable(input: { idempotency_key: string }) {
    return this.toggle(true, input.idempotency_key);
  }
}
