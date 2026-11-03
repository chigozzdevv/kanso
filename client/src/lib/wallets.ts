import type { ChainFamily } from '@kanso/schema';
import type { WalletChoice } from '@/lib/wallets/types';

export function isWalletRejection(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  return (
    code === 4001 ||
    code === 'USER_REJECTED' ||
    (error instanceof Error &&
      /user rejected|user denied|cancelled|canceled|modal closed/i.test(
        error.message,
      ))
  );
}

export async function walletChoices(
  family: Exclude<ChainFamily, 'near'>,
): Promise<WalletChoice[]> {
  switch (family) {
    case 'evm':
      return (await import('@/lib/wallets/evm')).evmChoices();
    case 'solana':
    case 'sui':
      return (await import('@/lib/wallets/standard')).standardChoices(family);
    case 'bitcoin':
      return (await import('@/lib/wallets/bitcoin')).bitcoinChoices();
    case 'starknet':
      return (await import('@/lib/wallets/starknet')).starknetChoices();
  }
}
