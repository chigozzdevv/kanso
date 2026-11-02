import {
  borrowing_request,
  offer_response,
  request_record,
  KansoError,
} from '@kanso/schema';
import type { BorrowingRequest, RequestRecord, Offer } from '@kanso/schema';
import type { Context } from '@sdk/client/context';
import type { BorrowInput } from '@sdk/types/client.types';
import { build_leg } from '@sdk/basket/basket';
import { delay } from '@sdk/transport/codec';
export class BorrowRequest {
  private selected_offers: Offer[] = [];
  private committed: BorrowingRequest | undefined;
  private record: RequestRecord | undefined;
  private readonly identity = globalThis.crypto.randomUUID();
  constructor(
    private readonly context: Context,
    readonly input: BorrowInput,
  ) {}
  async connect_required_wallets(): Promise<void> {
    if (this.committed) return;
    const wallet = await this.context.wallets.get(
      'near',
      'near',
      this.input.borrower,
    );
    const account = (await wallet.accounts()).find(
      (x) =>
        x.chain_id === 'near' &&
        (!this.input.borrower || x.address === this.input.borrower),
    );
    if (!account)
      throw new KansoError('WALLET_REQUIRED', 'Select a NEAR borrower account');
    await this.context.session.connect(account.address);
    const legs = [];
    for (const [index, asset] of this.input.basket.entries()) {
      const leg_id =
        this.input.basket.filter((x) => x.asset_id === asset.asset_id)
          .length === 1
          ? asset.asset_id
          : `${asset.asset_id}_${index}`;
      legs.push(
        await build_leg(
          this.context,
          asset,
          account.address,
          leg_id,
          this.identity,
        ),
      );
    }
    const authorization = this.input.conditional_repayment;
    this.committed = borrowing_request.parse({
      basket: legs,
      loan_terms: this.input.loan_terms,
      conditional_repayment:
        authorization && 'trigger_health_ppm' in authorization
          ? authorization
          : null,
    });
  }
  private async ready(): Promise<BorrowingRequest> {
    await this.connect_required_wallets();
    return this.committed!;
  }
  async review(): Promise<unknown> {
    return this.context.http.request(
      'POST',
      '/v1/baskets/review',
      await this.ready(),
    );
  }
  private async persisted(): Promise<RequestRecord> {
    this.record ??= request_record.parse(
      await this.context.http.request(
        'POST',
        '/v1/requests',
        await this.ready(),
      ),
    );
    return this.record;
  }
  async offers() {
    const r = await this.persisted();
    const response = offer_response.parse(
      await this.context.http.request(
        'GET',
        `/v1/requests/${r.request_id}/offers`,
      ),
    );
    this.selected_offers = response.offers;
    return response;
  }
  async accept(input: { offer_id: string; idempotency_key: string }) {
    await this.persisted();
    if (!this.selected_offers.length) await this.offers();
    const offer = this.selected_offers.find(
      (o) => o.offer_id === input.offer_id,
    );
    if (!offer)
      throw new KansoError(
        'INVALID_INPUT',
        'Offer was not reviewed for this request',
      );
    const op = this.context.operation(
      await this.context.http.request(
        'POST',
        `/v1/offers/${input.offer_id}/accept/prepare`,
        { idempotency_key: input.idempotency_key },
      ),
      {
        kind: 'setup',
        offer,
        conditional_repayment: this.committed!.conditional_repayment,
      },
    );
    const end = Date.now() + 120000;
    let dispatched = false;
    for (;;) {
      const s = await op.snapshot();
      if (
        s.steps.some((x) => x.step_id === 'accept' && x.state === 'confirmed')
      )
        return op;
      if (
        !dispatched &&
        s.steps.some(
          (x) => x.step_id === 'accept' && x.state === 'pending' && x.action,
        )
      ) {
        dispatched = true;
        await op.execute({ max_steps: 1 });
        continue;
      }
      if (s.status === 'failed' || Date.now() >= end)
        throw new KansoError(
          'BROADCAST_UNKNOWN',
          `Acceptance is unresolved; resume operation ${op.operation_id}`,
          true,
          op.operation_id,
        );
      await delay(s.next_poll_after_ms);
    }
  }
}
