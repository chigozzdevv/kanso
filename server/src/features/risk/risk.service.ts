import { KansoError, mul_div_floor, mul_div_ceil } from '@kanso/schema';
import type {
  BasketLeg,
  PoolPolicy,
  Deployment,
  ChainManifest,
} from '@kanso/schema';
import type { CoordinatorClient } from '@kanso/sdk';

export type PricedAsset = {
  asset_id: string;
  custody:
    | { family: 'near' }
    | { family: 'remote'; chain_id: string; manifest_version: number };
};

export class RiskService {
  private readonly manifests = new Map<string, ChainManifest>();
  constructor(
    private readonly d: Deployment,
    private readonly near: CoordinatorClient,
  ) {}
  async prices(legs: PricedAsset[]) {
    for (const l of legs)
      if (l.custody.family === 'remote') {
        const c = l.custody;
        const key = c.chain_id + ':' + c.manifest_version;
        if (!this.manifests.has(key))
          this.manifests.set(
            key,
            await this.near.view('get_chain_manifest', {
              chain_id: c.chain_id,
              version: c.manifest_version,
            }),
          );
      }
    const snapshot = await this.near.snapshot();
    const config = await this.near.view('get_config', {}, snapshot.block_id);
    const now = snapshot.now;
    const result = new Map<string, bigint>();
    for (const asset_id of new Set(legs.map((l) => l.asset_id))) {
      const p = await this.near.view(
        'get_asset_price',
        { asset_id },
        snapshot.block_id,
      );
      if (
        !p ||
        now < p.published_at ||
        now - p.published_at > config.max_price_age_seconds ||
        p.confidence_bps > config.max_confidence_bps
      )
        throw new KansoError(
          'PRICE_STALE',
          `No valid price for ${asset_id} (published=${p?.published_at}, observed=${now}, max_age=${config.max_price_age_seconds})`,
          true,
        );
      result.set(
        asset_id,
        mul_div_floor(
          BigInt(p.price_atomic),
          BigInt(10000 - p.confidence_bps),
          10000n,
        ),
      );
    }
    return result;
  }
  decimals(leg: PricedAsset) {
    const custody = leg.custody;
    const decimals =
      custody.family === 'near'
        ? 24
        : (
            this.manifests.get(
              custody.chain_id + ':' + custody.manifest_version,
            ) ??
            this.d.chains.find(
              (c) =>
                c.manifest.asset_id === leg.asset_id &&
                c.manifest.chain_id === custody.chain_id,
            )?.manifest
          )?.decimals;
    if (decimals === undefined)
      throw new KansoError('CAPABILITY_DISABLED', 'Unconfigured asset');
    return decimals;
  }
  value(leg: PricedAsset, amount: bigint, price: bigint) {
    return mul_div_floor(amount, price, 10n ** BigInt(this.decimals(leg)));
  }
  capacity(
    legs: BasketLeg[],
    policy: PoolPolicy,
    prices: Map<string, bigint>,
    liquidation = false,
  ) {
    const groups = new Map<string, { value: bigint; weighted: bigint }>();
    for (const leg of legs) {
      const custody = leg.custody;
      const value = this.value(
        leg,
        BigInt(leg.amount_atomic),
        prices.get(leg.asset_id)!,
      );
      let weight = liquidation
        ? policy.liquidation_threshold_bps
        : policy.ltv_bps;
      if (custody.family === 'remote') {
        const manifest =
          this.manifests.get(
            custody.chain_id + ':' + custody.manifest_version,
          ) ??
          this.d.chains.find(
            (c) =>
              c.manifest.chain_id === custody.chain_id &&
              c.manifest.version === custody.manifest_version,
          )?.manifest;
        if (!manifest)
          throw new KansoError(
            'CAPABILITY_DISABLED',
            'Unconfigured manifest version',
          );
        weight = Math.min(
          weight,
          liquidation ? manifest.liquidation_threshold_bps : manifest.ltv_bps,
        );
      }
      const group = groups.get(leg.asset_id) ?? { value: 0n, weighted: 0n };
      group.value += value;
      group.weighted += mul_div_floor(value, BigInt(weight), 10000n);
      groups.set(leg.asset_id, group);
    }
    let total = 0n;
    for (const [asset, g] of groups) {
      const cap = policy.asset_caps.find((c) => c.asset_id === asset);
      if (!cap)
        throw new KansoError(
          'INVALID_INPUT',
          'Asset is not eligible for this pool',
        );
      total +=
        g.value > BigInt(cap.max_collateral_value_atomic)
          ? mul_div_floor(
              g.weighted,
              BigInt(cap.max_collateral_value_atomic),
              g.value,
            )
          : g.weighted;
    }
    return total;
  }
  obligation(principal: string, policy: PoolPolicy) {
    const p = BigInt(principal);
    return (
      p +
      BigInt(policy.origination_fee_atomic) +
      mul_div_ceil(
        p,
        BigInt(policy.apr_bps) * BigInt(policy.interest_buffer_seconds),
        10000n * 31536000n,
      )
    );
  }
}
