import type { Deployment } from '@kanso/schema';
import type { WalletResolver } from '@sdk/types/wallet.types';
export interface KansoConfig {
  deployment: Deployment;
  api_url?: string;
  auth_domain?: string;
  wallets?: WalletResolver;
  fetch?: typeof fetch;
}
