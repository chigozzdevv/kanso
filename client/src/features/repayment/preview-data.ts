import type {
  Asset,
  RepaymentEstimate,
  BasketRepaymentQuote,
} from '@kanso/schema';
import { mul_div_ceil } from '@kanso/schema';
import type { RepaymentSource } from '@/features/repayment/form';
import { parseAmount } from '@/lib/amounts';

export const previewAssets: Asset[] = [
  {
    asset_id: 'near',
    chain_id: 'near',
    family: 'near',
    symbol: 'NEAR',
    decimals: 24,
    network_fingerprint: 'testnet',
    token_address: null,
    enabled: true,
    reason: null,
  },
  {
    asset_id: 'solana',
    chain_id: 'solana',
    family: 'solana',
    symbol: 'SOL',
    decimals: 9,
    network_fingerprint: 'devnet',
    token_address: null,
    enabled: true,
    reason: null,
  },
  {
    asset_id: 'base',
    chain_id: 'base',
    family: 'evm',
    symbol: 'ETH',
    decimals: 18,
    network_fingerprint: '84532',
    token_address: null,
    enabled: true,
    reason: null,
  },
  {
    asset_id: 'bitcoin',
    chain_id: 'bitcoin',
    family: 'bitcoin',
    symbol: 'BTC',
    decimals: 8,
    network_fingerprint: 'testnet3',
    token_address: null,
    enabled: true,
    reason: null,
  },
];

export const previewSources: RepaymentSource[] = previewAssets.map((asset) => ({
  legId: `preview_${asset.asset_id}`,
  assetId: asset.asset_id,
  purpose: 'collateral',
}));

export const previewBalances = ['300', '5', '0.4', '0.005'];
const previewPrices: Record<string, bigint> = {
  near: 5000000n,
  solana: 160000000n,
  base: 2500000000n,
  bitcoin: 100000000000n,
};

export function previewEstimate(
  asset: Asset,
  amount: string,
  mode: 'wallet' | 'collateral',
): RepaymentEstimate {
  const fee = mul_div_ceil(BigInt(amount), 25n, 10000n);
  const scale = 10n ** BigInt(asset.decimals);
  const price = previewPrices[asset.asset_id]!;
  const input = mul_div_ceil(BigInt(amount) + fee, scale, price);
  return {
    mode,
    loan_id: 'preview',
    leg_id: mode === 'collateral' ? `preview_${asset.asset_id}` : null,
    asset_id: asset.asset_id,
    chain_id: asset.chain_id,
    decimals: asset.decimals,
    amount_atomic: amount,
    input_atomic: input.toString(),
    net_output_atomic: ((input * price) / scale - fee).toString(),
    execution_cost_atomic: fee.toString(),
    max_source_fee_atomic: '0',
    expires_at: Math.floor(Date.now() / 1000) + 120,
  };
}

export function previewBasket(amount: string): BasketRepaymentQuote {
  const sources = previewAssets
    .map((asset, index) => {
      const available = parseAmount(previewBalances[index]!, asset.decimals);
      return {
        leg_id: `preview_${asset.asset_id}`,
        asset_id: asset.asset_id,
        chain_id: asset.chain_id,
        decimals: asset.decimals,
        available_atomic: available,
        value_atomic: (
          (BigInt(available) * previewPrices[asset.asset_id]!) /
          10n ** BigInt(asset.decimals)
        ).toString(),
      };
    })
    .sort((a, b) => (BigInt(a.value_atomic) > BigInt(b.value_atomic) ? -1 : 1));
  let remaining = BigInt(amount);
  const allocations = [];
  for (const source of sources) {
    if (!remaining) break;
    const maximum = (BigInt(source.value_atomic) * 10000n) / 10025n;
    const target = remaining < maximum ? remaining : maximum;
    const asset = previewAssets.find(
      (item) => item.asset_id === source.asset_id,
    )!;
    const estimate = previewEstimate(asset, target.toString(), 'collateral');
    allocations.push({
      ...estimate,
      mode: 'collateral' as const,
      leg_id: source.leg_id,
    });
    remaining -= target;
  }
  if (remaining)
    throw new Error('The example basket cannot cover this repayment.');
  return {
    loan_id: 'preview',
    amount_atomic: amount,
    basket_value_atomic: sources
      .reduce((sum, source) => sum + BigInt(source.value_atomic), 0n)
      .toString(),
    execution_cost_atomic: allocations
      .reduce(
        (sum, allocation) => sum + BigInt(allocation.execution_cost_atomic),
        0n,
      )
      .toString(),
    net_output_atomic: allocations
      .reduce(
        (sum, allocation) => sum + BigInt(allocation.net_output_atomic),
        0n,
      )
      .toString(),
    expires_at: Math.floor(Date.now() / 1000) + 120,
    sources,
    allocations,
  };
}
