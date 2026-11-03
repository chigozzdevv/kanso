import { getWallets } from '@wallet-standard/app';
import bs58 from 'bs58';
import { JsonRpc, unbase64 } from '@kanso/sdk';
import type { WalletPort } from '@kanso/sdk';
import { deployment } from '@/lib/kanso';
import type { WalletChoice } from '@/lib/wallets/types';

type StandardWallet = ReturnType<ReturnType<typeof getWallets>['get']>[number];
type Account = StandardWallet['accounts'][number];
type CommonFeatures = {
  'standard:connect': {
    connect: () => Promise<{ accounts: readonly Account[] }>;
  };
  'standard:disconnect'?: { disconnect: () => Promise<void> };
};
type SolanaFeatures = CommonFeatures & {
  'solana:signMessage': {
    signMessage: (input: {
      account: Account;
      message: Uint8Array;
    }) => Promise<{ signature: Uint8Array }[]>;
  };
  'solana:signAndSendTransaction': {
    signAndSendTransaction: (input: {
      account: Account;
      chain: 'solana:devnet';
      transaction: Uint8Array;
      options: { preflightCommitment: 'confirmed' };
    }) => Promise<{ signature: Uint8Array }[]>;
  };
};
type SuiFeatures = CommonFeatures & {
  'sui:signPersonalMessage': {
    signPersonalMessage: (input: {
      account: Account;
      message: Uint8Array;
    }) => Promise<{ signature: string }>;
  };
  'sui:signAndExecuteTransaction': {
    signAndExecuteTransaction: (input: {
      account: Account;
      chain: 'sui:testnet';
      transaction: { toJSON: () => Promise<string> };
    }) => Promise<{ digest: string }>;
  };
};

export function standardChoices(family: 'solana' | 'sui'): WalletChoice[] {
  const chain =
    `${family}:${family === 'solana' ? 'devnet' : 'testnet'}` as const;
  return getWallets()
    .get()
    .filter(
      (w) =>
        w.chains.includes(chain) &&
        'standard:connect' in w.features &&
        (family === 'solana'
          ? 'solana:signMessage' in w.features &&
            'solana:signAndSendTransaction' in w.features
          : 'sui:signPersonalMessage' in w.features &&
            'sui:signAndExecuteTransaction' in w.features),
    )
    .map((wallet) => ({
      id: wallet.name,
      name: wallet.name,
      connect: async () => {
        const features = wallet.features as unknown as CommonFeatures;
        const response = await features['standard:connect'].connect();
        const account = response.accounts.find((a) => a.chains.includes(chain));
        if (!account) throw new Error(`Select an account supporting ${chain}.`);
        const config = deployment.chains.find(
          (c) => c.manifest.family === family,
        )!;
        const accounts = async () =>
          wallet.accounts
            .filter((a) => a.chains.includes(chain))
            .map((a) => ({ address: a.address, chain_id: family }));
        if (family === 'solana') {
          const solana = wallet.features as unknown as SolanaFeatures;
          const rpc = new JsonRpc(config.rpc_url);
          const port: WalletPort<'solana'> = {
            family,
            accounts,
            network: () => rpc.call<string>('getGenesisHash', []),
            prove_ownership: async (challenge) => {
              const result = await solana['solana:signMessage'].signMessage({
                account,
                message: new TextEncoder().encode(challenge.message),
              });
              if (!result[0])
                throw new Error('The wallet returned no signature.');
              return { signature: bs58.encode(result[0].signature) };
            },
            send_transaction: async (action) => {
              const result = await solana[
                'solana:signAndSendTransaction'
              ].signAndSendTransaction({
                account,
                chain: 'solana:devnet',
                transaction: unbase64(action.transaction),
                options: { preflightCommitment: 'confirmed' },
              });
              if (!result[0])
                throw new Error('The wallet returned no transaction.');
              return { transaction_id: bs58.encode(result[0].signature) };
            },
          };
          return {
            family,
            name: wallet.name,
            address: account.address,
            port,
            balance: async () => {
              const result = await rpc.call<{ value: number }>('getBalance', [
                account.address,
                { commitment: 'confirmed' },
              ]);
              if (!Number.isSafeInteger(result.value))
                throw new Error(
                  'Wallet balance exceeds the RPC integer limit.',
                );
              return String(result.value);
            },
            ...(features['standard:disconnect']
              ? {
                  disconnect: () =>
                    features['standard:disconnect']!.disconnect(),
                }
              : {}),
          };
        }
        const sui = wallet.features as unknown as SuiFeatures;
        const { SuiGrpcClient } = await import('@mysten/sui/grpc');
        const rpc = new SuiGrpcClient({
          baseUrl: config.rpc_url,
          network: 'testnet',
        });
        const port: WalletPort<'sui'> = {
          family: 'sui',
          accounts,
          network: async () =>
            (await rpc.core.getChainIdentifier()).chainIdentifier,
          prove_ownership: async (challenge) => ({
            signature: (
              await sui['sui:signPersonalMessage'].signPersonalMessage({
                account,
                message: new TextEncoder().encode(challenge.message),
              })
            ).signature,
          }),
          send_transaction: async (action) => {
            const { Transaction } = await import('@mysten/sui/transactions');
            const result = await sui[
              'sui:signAndExecuteTransaction'
            ].signAndExecuteTransaction({
              account,
              chain: 'sui:testnet',
              transaction: Transaction.from(action.transaction),
            });
            return { transaction_id: result.digest };
          },
        };
        return {
          family: 'sui',
          name: wallet.name,
          address: account.address,
          port,
          balance: async () =>
            (
              await rpc.core.getBalance({
                owner: account.address,
                coinType: '0x2::sui::SUI',
              })
            ).balance.balance,
          ...(features['standard:disconnect']
            ? {
                disconnect: () => features['standard:disconnect']!.disconnect(),
              }
            : {}),
        };
      },
    }));
}
