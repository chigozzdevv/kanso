import { create_kanso } from '@kanso/sdk';
import { parse_deployment } from '@kanso/bindings';
import type { WalletResolver } from '@kanso/sdk';
import configuration from '@deployment';

export const deployment = parse_deployment(configuration);
export const apiUrl = process.env.NEXT_PUBLIC_KANSO_API_URL!;

export function createClient(wallets: WalletResolver) {
  return create_kanso({
    deployment,
    api_url: apiUrl,
    auth_domain: process.env.NEXT_PUBLIC_KANSO_AUTH_DOMAIN!,
    wallets,
  });
}
