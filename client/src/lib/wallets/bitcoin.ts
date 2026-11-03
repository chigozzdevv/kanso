import type { WalletPort } from '@kanso/sdk';
import { deployment } from '@/lib/kanso';
import type { WalletChoice } from '@/lib/wallets/types';

interface Unisat {
  requestAccounts(): Promise<string[]>;
  getAccounts(): Promise<string[]>;
  getChain(): Promise<{ enum: string }>;
  switchChain(chain: string): Promise<unknown>;
  signMessage(message: string, type: 'bip322-simple'): Promise<string>;
  sendBitcoin(address: string, satoshis: number): Promise<string>;
  getBalance(): Promise<{ confirmed: number }>;
}

export function bitcoinChoices(): WalletChoice[] {
  const wallet = (window as Window & { unisat?: Unisat }).unisat;
  if (!wallet) return [];
  return [
    {
      id: 'unisat',
      name: 'UniSat',
      connect: async () => {
        if ((await wallet.getChain()).enum !== 'BITCOIN_TESTNET')
          await wallet.switchChain('BITCOIN_TESTNET');
        if ((await wallet.getChain()).enum !== 'BITCOIN_TESTNET')
          throw new Error('Switch your wallet to Bitcoin Testnet3.');
        const address = (await wallet.requestAccounts())[0];
        if (!address?.startsWith('tb1q'))
          throw new Error(
            'Select a native SegWit (P2WPKH) Bitcoin Testnet3 address.',
          );
        const fingerprint = deployment.chains.find(
          (c) => c.manifest.family === 'bitcoin',
        )!.manifest.network_fingerprint;
        const port: WalletPort<'bitcoin'> = {
          family: 'bitcoin',
          accounts: async () =>
            (await wallet.getAccounts()).map((address) => ({
              address,
              chain_id: 'bitcoin',
            })),
          network: async () =>
            (await wallet.getChain()).enum === 'BITCOIN_TESTNET'
              ? fingerprint
              : 'wrong-network',
          prove_ownership: async (challenge) => ({
            signature: await wallet.signMessage(
              challenge.message,
              'bip322-simple',
            ),
          }),
          send_transaction: async (action) => {
            const amount = Number(action.amount_atomic);
            if (!Number.isSafeInteger(amount))
              throw new Error('The amount exceeds the wallet limit.');
            return {
              transaction_id: await wallet.sendBitcoin(action.address, amount),
            };
          },
        };
        return {
          family: 'bitcoin',
          name: 'UniSat',
          address,
          port,
          balance: async () => {
            const { confirmed } = await wallet.getBalance();
            if (!Number.isSafeInteger(confirmed))
              throw new Error('The balance exceeds the wallet limit.');
            return String(confirmed);
          },
        };
      },
    },
  ];
}
