import bs58 from 'bs58';
import { z } from 'zod';
import { JsonRpc, JsonRpcError, from_hex, unbase64 } from '@kanso/sdk';
import type { WalletPort } from '@kanso/sdk';
import type { NearConnector } from '@hot-labs/near-connect';
import { deployment } from '@/lib/kanso';
import type { ConnectedWallet } from '@/lib/wallets/types';

let connector: Promise<NearConnector> | undefined;

const unknownAccount = z.object({
  cause: z.object({
    name: z.literal('UNKNOWN_ACCOUNT'),
    info: z.object({ requested_account_id: z.string() }),
  }),
});

export async function nearBalance(accountId: string): Promise<string> {
  try {
    const state = await new JsonRpc(deployment.near.rpc_url).call<{
      amount: string;
      locked: string;
      storage_usage: number;
    }>('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    const storage = BigInt(state.storage_usage) * 10n ** 19n;
    const available = BigInt(state.amount) - storage;
    return (available > 0n ? available : 0n).toString();
  } catch (error) {
    if (error instanceof JsonRpcError && /^[a-f0-9]{64}$/.test(accountId)) {
      const missing = unknownAccount.safeParse(error.fault);
      // Implicit accounts are created on-chain by their first funding transfer.
      if (
        missing.success &&
        missing.data.cause.info.requested_account_id === accountId
      )
        return '0';
    }
    throw error;
  }
}

export async function connectNear(): Promise<ConnectedWallet> {
  connector ??= import('@hot-labs/near-connect').then(
    ({ NearConnector }) =>
      new NearConnector({
        network: 'testnet',
        autoConnect: false,
        providers: { testnet: [deployment.near.rpc_url] },
        features: {
          signMessage: true,
          signAndSendTransaction: true,
          testnet: true,
        },
      }),
  );
  const selector = await connector;
  const wallet = await selector.connect();
  const account = (await wallet.getAccounts({ network: 'testnet' }))[0];
  if (!account) throw new Error('Select a NEAR Testnet account.');
  const port: WalletPort<'near'> = {
    family: 'near',
    accounts: async () =>
      (await wallet.getAccounts({ network: 'testnet' })).map((a) => ({
        address: a.accountId,
        chain_id: 'near',
      })),
    network: async () => selector.network,
    prove_ownership: async (challenge) => {
      const result = await wallet.signMessage({
        message: challenge.message,
        nonce: from_hex(challenge.nonce),
        recipient: challenge.domain,
        signerId: challenge.address,
        network: 'testnet',
      });
      if (result.accountId !== challenge.address)
        throw new Error('The signing account changed. Reconnect your wallet.');
      const signature = unbase64(result.signature);
      if (signature.length !== 64)
        throw new Error('Wallet returned an invalid NEP-413 signature.');
      return {
        signature: bs58.encode(signature),
        public_key: result.publicKey,
      };
    },
    send_transaction: async (action) => {
      const result = await wallet.signAndSendTransaction({
        network: 'testnet',
        signerId: action.signer_id,
        receiverId: action.receiver_id,
        actions: action.calls.map((call) => ({
          type: 'FunctionCall' as const,
          params: {
            methodName: call.method,
            args: call.args,
            gas: call.gas,
            deposit: call.deposit,
          },
        })),
      });
      return { transaction_id: result.transaction.hash };
    },
  };
  return {
    family: 'near',
    name: wallet.manifest.name,
    address: account.accountId,
    port,
    balance: () => nearBalance(account.accountId),
    disconnect: () => selector.disconnect(wallet),
  };
}
