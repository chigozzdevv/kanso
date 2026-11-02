export const NEAR_TESTNET_USDC =
  '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

export const networks = {
  near: { family: 'near', network: 'testnet' },
  bitcoin: {
    family: 'bitcoin',
    network: 'testnet3',
    fingerprint:
      '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943',
  },
  solana: { family: 'solana', network: 'devnet' },
  base: { family: 'evm', network: 'sepolia', chain_id: 84532 },
  arbitrum: { family: 'evm', network: 'sepolia', chain_id: 421614 },
  bnb: { family: 'evm', network: 'testnet', chain_id: 97 },
  polygon: { family: 'evm', network: 'amoy', chain_id: 80002 },
  avalanche: { family: 'evm', network: 'fuji', chain_id: 43113 },
  hyperevm: { family: 'evm', network: 'testnet', chain_id: 998 },
  sui: { family: 'sui', network: 'testnet' },
  starknet: {
    family: 'starknet',
    network: 'sepolia',
    fingerprint: 'SN_SEPOLIA',
  },
} as const;
export type ChainId = keyof typeof networks;
