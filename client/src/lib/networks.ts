import deployment from '@deployment';
import type { NetworkId } from '@/components/ui/network-icon';

const labels: Record<NetworkId, { name: string; testnet: string }> = {
  near: { name: 'NEAR', testnet: 'Testnet' },
  bitcoin: { name: 'Bitcoin', testnet: 'Testnet3' },
  solana: { name: 'Solana', testnet: 'Devnet' },
  base: { name: 'Base', testnet: 'Sepolia' },
  arbitrum: { name: 'Arbitrum', testnet: 'Sepolia' },
  bnb: { name: 'BNB Chain', testnet: 'Testnet' },
  polygon: { name: 'Polygon', testnet: 'Amoy' },
  avalanche: { name: 'Avalanche', testnet: 'Fuji' },
  hyperevm: { name: 'HyperEVM', testnet: 'Testnet' },
  sui: { name: 'Sui', testnet: 'Testnet' },
  starknet: { name: 'Starknet', testnet: 'Sepolia' },
};

export type SupportedNetwork = {
  id: NetworkId;
  name: string;
  testnet: string;
  family: string;
  evidence_url: string;
};

export const coordinator_url = `https://testnet.nearblocks.io/address/${deployment.near.coordinator}`;

const remote_networks: SupportedNetwork[] = deployment.chains
  .filter(
    ({ manifest, evidence }) => manifest.new_locks_enabled && evidence !== null,
  )
  .map(({ manifest, evidence }) => {
    if (!(manifest.chain_id in labels))
      throw new Error(`Missing network presentation: ${manifest.chain_id}`);
    const id = manifest.chain_id as NetworkId;
    return {
      id,
      ...labels[id],
      family: manifest.family,
      evidence_url: evidence!.record_url,
    };
  });

const order: NetworkId[] = [
  'near',
  'bitcoin',
  'solana',
  'base',
  'arbitrum',
  'bnb',
  'polygon',
  'avalanche',
  'hyperevm',
  'sui',
  'starknet',
];

export const networks = (
  [
    {
      id: 'near',
      ...labels.near,
      family: 'near',
      evidence_url: coordinator_url,
    },
    ...remote_networks,
  ] satisfies SupportedNetwork[]
).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
