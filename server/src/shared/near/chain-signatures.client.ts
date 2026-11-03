import bs58 from 'bs58';
import { Connection, Message } from '@solana/web3.js';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { evm_vault_abi } from '@kanso/bindings';
import { encodeFunctionData } from 'viem';
import { fromRlp } from 'viem';
import type { ChainConfiguration, RemoteOperation } from '@kanso/schema';
import { KansoError } from '@kanso/schema';
import { JsonRpc, from_hex, to_hex } from '@kanso/sdk';
const integer = (v: string | undefined) => BigInt(!v || v === '0x' ? '0x0' : v);
const safe = (value: bigint | string | number) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error('RPC integer exceeds safe range');
  return n;
};
export async function transaction_context(
  c: ChainConfiguration,
  op: RemoteOperation,
  rpc = new JsonRpc(c.rpc_url),
): Promise<Record<string, unknown>> {
  const m = op.manifest,
    old = op.signing_attempts[0];
  if (old) {
    if (m.family === 'evm') {
      const fields = fromRlp(
        ('0x' + to_hex(old.transaction.slice(1))) as `0x${string}`,
      ) as `0x${string}`[];
      return {
        family: 'evm',
        nonce: safe(integer(fields[1])),
        max_priority_fee_per_gas: integer(fields[2]).toString(),
        max_fee_per_gas: integer(fields[3]).toString(),
        gas_limit: safe(integer(fields[4])),
      };
    }
    if (m.family === 'solana')
      return {
        family: 'solana',
        recent_blockhash: Array.from(
          bs58.decode(Message.from(old.transaction).recentBlockhash),
        ),
      };
    if (m.family === 'starknet') {
      const tx = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(old.transaction)),
      ) as {
        nonce: string;
        resource_bounds: Record<
          string,
          { max_amount: string; max_price_per_unit: string }
        >;
      };
      return {
        family: 'starknet',
        nonce: safe(BigInt(tx.nonce)),
        ...Object.fromEntries(
          ['l1_gas', 'l1_data_gas', 'l2_gas'].flatMap((k, index) => [
            [k, safe(BigInt(tx.resource_bounds[k]!.max_amount))],
            [
              ['l1_price', 'l1_data_price', 'l2_price'][index]!,
              BigInt(tx.resource_bounds[k]!.max_price_per_unit).toString(),
            ],
          ]),
        ),
      };
    }
    const tx = Transaction.from(Uint8Array.from(old.transaction)).getData();
    const gas = tx.gasData.payment?.[0];
    const vault = tx.inputs.find((i) => i.Object?.SharedObject)?.Object
      ?.SharedObject;
    if (!gas || !vault) throw new Error('Malformed Sui transaction');
    return {
      family: 'sui',
      gas_object_id: Array.from(from_hex(gas.objectId)),
      gas_object_version: safe(gas.version),
      gas_object_digest: Array.from(bs58.decode(gas.digest)),
      gas_price: safe(tx.gasData.price!),
      gas_budget: safe(tx.gasData.budget!),
      vault_initial_shared_version: safe(vault.initialSharedVersion),
      expiration_epoch:
        tx.expiration && 'Epoch' in tx.expiration
          ? safe(tx.expiration.Epoch)
          : 0,
    };
  }
  if (m.family === 'evm') {
    const [nonce, price] = await Promise.all([
      rpc.call<string>('eth_getTransactionCount', [
        '0x' + to_hex(m.controller),
        'pending',
      ]),
      rpc.call<string>('eth_gasPrice', []),
    ]);
    const market = BigInt(price),
      ceiling = BigInt(m.max_fee_per_gas);
    if (market > ceiling)
      throw new KansoError(
        'SETTLEMENT_RECONCILING',
        'EVM gas price exceeds manifest',
        true,
      );
    if (market <= 0n) throw new Error('EVM gas price must be positive');
    const fee = market * 2n > ceiling ? ceiling : market * 2n;
    const address = (bytes: number[]) =>
      ('0x' + to_hex(bytes)) as `0x${string}`;
    const command = op.command;
    const data = encodeFunctionData({
      abi: evm_vault_abi,
      functionName: 'execute',
      args: [
        {
          operationId: address(command.operation_id),
          lockId: address(command.lock_id),
          agreement: address(command.agreement),
          settlementId: address(command.settlement_id),
          recipient: address(command.recipient),
          amount: BigInt(command.amount_atomic),
          nonce: BigInt(command.nonce),
          deadline: BigInt(command.deadline),
          kind: command.kind,
        },
      ],
    });
    const estimated = BigInt(
      await rpc.call<string>('eth_estimateGas', [
        { from: address(m.controller), to: address(m.vault), data },
      ]),
    );
    const required = safe((estimated * 120n + 99n) / 100n);
    const gas = Math.min(
      m.max_gas,
      safe(BigInt(m.max_network_cost_atomic) / fee),
    );
    if (required > gas) throw new Error('EVM execution exceeds gas budget');
    return {
      family: 'evm',
      nonce: safe(BigInt(nonce)),
      gas_limit: required,
      max_fee_per_gas: fee.toString(),
      max_priority_fee_per_gas: market.toString(),
    };
  }
  if (m.family === 'solana') {
    const conn = new Connection(c.rpc_url, 'finalized');
    return {
      family: 'solana',
      recent_blockhash: Array.from(
        bs58.decode((await conn.getLatestBlockhash('finalized')).blockhash),
      ),
    };
  }
  if (m.family === 'sui') {
    const owner = '0x' + to_hex(m.controller);
    const client = new SuiGrpcClient({
      network: 'testnet',
      baseUrl: c.rpc_url,
    });
    const [coins, vault, state] = await Promise.all([
      client.listCoins({ owner, coinType: '0x2::sui::SUI', limit: 50 }),
      client.getObject({ objectId: '0x' + to_hex(m.vault.slice(32)) }),
      client.core.getCurrentSystemState(),
    ]);
    const system = state.systemState,
      gasPrice = system.referenceGasPrice;
    const budget = m.max_network_cost_atomic;
    const coin = coins.objects.find((x) => BigInt(x.balance) >= BigInt(budget));
    if (!coin)
      throw new Error('Controller has no gas coin covering the bounded budget');
    if (BigInt(gasPrice) > BigInt(m.max_fee_per_gas))
      throw new Error('Sui gas price exceeds manifest');
    return {
      family: 'sui',
      gas_object_id: Array.from(from_hex(coin.objectId)),
      gas_object_version: safe(coin.version),
      gas_object_digest: Array.from(bs58.decode(coin.digest)),
      gas_price: safe(gasPrice),
      gas_budget: safe(budget),
      vault_initial_shared_version: safe(
        vault.object.owner.$kind === 'Shared'
          ? vault.object.owner.Shared.initialSharedVersion
          : (() => {
              throw new Error('Sui vault is not shared');
            })(),
      ),
      expiration_epoch: safe(system.epoch) + 2,
    };
  }
  const [nonce, block] = await Promise.all([
    rpc.call<string>('starknet_getNonce', {
      block_id: 'latest',
      contract_address: '0x' + to_hex(m.controller),
    }),
    rpc.call<{
      l1_gas_price: { price_in_fri: string };
      l1_data_gas_price: { price_in_fri: string };
      l2_gas_price: { price_in_fri: string };
    }>('starknet_getBlockWithTxHashes', { block_id: 'latest' }),
  ]);
  const prices = [
    block.l1_gas_price.price_in_fri,
    block.l1_data_gas_price.price_in_fri,
    block.l2_gas_price.price_in_fri,
  ].map((v) => BigInt(v) * 2n);
  if (prices.some((v) => v <= 0n || v > BigInt(m.max_fee_per_gas)))
    throw new Error('Starknet gas price exceeds manifest');
  const budget = BigInt(m.max_network_cost_atomic) / 3n;
  return {
    family: 'starknet',
    nonce: safe(BigInt(nonce)),
    l1_gas: Math.min(m.max_gas, safe(budget / prices[0]!)),
    l1_data_gas: Math.min(m.max_gas, safe(budget / prices[1]!)),
    l2_gas: Math.min(m.max_gas, safe(budget / prices[2]!)),
    l1_price: prices[0]!.toString(),
    l1_data_price: prices[1]!.toString(),
    l2_price: prices[2]!.toString(),
  };
}
