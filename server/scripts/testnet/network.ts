import { SuiGrpcClient } from '@mysten/sui/grpc';
import { setTimeout as pause } from 'node:timers/promises';
import { hash } from 'starknet';
import {
  baseSepolia,
  arbitrumSepolia,
  bscTestnet,
  polygonAmoy,
  avalancheFuji,
  hyperliquidEvmTestnet,
} from 'viem/chains';
import type { WalletRecord } from '@testnet/store';

export const NEAR_RPC = 'https://rpc.testnet.fastnear.com';
export const NEAR_SIGNER_RPC = NEAR_RPC;
export const NEAR_ARCHIVAL_RPC = 'https://archival-rpc.testnet.fastnear.com';
export const NEAR_FAUCET = 'https://helper.nearprotocol.com/account';
export const SOLANA_RPC = 'https://api.devnet.solana.com';
export const SUI_FAUCET = 'https://faucet.testnet.sui.io';
export const STARKNET_RPC =
  'https://api.zan.top/public/starknet-sepolia/rpc/v0_10';
export const STRK =
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
export const evm_networks = [
  baseSepolia,
  arbitrumSepolia,
  bscTestnet,
  polygonAmoy,
  avalancheFuji,
  hyperliquidEvmTestnet,
];
export const sui = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});

export class NetworkError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
export async function json_request<T>(url: string, body?: unknown): Promise<T> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers:
          body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(25_000),
      });
      if (![408, 429, 502, 503, 504].includes(response.status) || attempt === 2)
        break;
      await response.body?.cancel();
    } catch (error) {
      if (attempt === 2) throw error;
    }
    await pause(1000 * (attempt + 1));
  }
  if (!response) throw new NetworkError('RPC transport returned no response');
  const text = await response.text();
  if (!response.ok)
    throw new NetworkError(
      `HTTP ${response.status}: ${text.slice(0, 300)}`,
      response.status,
    );
  return JSON.parse(text) as T;
}
export async function rpc<T>(
  url: string,
  method: string,
  params: unknown,
): Promise<T> {
  const result = await json_request<{ result?: T; error?: unknown }>(url, {
    jsonrpc: '2.0',
    id: 'kanso-testnet',
    method,
    params,
  });
  if (result.error !== undefined)
    throw new NetworkError(JSON.stringify(result.error));
  if (result.result === undefined)
    throw new NetworkError('Missing JSON-RPC result');
  return result.result;
}
export async function near_account(address: string) {
  try {
    return await rpc<{ amount: string; code_hash: string }>(NEAR_RPC, 'query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: address,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNKNOWN_ACCOUNT'))
      return null;
    throw error;
  }
}
export async function balance(wallet: WalletRecord): Promise<string | null> {
  if (wallet.family === 'near')
    return (await near_account(wallet.address))?.amount ?? null;
  if (wallet.family === 'solana')
    return String(
      (
        await rpc<{ value: number }>(SOLANA_RPC, 'getBalance', [
          wallet.address,
          { commitment: 'confirmed' },
        ])
      ).value,
    );
  if (wallet.family === 'sui')
    return (
      await sui.getBalance({
        owner: wallet.address,
        signal: AbortSignal.timeout(25_000),
      })
    ).balance.balance;
  if (wallet.family === 'starknet') {
    const result = await rpc<string[]>(STARKNET_RPC, 'starknet_call', {
      block_id: 'latest',
      request: {
        contract_address: STRK,
        entry_point_selector: hash.getSelectorFromName('balanceOf'),
        calldata: [wallet.address],
      },
    });
    if (result.length !== 2) throw new Error('Unexpected STRK balance result');
    return (BigInt(result[0]!) + (BigInt(result[1]!) << 128n)).toString();
  }
  if (wallet.family === 'bitcoin') {
    const genesis = await fetch(
      'https://mempool.space/testnet/api/block-height/0',
      { signal: AbortSignal.timeout(25_000) },
    );
    if (
      !genesis.ok ||
      (await genesis.text()).trim() !==
        '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'
    )
      throw new Error('Expected Bitcoin Testnet3');
    const result = await json_request<{
      chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
    }>('https://mempool.space/testnet/api/address/' + wallet.address);
    return (
      BigInt(result.chain_stats.funded_txo_sum) -
      BigInt(result.chain_stats.spent_txo_sum)
    ).toString();
  }
  return null;
}
export async function evm_balances(address: string) {
  return Promise.all(
    evm_networks.map(async (chain) => {
      try {
        const url = chain.rpcUrls.default.http[0],
          id = await rpc<string>(url, 'eth_chainId', []);
        if (BigInt(id) !== BigInt(chain.id))
          throw new Error('Unexpected EVM testnet chain ID');
        return {
          network: chain.name,
          chain_id: chain.id,
          symbol: chain.nativeCurrency.symbol,
          balance_atomic: BigInt(
            await rpc<string>(url, 'eth_getBalance', [address, 'latest']),
          ).toString(),
        };
      } catch (error) {
        return {
          network: chain.name,
          chain_id: chain.id,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}
