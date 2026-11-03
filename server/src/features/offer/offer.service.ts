import { loan_offer, KansoError } from '@kanso/schema';
import type { Offer } from '@kanso/schema';
import { scoped_id } from '@kanso/sdk';
import type { CatalogService } from '@server/features/catalog/catalog.service';
import type { RiskService } from '@server/features/risk/risk.service';
import type { RequestService } from '@server/features/request/request.service';
export class OfferService {
  constructor(
    private readonly requests: RequestService,
    private readonly catalog: CatalogService,
    private readonly risk: RiskService,
  ) {}
  async offers(owner: string, id: string) {
    const r = await this.requests.get(owner, id);
    await this.requests.validate(owner, r.input);
    const prices = await this.risk.prices(r.input.basket);
    const pools = await this.catalog.pools();
    const offers: Offer[] = [],
      rejections: { pool_id: string; reason: string }[] = [];
    const now = await this.catalog.coordinator.now();
    for (const pool of pools) {
      try {
        const p = pool.policy;
        const input = r.input,
          principal = BigInt(input.loan_terms.principal_atomic);
        if (
          principal < BigInt(p.min_principal_atomic) ||
          principal > BigInt(p.max_principal_atomic) ||
          input.loan_terms.duration_seconds > p.max_duration_seconds
        )
          throw new Error('Requested terms are outside pool policy');
        if (input.basket.some((l) => !p.eligible_assets.includes(l.asset_id)))
          throw new Error('Pool does not accept every basket asset');
        if (
          this.risk.capacity(input.basket, p, prices) <
          this.risk.obligation(input.loan_terms.principal_atomic, p)
        )
          throw new Error('Insufficient conservative borrowing capacity');
        if (
          BigInt(
            await this.catalog.coordinator.view('pool_available_cash', {
              pool_id: pool.pool_id,
            }),
          ) < principal
        )
          throw new Error('Insufficient available pool liquidity');
        const price = prices.get('near') ?? 1n;
        const ttl = Math.min(120, p.setup_duration_seconds);
        const offer_id = scoped_id(
          id,
          pool.pool_id,
          String(p.version),
          String(Math.floor(now / 60)),
          ...[...prices.entries()].map(([a, v]) => `${a}:${v}`),
        );
        const existing = await this.requests.models.offers
          .findById(offer_id)
          .lean();
        const offer = existing
          ? loan_offer.parse(existing.offer)
          : loan_offer.parse({
              deployment_id: this.catalog.deployment.deployment_id,
              network: this.catalog.deployment.network,
              offer_id,
              pool_id: pool.pool_id,
              borrower: owner,
              payout_account: input.loan_terms.payout_account,
              policy_version: p.version,
              principal_atomic: input.loan_terms.principal_atomic,
              apr_bps: p.apr_bps,
              duration_seconds: input.loan_terms.duration_seconds,
              origination_fee_atomic: p.origination_fee_atomic,
              expires_at: now + ttl,
              setup_deadline: now + p.setup_duration_seconds,
              min_price_atomic: ((price * 99n) / 100n || 1n).toString(),
              max_price_atomic: ((price * 101n) / 100n + 1n).toString(),
              legs: input.basket,
            });
        if (offer.expires_at <= now)
          throw new Error('Offer expired; request refreshed prices');
        await this.requests.models.offers.updateOne(
          { _id: offer_id },
          { $setOnInsert: { request_id: id, owner, offer } },
          { upsert: true },
        );
        offers.push(offer);
      } catch (error) {
        rejections.push({
          pool_id: pool.pool_id,
          reason:
            error instanceof Error
              ? error.message
              : 'Pool rejected this basket',
        });
      }
    }
    return { offers, rejections };
  }
  async get(owner: string, id: string) {
    const record = await this.requests.models.offers.findById(id).lean();
    if (!record) throw new KansoError('NOT_FOUND', 'Offer not found');
    if (record.owner !== owner)
      throw new KansoError('FORBIDDEN', 'Offer belongs to another account');
    return {
      offer: loan_offer.parse(record.offer),
      request: await this.requests.get(owner, record.request_id),
    };
  }
}
