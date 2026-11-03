import { JsonRpc, starknet_auth_message } from '@kanso/sdk';
import type { WalletPort } from '@kanso/sdk';
import { deployment } from '@/lib/kanso';
import type { WalletChoice } from '@/lib/wallets/types';

export async function starknetChoices(): Promise<WalletChoice[]> {
  const { createStore } = await import('@starknet-io/get-starknet-core');
  const store = createStore();
  return store.getWallets().map((wallet) => ({
    id: wallet.features['starknet:walletApi'].id,
    name: wallet.name,
    connect: async () => {
      const response = await wallet.features['standard:connect'].connect();
      const account = response.accounts[0];
      if (!account) throw new Error('Select a Starknet account.');
      const request = wallet.features['starknet:walletApi'].request;
      const config = deployment.chains.find(
        (c) => c.manifest.family === 'starknet',
      )!;
      const port: WalletPort<'starknet'> = {
        family: 'starknet',
        accounts: async () =>
          wallet.accounts.map((a) => ({
            address: a.address,
            chain_id: 'starknet',
          })),
        network: async () => {
          const id = await request({ type: 'wallet_requestChainId' });
          return BigInt(id) === 0x534e5f5345504f4c4941n ? 'SN_SEPOLIA' : id;
        },
        prove_ownership: async (challenge) => ({
          signature: JSON.stringify(
            await request({
              type: 'wallet_signTypedData',
              params: starknet_auth_message(challenge.message),
            }),
          ),
        }),
        send_transaction: async (action) => ({
          transaction_id: (
            await request({
              type: 'wallet_addInvokeTransaction',
              params: {
                calls: action.calls.map((c) => ({
                  contract_address: c.contract_address,
                  entry_point: c.entrypoint,
                  calldata: c.calldata,
                })),
              },
            })
          ).transaction_hash,
        }),
      };
      return {
        family: 'starknet',
        name: wallet.name,
        address: account.address,
        port,
        disconnect: () => wallet.features['standard:disconnect'].disconnect(),
        balance: async (asset) => {
          const { hash } = await import('starknet');
          const result = await new JsonRpc(config.rpc_url).call<string[]>(
            'starknet_call',
            {
              request: {
                contract_address: asset.token_address,
                entry_point_selector: hash.getSelectorFromName('balance_of'),
                calldata: [account.address],
              },
              block_id: 'latest',
            },
          );
          return (
            BigInt(result[0]!) +
            (BigInt(result[1] ?? '0') << 128n)
          ).toString();
        },
      };
    },
  }));
}
