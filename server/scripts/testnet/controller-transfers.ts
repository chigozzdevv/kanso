import { setTimeout as pause } from 'node:timers/promises';
import bs58 from 'bs58';
import { createPublicClient, http, keccak256 } from 'viem';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  Keypair,
  Connection,
  Transaction as SolanaTransaction,
} from '@solana/web3.js';
import type { Release } from '@testnet/deployment';
import { digest } from '@testnet/deployment';
import { read_json } from '@testnet/store';
import { evm_networks, SOLANA_RPC } from '@testnet/network';

const ids: Record<string, number> = {
  base: 84532,
  arbitrum: 421614,
  bnb: 97,
  polygon: 80002,
  avalanche: 43113,
  hyperevm: 998,
};
export async function send_evm(
  release: Release,
  id: string,
  chain_id: string,
  to: Hex,
  data: Hex,
  value: bigint,
) {
  const chain = evm_networks.find((c) => c.id === ids[chain_id]);
  if (!chain) throw new Error('Unknown EVM chain');
  const client = createPublicClient({
    chain,
    transport: http(undefined, { timeout: 25000, retryCount: 1 }),
  });
  if ((await client.getChainId()) !== chain.id)
    throw new Error('EVM network mismatch');
  const key = await read_json<{ private_key: Hex; address: string }>(
    release.folder,
    'keys/evm-deployer.json',
  );
  const account = privateKeyToAccount(key.private_key);
  const request = {
    chain_id,
    from: account.address,
    to,
    data,
    value: value.toString(),
  };
  const intent = digest(JSON.stringify(request));
  let effect = release.journal.effects[id];
  if (effect && effect.intent !== intent)
    throw new Error(`Source intent changed: ${id}`);
  if (effect?.state === 'failed')
    throw new Error(`Source transaction failed: ${id}`);
  if (effect?.state === 'confirmed') return effect.transaction_id;
  if (!effect) {
    const gas =
      ((await client.estimateGas({ account, to, data, value })) * 120n) / 100n;
    const gasPrice = (await client.getGasPrice()) * 2n;
    if (
      value + gas * gasPrice >
      (await client.getBalance({ address: account.address }))
    )
      throw new Error(`${chain_id}: insufficient deployer funds`);
    const nonce = await client.getTransactionCount({
      address: account.address,
      blockTag: 'pending',
    });
    const raw = await account.signTransaction({
      chainId: chain.id,
      to,
      data,
      value,
      gas,
      gasPrice,
      nonce,
      type: 'legacy',
    });
    effect = {
      intent,
      state: 'prepared',
      request,
      transaction_id: keccak256(raw),
      raw_transaction: raw,
    };
    release.journal.effects[id] = effect;
    await release.save();
  }
  try {
    await client.sendRawTransaction({
      serializedTransaction: effect.raw_transaction as Hex,
    });
  } catch (error) {
    console.log(
      `${id}: reconciling ${effect.transaction_id}: ${error instanceof Error ? error.message.slice(0, 100) : 'RPC interrupted'}`,
    );
  }
  const receipt = await client.waitForTransactionReceipt({
    hash: effect.transaction_id as Hex,
    timeout: 120000,
  });
  effect.state = receipt.status === 'success' ? 'confirmed' : 'failed';
  effect.result = {
    block_number: receipt.blockNumber.toString(),
    gas_used: receipt.gasUsed.toString(),
    fee_atomic: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
  };
  await release.save();
  if (effect.state === 'failed')
    throw new Error(`${id}: EVM execution reverted`);
  console.log(`${id}: ${effect.transaction_id}`);
  return effect.transaction_id;
}

export async function send_solana(
  release: Release,
  id: string,
  tx: SolanaTransaction,
) {
  const connection = new Connection(SOLANA_RPC, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  });
  const key = Keypair.fromSecretKey(
    Uint8Array.from(
      await read_json<number[]>(release.folder, 'keys/solana-deployer.json'),
    ),
  );
  if (
    (await connection.getGenesisHash()) !==
    'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
  )
    throw new Error('Expected Solana Devnet');
  const intent = digest(
    JSON.stringify({
      payer: key.publicKey.toBase58(),
      instructions: tx.instructions,
    }),
  );
  let effect = release.journal.effects[id];
  if (effect && effect.intent !== intent)
    throw new Error(`Source intent changed: ${id}`);
  if (effect?.state === 'failed')
    throw new Error(`Source transaction failed: ${id}`);
  if (effect?.state === 'confirmed') return effect.transaction_id;
  const previous = effect;
  if (effect) {
    const status = (
      await connection.getSignatureStatuses([effect.transaction_id], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (status?.err) throw new Error(`${id}: ${JSON.stringify(status.err)}`);
    if (
      status?.confirmationStatus === 'finalized' ||
      status?.confirmationStatus === 'confirmed'
    ) {
      effect.state = 'confirmed';
      effect.result = status;
      await release.save();
      return effect.transaction_id;
    }
    const old = SolanaTransaction.from(
      Buffer.from(effect.raw_transaction!, 'base64'),
    );
    if (!(await connection.isBlockhashValid(old.recentBlockhash!)).value)
      effect = undefined;
  }
  if (!effect) {
    tx.feePayer = key.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(key);
    const raw = tx.serialize();
    effect = {
      intent,
      state: 'prepared',
      transaction_id: bs58.encode(tx.signature!),
      raw_transaction: raw.toString('base64'),
      replacements: previous
        ? [
            ...(previous.replacements ?? []),
            {
              transaction_id: previous.transaction_id,
              raw_transaction: previous.raw_transaction!,
            },
          ]
        : [],
    };
    release.journal.effects[id] = effect;
    await release.save();
  }
  await connection.sendRawTransaction(
    Buffer.from(effect.raw_transaction!, 'base64'),
    { maxRetries: 2 },
  );
  for (let attempt = 0; attempt < 30; attempt++) {
    await pause(2500);
    const status = (
      await connection.getSignatureStatuses([effect.transaction_id], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (status?.err) {
      effect.state = 'failed';
      effect.result = status;
      await release.save();
      throw new Error(`${id}: ${JSON.stringify(status.err)}`);
    }
    if (
      status?.confirmationStatus === 'finalized' ||
      status?.confirmationStatus === 'confirmed'
    ) {
      effect.state = 'confirmed';
      effect.result = status;
      await release.save();
      console.log(`${id}: ${effect.transaction_id}`);
      return effect.transaction_id;
    }
  }
  throw new Error(`Unresolved Solana transaction: ${effect.transaction_id}`);
}
