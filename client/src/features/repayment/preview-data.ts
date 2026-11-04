import type { Asset, RepaymentEstimate } from '@kanso/schema';
import { mul_div_ceil } from '@kanso/schema';
import type { RepaymentSource } from '@/features/repayment/form';

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
