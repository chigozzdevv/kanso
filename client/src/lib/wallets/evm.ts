import { JsonRpc, to_hex } from '@kanso/sdk';
import type { WalletPort } from '@kanso/sdk';
import { deployment } from '@/lib/kanso';
import type { WalletChoice } from '@/lib/wallets/types';

interface Provider {
  request: (input: { method: string; params?: unknown[] }) => Promise<unknown>;
}
type AnnouncedProvider = {
  info: { uuid: string; name: string };
  provider: Provider;
};
const providers = new Map<string, AnnouncedProvider>();
let listening = false;

export function evmChoices(): WalletChoice[] {
  if (!listening) {
    window.addEventListener('eip6963:announceProvider', ((
      event: CustomEvent<AnnouncedProvider>,
    ) => {
      if (
        event.detail?.info?.uuid &&
        typeof event.detail.provider?.request === 'function'
      )
        providers.set(event.detail.info.uuid, event.detail);
    }) as EventListener);
    listening = true;
  }
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const legacy = (window as Window & { ethereum?: Provider }).ethereum;
  if (!providers.size && legacy)
    providers.set('injected', {
      info: { uuid: 'injected', name: 'Browser wallet' },
      provider: legacy,
    });
  return [...providers.values()].map(({ info, provider }) => ({
    id: info.uuid,
    name: info.name,
    connect: async () => {
      const addresses = (await provider.request({
        method: 'eth_requestAccounts',
      })) as string[];
      const address = addresses[0]?.toLowerCase();
      if (!address) throw new Error('Select an EVM account.');
      const chains = deployment.chains.filter(
        (c) => c.manifest.family === 'evm',
      );
      const port: WalletPort<'evm'> = {
        family: 'evm',
        accounts: async () =>
          (
            (await provider.request({ method: 'eth_accounts' })) as string[]
          ).flatMap((a) =>
            chains.map((c) => ({
              address: a.toLowerCase(),
              chain_id: c.manifest.chain_id,
            })),
          ),
        network: async (chainId) => {
          const chain = chains.find((c) => c.manifest.chain_id === chainId);
          if (!chain) throw new Error('Unknown EVM network.');
          const expected = BigInt(chain.manifest.network_fingerprint);
          if (
            BigInt(
              (await provider.request({ method: 'eth_chainId' })) as string,
            ) !== expected
          ) {
            await provider.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: `0x${expected.toString(16)}` }],
            });
          }
          return BigInt(
            (await provider.request({ method: 'eth_chainId' })) as string,
          ).toString();
        },
        prove_ownership: async (challenge) => ({
          signature: (await provider.request({
            method: 'personal_sign',
            params: [
              `0x${to_hex(new TextEncoder().encode(challenge.message))}`,
              challenge.address,
            ],
          })) as string,
        }),
        send_transaction: async (action) => ({
          transaction_id: (await provider.request({
            method: 'eth_sendTransaction',
            params: [
              {
                from: action.signer_id,
                to: action.to,
                data: action.data,
                value: `0x${BigInt(action.value).toString(16)}`,
              },
            ],
          })) as string,
        }),
      };
      return {
        family: 'evm',
        name: info.name,
        address,
        port,
        balance: async (asset) => {
          const chain = chains.find(
            (c) => c.manifest.chain_id === asset.chain_id,
          )!;
          return BigInt(
            await new JsonRpc(chain.rpc_url).call<string>('eth_getBalance', [
              address,
              'latest',
            ]),
          ).toString();
        },
      };
    },
  }));
}
