import { transactions } from 'near-api-js';
import { setTimeout as pause } from 'node:timers/promises';
import { json_request, NEAR_RPC, rpc } from '@testnet/network';
import {
  near_send,
  near_signer,
  near_view,
  reconcile_near,
  call,
} from '@testnet/deploy-near';
import { digest, Release } from '@testnet/deployment';

export function prune_confirmed_prices(release: Release, current: string) {
  for (const [id, record] of Object.entries(release.journal.effects)) {
    if (
      id.startsWith('oracle-') &&
      id !== 'oracle-storage' &&
      id !== current &&
      record.state === 'confirmed'
    )
      delete release.journal.effects[id];
  }
}

export const reference_assets: Record<string, string> = {
  near: 'near',
  base_eth: 'ethereum',
  arbitrum_eth: 'ethereum',
  bnb: 'binancecoin',
  pol: 'polygon-ecosystem-token',
  avax: 'avalanche-2',
  hype: 'hyperliquid',
  sol: 'solana',
  sui: 'sui',
  strk: 'starknet',
  btc: 'bitcoin',
};
export async function reference_prices() {
  const source =
    'https://api.coingecko.com/api/v3/simple/price?ids=' +
    [...new Set(Object.values(reference_assets))].join(',') +
    '&vs_currencies=usd&include_last_updated_at=true';
  const data =
    await json_request<
      Record<string, { usd: number; last_updated_at: number }>
    >(source);
  const now = Math.floor(Date.now() / 1000);
  return Object.fromEntries(
    Object.entries(reference_assets).map(([asset, id]) => {
      const value = data[id];
      if (
        !value ||
        !Number.isFinite(value.usd) ||
        value.usd <= 0 ||
        value.last_updated_at > now + 5 ||
        now - value.last_updated_at > 180
      )
        throw new Error(`Missing or stale reference price: ${asset}`);
      const price_atomic = BigInt(Math.floor(value.usd * 1_000_000)).toString();
      if (price_atomic === '0')
        throw new Error('Reference price below settlement precision');
      return [
        asset,
        {
          price_atomic,
          published_at: value.last_updated_at,
          confidence_bps: 100,
          source,
          reference_currency: 'USD',
          confidence_policy:
            'fixed 1% Testnet safety haircut; not a provider confidence interval',
        },
      ];
    }),
  );
}
export async function publish_prices(release: Release) {
  const coordinator = (await near_signer(release, 'coordinator')).accountId;
  const oracle = await near_signer(release, 'oracle');
  for (const [id, effect] of Object.entries(release.journal.effects)) {
    if (id.startsWith('oracle-') && effect.state === 'prepared')
      await reconcile_near(release, id, oracle.accountId);
  }
  if (!release.journal.effects['oracle-storage'])
    await near_send(release, 'oracle-storage', oracle, coordinator, [
      call('storage_deposit', {}, 500_000_000_000_000_000_000_000n),
    ]);
  const prices = await reference_prices();
  const chain_time = await rpc<{ header: { timestamp_nanosec: string } }>(
    NEAR_RPC,
    'block',
    { finality: 'final' },
  );
  const published_at = Number(
    BigInt(chain_time.header.timestamp_nanosec) / 1_000_000_000n,
  );
  const actions = [];
  for (const [asset, quote] of Object.entries(prices)) {
    const old = await near_view<{ sequence: number } | null>(
      coordinator,
      'get_asset_price',
      { asset_id: asset },
    );
    const sequence = Math.max(old?.sequence ?? 0, published_at) + 1;
    actions.push(
      transactions.functionCall(
        'publish_asset_price',
        {
          asset_id: asset,
          price: {
            price_atomic: quote.price_atomic,
            published_at: Math.min(quote.published_at, published_at),
            confidence_bps: quote.confidence_bps,
            sequence,
          },
        },
        15_000_000_000_000n,
        0n,
      ),
    );
  }
  const id =
    'oracle-' +
    digest(
      JSON.stringify(actions, (_, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).slice(0, 24);
  const effect = await near_send(release, id, oracle, coordinator, actions);
  release.journal.contracts.oracle = {
    prices,
    near_transaction: effect.transaction_id,
    verified_at: new Date().toISOString(),
  };
  prune_confirmed_prices(release, id);
  await release.save();
  return prices;
}

export async function watch_prices() {
  let stopping = false;
  process.once('SIGINT', () => {
    stopping = true;
  });
  process.once('SIGTERM', () => {
    stopping = true;
  });
  while (!stopping) {
    try {
      const release = await Release.load('deployment-oracle.json');
      await release.lock(() => publish_prices(release));
    } catch (error) {
      console.error(
        `${new Date().toISOString()}: oracle refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!stopping) await pause(90000);
  }
}

export async function refresh_prices() {
  const oracle = await Release.load('deployment-oracle.json');
  const coordinator = (await near_signer(oracle, 'coordinator')).accountId;
  const price = await near_view<{ published_at: number }>(
    coordinator,
    'get_asset_price',
    { asset_id: 'near' },
  );
  if (price && Date.now() / 1000 - price.published_at < 90) return;
  try {
    await oracle.lock(() => publish_prices(oracle));
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'EEXIST' &&
      price &&
      Date.now() / 1000 - price.published_at < 180
    )
      return;
    throw error;
  }
}
