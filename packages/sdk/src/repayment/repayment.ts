import {
  operation_plan,
  repayment_estimate,
  repayment_estimate_input,
} from '@kanso/schema';
import type {
  BasketLeg,
  OperationPlan,
  RepaymentEstimateInput,
} from '@kanso/schema';
import { build_leg } from '@sdk/basket/basket';
import type { AssetInput } from '@sdk/types/client.types';
import { KansoError } from '@kanso/schema';
import type { Context } from '@sdk/client/context';
export class Repayment {
  constructor(
    private readonly c: Context,
    private readonly loan_id: string,
  ) {}
  async prepare_wallet_input(input: {
    asset: AssetInput;
    payment_id: string;
    idempotency_key: string;
  }) {
    const owner = this.c.session.account_id;
    if (!owner)
      throw new KansoError('UNAUTHORIZED', 'Connect the repayment account');
    const leg_id = await this.c.coordinator.view('wallet_payment_leg_id', {
      loan_id: this.loan_id,
      payer: owner,
      payment_id: input.payment_id,
    });
    const leg = await build_leg(
      this.c,
      input.asset,
      owner,
      leg_id,
      input.payment_id,
    );
    return this.create_wallet_input({
      payment_id: input.payment_id,
      leg,
      idempotency_key: input.idempotency_key,
    });
  }
  async create_wallet_input(input: {
    payment_id: string;
    leg: BasketLeg;
    idempotency_key: string;
  }) {
    return this.c.prepare(
      {
        kind: 'wallet_payment',
        loan_id: this.loan_id,
        payment_id: input.payment_id,
        leg: input.leg,
      },
      input.idempotency_key,
    );
  }
  async refund_wallet_input(input: {
    leg_id: string;
    idempotency_key: string;
  }) {
    return this.c.prepare(
      { kind: 'payment_refund', loan_id: this.loan_id, leg_id: input.leg_id },
      input.idempotency_key,
    );
  }
  async quote(input: Record<string, unknown>) {
    return this.c.http.request(
      'POST',
      `/v1/loans/${this.loan_id}/repayment/quote`,
      input,
    );
  }
  async estimate(input: RepaymentEstimateInput) {
    return repayment_estimate.parse(
      await this.c.http.request(
        'POST',
        `/v1/loans/${this.loan_id}/repayment/estimate`,
        repayment_estimate_input.parse(input),
      ),
    );
  }
  async review(
    input:
      | { mode: 'direct'; amount_atomic: string }
      | {
          mode: 'collateral';
          leg_id: string;
          input_atomic: string;
          max_execution_cost_atomic: string;
        }
      | {
          mode: 'wallet';
          leg_id: string;
          input_atomic: string;
          max_execution_cost_atomic: string;
        },
  ): Promise<{ plan: OperationPlan; plan_hash: string; expires_at: number }> {
    return this.c.http.request(
      'POST',
      `/v1/loans/${this.loan_id}/repayment/review`,
      input,
    );
  }
  async execute(input: {
    review: { plan: OperationPlan; plan_hash: string };
    idempotency_key: string;
  }) {
    return this.c.operation(
      await this.c.http.request(
        'POST',
        `/v1/loans/${this.loan_id}/repayment/prepare`,
        {
          ...input,
          review: {
            plan: operation_plan.parse(input.review.plan),
            plan_hash: input.review.plan_hash,
          },
        },
      ),
      input.review.plan,
    );
  }
}
