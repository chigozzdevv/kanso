import type { Asset, ChainFamily } from '@kanso/schema';
import type { AnyWallet } from '@kanso/sdk';

export type ConnectedWallet = {
  family: ChainFamily;
  name: string;
  address: string;
  port: AnyWallet;
  balance: (asset: Asset) => Promise<string>;
  disconnect?: () => Promise<void>;
};

export type WalletChoice = {
  id: string;
  name: string;
  connect: () => Promise<ConnectedWallet>;
};

export const familyNames: Record<ChainFamily, string> = {
  near: 'NEAR',
  evm: 'EVM',
  solana: 'Solana',
  sui: 'Sui',
  starknet: 'Starknet',
  bitcoin: 'Bitcoin',
};
