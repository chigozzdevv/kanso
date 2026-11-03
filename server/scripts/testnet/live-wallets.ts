import { setTimeout as pause } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import bs58 from 'bs58';
import { createPublicClient, http, keccak256 } from 'viem';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  Keypair,
  Connection,
  Transaction as SolanaTransaction,
} from '@solana/web3.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction as SuiTransaction } from '@mysten/sui/transactions';
import {
  Psbt,
  networks,
  payments,
  Transaction as BitcoinTransaction,
} from 'bitcoinjs-lib';
import { secp256k1 } from '@noble/curves/secp256k1';
import type { TransactionAction } from '@kanso/schema';
import { deployment } from '@kanso/schema';
import { RpcProvider } from '@server/shared/near/rpc.provider';
import type { Release } from '@testnet/deployment';
import { digest } from '@testnet/deployment';
import { read_json } from '@testnet/store';
import { evm_networks, SOLANA_RPC, json_request } from '@testnet/network';
import { execute_sui } from '@testnet/deploy-sui';
import { starknet_invoke } from '@testnet/deploy-starknet';

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
  if (!chain) throw new Error('Unknown EVM verification chain');
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
      throw new Error(`${chain_id}: insufficient source verification funds`);
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

export async function send_bitcoin(
  release: Release,
  id: string,
  action: Extract<TransactionAction, { family: 'bitcoin' }>,
) {
  const intent = digest(JSON.stringify(action));
  let effect = release.journal.effects[id];
  if (effect && effect.intent !== intent)
    throw new Error(`Source intent changed: ${id}`);
  if (effect?.state === 'failed')
    throw new Error(`Source transaction failed: ${id}`);
  if (effect?.state === 'confirmed') return effect.transaction_id;
  const configured = deployment.parse(
    JSON.parse(
      await readFile(
        join(release.folder, '../deployments/testnet.json'),
        'utf8',
      ),
    ),
  );
  const chain = configured.chains.find((c) => c.manifest.family === 'bitcoin');
  if (!chain) throw new Error('Bitcoin RPC configuration is missing');
  const bitcoin_rpc = new RpcProvider(process.env).client(chain);
  if (
    (await bitcoin_rpc.call<string>('getblockhash', [0])) !==
    chain.manifest.network_fingerprint
  )
    throw new Error('Expected Bitcoin Testnet3');
  if (!effect) {
    const key = await read_json<{
      address: string;
      public_key: string;
      private_key: string;
    }>(release.folder, 'keys/bitcoin-deployer.json');
    if (key.address !== action.signer_id)
      throw new Error('Bitcoin source wallet mismatch');
    const utxos = await json_request<
      {
        txid: string;
        vout: number;
        value: number;
        status: { confirmed: boolean };
      }[]
    >('https://mempool.space/testnet/api/address/' + key.address + '/utxo');
    const [estimate, mempool] = await Promise.allSettled([
      bitcoin_rpc.call<{ feerate?: number }>('estimatesmartfee', [3]),
      bitcoin_rpc.call<{ mempoolminfee: number; minrelaytxfee: number }>(
        'getmempoolinfo',
        [],
      ),
    ]);
    if (mempool.status === 'rejected') throw mempool.reason;
    const floor = Math.max(
      mempool.value.mempoolminfee,
      mempool.value.minrelaytxfee,
    );
    const suggested =
      estimate.status === 'fulfilled' ? estimate.value.feerate : undefined;
    const fee_per_kb = Math.max(floor, suggested ?? floor);
    if (!Number.isFinite(fee_per_kb) || fee_per_kb <= 0)
      throw new Error('Bitcoin relay fee is unavailable');
    const rate = Math.ceil(fee_per_kb * 100_000);
    const chosen = [];
    let total = 0n,
      fee = 0n;
    const own_parents = new Set(
      Object.values(release.journal.effects)
        .filter(
          (e) =>
            e.request &&
            (e.request as { family?: string; signer_id?: string }).family ===
              'bitcoin' &&
            (e.request as { signer_id?: string }).signer_id === key.address &&
            e.state !== 'failed',
        )
        .map((e) => e.transaction_id),
    );
    for (const u of utxos.filter(
      (u) => u.status.confirmed || own_parents.has(u.txid),
    )) {
      chosen.push(u);
      total += BigInt(u.value);
      fee = BigInt(12 + 68 * chosen.length + 62 + 10) * BigInt(rate);
      if (total >= BigInt(action.amount_atomic) + fee) break;
    }
    if (fee > 3000n || total < BigInt(action.amount_atomic) + fee)
      throw new Error('Bitcoin funding or fee budget insufficient');
    const script = payments.p2wpkh({
      pubkey: Buffer.from(key.public_key, 'hex'),
      network: networks.testnet,
    }).output!;
    const psbt = new Psbt({ network: networks.testnet });
    for (const u of chosen) {
      const output = await bitcoin_rpc.call<{
        value: number;
        scriptPubKey: { hex: string };
      } | null>('gettxout', [u.txid, u.vout, true]);
      if (
        !output ||
        Math.round(output.value * 100_000_000) !== u.value ||
        output.scriptPubKey.hex !== Buffer.from(script).toString('hex')
      )
        throw new Error(
          'Bitcoin source UTXO differs from the wallet funding observation',
        );
      psbt.addInput({
        hash: u.txid,
        index: u.vout,
        witnessUtxo: { script, value: BigInt(u.value) },
      });
    }
    psbt.addOutput({
      address: action.address,
      value: BigInt(action.amount_atomic),
    });
    const change = total - BigInt(action.amount_atomic) - fee;
    if (change >= 294n) psbt.addOutput({ address: key.address, value: change });
    else if (fee + change > 3000n)
      throw new Error('Bitcoin dust would exceed fee limit');
    psbt.signAllInputs({
      publicKey: Buffer.from(key.public_key, 'hex'),
      sign: (hash) =>
        secp256k1
          .sign(hash, Buffer.from(key.private_key.replace(/^0x/, ''), 'hex'))
          .toCompactRawBytes(),
    });
    if (
      !psbt.validateSignaturesOfAllInputs((pub, hash, signature) =>
        secp256k1.verify(signature, hash, pub),
      )
    )
      throw new Error('Bitcoin source signature invalid');
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    effect = {
      intent,
      state: 'prepared',
      transaction_id: tx.getId(),
      raw_transaction: tx.toHex(),
      request: action,
    };
    release.journal.effects[id] = effect;
    await release.save();
  }
  if (effect.state !== 'confirmed') {
    try {
      await bitcoin_rpc.call('sendrawtransaction', [effect.raw_transaction]);
    } catch (error) {
      console.log(
        `${id}: reconciling Bitcoin broadcast: ${error instanceof Error ? error.message.slice(0, 150) : 'RPC interrupted'}`,
      );
    }
    const tx = await bitcoin_rpc.call<{ hex: string; confirmations?: number }>(
      'getrawtransaction',
      [effect.transaction_id, true],
    );
    if (BitcoinTransaction.fromHex(tx.hex).getId() !== effect.transaction_id)
      throw new Error('Bitcoin broadcast identity mismatch');
    effect.state = (tx.confirmations ?? 0) > 0 ? 'confirmed' : 'prepared';
    effect.result = { confirmations: tx.confirmations ?? 0 };
    await release.save();
  }
  console.log(`${id}: ${effect.transaction_id}`);
  return effect.transaction_id;
}

export async function send_source(
  release: Release,
  id: string,
  action: TransactionAction,
) {
  if (action.family === 'evm')
    return send_evm(
      release,
      id,
      action.chain_id,
      action.to as Hex,
      action.data as Hex,
      BigInt(action.value),
    );
  if (action.family === 'solana')
    return send_solana(
      release,
      id,
      SolanaTransaction.from(Buffer.from(action.transaction, 'base64')),
    );
  if (action.family === 'starknet') {
    await starknet_invoke(
      release,
      id,
      action.calls.map((c) => ({
        contractAddress: c.contract_address,
        entrypoint: c.entrypoint,
        calldata: c.calldata,
      })),
    );
    return release.journal.effects[id]!.transaction_id;
  }
  if (action.family === 'sui') {
    const key = await read_json<{ private_key: string }>(
      release.folder,
      'keys/sui-deployer.json',
    );
    const tx = SuiTransaction.from(action.transaction);
    const result = await execute_sui(
      release,
      id,
      tx,
      Ed25519Keypair.fromSecretKey(key.private_key),
      digest(action.transaction),
    );
    return result.digest;
  }
  if (action.family === 'bitcoin') return send_bitcoin(release, id, action);
  throw new Error('Use the journaled NEAR signer for native actions');
}
