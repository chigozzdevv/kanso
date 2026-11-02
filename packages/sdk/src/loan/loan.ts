import type { Context } from '@sdk/client/context';
import { Collateral } from '@sdk/collateral/collateral';
import { Repayment } from '@sdk/repayment/repayment';
import { ConditionalRepayment } from '@sdk/repayment/conditional';
import { delay } from '@sdk/transport/codec';
export class Loan {
  readonly collateral;
  readonly repayment;
  readonly conditional_repayment;
  constructor(
    private readonly c: Context,
    readonly loan_id: string,
  ) {
    this.collateral = new Collateral(c, loan_id);
    this.repayment = new Repayment(c, loan_id);
    this.conditional_repayment = new ConditionalRepayment(c, loan_id);
  }
  async summary() {
    return this.c.coordinator.view('loan_summary', { loan_id: this.loan_id });
  }
  async record() {
    return this.c.coordinator.view('get_loan', { loan_id: this.loan_id });
  }
  async activity(cursor?: string): Promise<unknown> {
    return this.c.http.request(
      'GET',
      `/v1/loans/${this.loan_id}/activity${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
    );
  }
  async repay(input: Parameters<Repayment['execute']>[0]) {
    return this.repayment.execute(input);
  }
  subscribe(
    listener: (summary: Awaited<ReturnType<Loan['summary']>>) => void,
    on_error?: (error: unknown) => void,
  ): () => void {
    const controller = new AbortController();
    void (async () => {
      try {
        while (!controller.signal.aborted) {
          listener(await this.summary());
          await delay(3000, controller.signal);
        }
      } catch (e) {
        if (!controller.signal.aborted) on_error?.(e);
      }
    })();
    return () => controller.abort();
  }
}
