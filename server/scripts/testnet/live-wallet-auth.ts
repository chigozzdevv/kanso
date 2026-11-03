import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'dotenv';
import bs58 from 'bs58';
import { KeyPair, transactions } from 'near-api-js';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { Keypair } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Account, RpcProvider } from 'starknet';
import { Transaction, payments, script } from 'bitcoinjs-lib';
import {
  create_kanso,
  nep413_message,
  starknet_auth_message,
  scoped_id,
  canonical_account,
} from '@kanso/sdk';
import type { WalletPort, AnyWallet } from '@kanso/sdk';
import { deployment } from '@kanso/schema';
import type {
  AuthChallenge,
  OwnershipProof,
  ChainFamily,
  Deployment,
} from '@kanso/schema';
import type { Release } from '@testnet/deployment';
import { digest } from '@testnet/deployment';
import { read_json } from '@testnet/store';
import { near_signer, near_send } from '@testnet/deploy-near';
import { send_source } from '@testnet/live-wallets';
import { NEAR_RPC, rpc } from '@testnet/network';

export async function testnet_wallet(
  release: Release,
  d: Deployment,
  family: ChainFamily,
  chain_id: string,
): Promise<AnyWallet> {
  const c = d.chains.find((c) => c.manifest.chain_id === chain_id);
  const role =
    family === 'near'
      ? 'near-borrower'
      : family === 'evm'
        ? 'evm-deployer'
        : `${family}-deployer`;
  let address: string,
    prove: (
      challenge: AuthChallenge,
    ) => Promise<Omit<OwnershipProof, 'challenge_id'>>;
  if (family === 'near') {
    const key = await read_json<{
      account_id: string;
      private_key: `ed25519:${string}`;
    }>(release.folder, `keys/${role}.json`);
    const pair = KeyPair.fromString(key.private_key);
    address = key.account_id;
    prove = async (challenge) => ({
      public_key: pair.getPublicKey().toString(),
      signature: bs58.encode(pair.sign(nep413_message(challenge)).signature),
    });
  } else if (family === 'evm') {
    const key = await read_json<{ private_key: Hex }>(
      release.folder,
      `keys/${role}.json`,
    );
    const account = privateKeyToAccount(key.private_key);
    address = account.address;
    prove = async (challenge) => ({
      signature: await account.signMessage({ message: challenge.message }),
    });
  } else if (family === 'solana') {
    const key = Keypair.fromSecretKey(
      Uint8Array.from(
        await read_json<number[]>(release.folder, `keys/${role}.json`),
      ),
    );
    address = key.publicKey.toBase58();
    prove = async (challenge) => ({
      signature: bs58.encode(
        ed25519.sign(
          new TextEncoder().encode(challenge.message),
          key.secretKey.slice(0, 32),
        ),
      ),
    });
  } else if (family === 'sui') {
    const keyfile = await read_json<{ private_key: string }>(
      release.folder,
      `keys/${role}.json`,
    );
    const key = Ed25519Keypair.fromSecretKey(keyfile.private_key);
    address = key.toSuiAddress();
    prove = async (challenge) => ({
      signature: (
        await key.signPersonalMessage(
          new TextEncoder().encode(challenge.message),
        )
      ).signature,
    });
  } else if (family === 'starknet') {
    const key = await read_json<{ address: string; private_key: string }>(
      release.folder,
      `keys/${role}.json`,
    );
    address = key.address;
    const account = new Account({
      provider: new RpcProvider({ nodeUrl: c!.rpc_url }),
      address,
      signer: key.private_key,
    });
    prove = async (challenge) => {
      const signature = await account.signMessage(
        starknet_auth_message(challenge.message),
      );
      return {
        signature: JSON.stringify(
          Array.isArray(signature)
            ? signature.map(String)
            : [signature.r.toString(), signature.s.toString()],
        ),
      };
    };
  } else {
    const key = await read_json<{
      address: string;
      public_key: string;
      private_key: string;
    }>(release.folder, `keys/${role}.json`);
    address = key.address;
    prove = async (challenge) => {
      const pub = Buffer.from(key.public_key, 'hex'),
        tag = Buffer.from(digest('BIP0322-signed-message'), 'hex');
      const hash = Buffer.from(
        digest(Buffer.concat([tag, tag, Buffer.from(challenge.message)])),
        'hex',
      );
      const spend = new Transaction();
      spend.version = 0;
      spend.addInput(
        Buffer.alloc(32),
        0xffffffff,
        0,
        script.compile([0, hash]),
      );
      spend.addOutput(payments.p2wpkh({ pubkey: pub }).output!, 0n);
      const sign = new Transaction();
      sign.version = 0;
      sign.addInput(spend.getHash(), 0, 0);
      sign.addOutput(script.compile([106]), 0n);
      const payload = sign.hashForWitnessV0(
        0,
        payments.p2pkh({ pubkey: pub }).output!,
        0n,
        Transaction.SIGHASH_ALL,
      );
      const signed = Buffer.concat([
        Buffer.from(
          secp256k1
            .sign(
              payload,
              Buffer.from(key.private_key.replace(/^0x/, ''), 'hex'),
            )
            .toDERRawBytes(),
        ),
        Buffer.from([1]),
      ]);
      return {
        signature: Buffer.concat([
          Buffer.from([2, signed.length]),
          signed,
          Buffer.from([pub.length]),
          pub,
        ]).toString('base64'),
      };
    };
  }
  const port: WalletPort = {
    family,
    accounts: async () => [{ address, chain_id }],
    prove_ownership: prove,
    network: async () => {
      if (family === 'near')
        return (await rpc<{ chain_id: string }>(NEAR_RPC, 'status', []))
          .chain_id;
      if (family === 'evm')
        return String(BigInt(await rpc<string>(c!.rpc_url, 'eth_chainId', [])));
      if (family === 'solana')
        return rpc<string>(c!.rpc_url, 'getGenesisHash', []);
      if (family === 'sui')
        return (
          await new SuiGrpcClient({
            network: 'testnet',
            baseUrl: c!.rpc_url,
          }).core.getChainIdentifier()
        ).chainIdentifier;
      if (family === 'starknet')
        return Buffer.from(
          (await rpc<string>(c!.rpc_url, 'starknet_chainId', [])).slice(2),
          'hex',
        ).toString();
      const response = await fetch(
        'https://mempool.space/testnet/api/block-height/0',
        { signal: AbortSignal.timeout(25000) },
      );
      if (!response.ok) throw new Error('Bitcoin network identity unavailable');
      return (await response.text()).trim();
    },
    send_transaction: async (action) => {
      if (
        action.family !== family ||
        action.chain_id !== chain_id ||
        canonical_account(family, action.signer_id) !==
          canonical_account(family, address)
      )
        throw new Error('Wallet action does not match the selected account');
      const id = scoped_id('live-wallet', JSON.stringify(action));
      if (action.family === 'near') {
        const effect = await near_send(
          release,
          id,
          await near_signer(release, 'borrower'),
          action.receiver_id,
          action.calls.map((c) =>
            transactions.functionCall(
              c.method,
              c.args,
              BigInt(c.gas),
              BigInt(c.deposit),
            ),
          ),
        );
        return { transaction_id: effect.transaction_id };
      }
      return { transaction_id: await send_source(release, id, action) };
    },
  };
  return port as AnyWallet;
}
export async function verify_wallet_auth(release: Release) {
  const d = deployment.parse(
    JSON.parse(
      await readFile(
        join(release.folder, '..', 'deployments', 'testnet.json'),
        'utf8',
      ),
    ),
  );
  const settings = parse(await readFile(join(release.folder, 'server.env')));
  const api_url = `http://127.0.0.1:${settings.PORT}`;
  const client = create_kanso({
    deployment: d,
    api_url,
    auth_domain: settings.AUTH_DOMAIN!,
    wallets: async (request) =>
      testnet_wallet(release, d, request.family, request.chain_id),
  });
  const near = await testnet_wallet(release, d, 'near', 'near'),
    owner = (await near.accounts())[0]!.address;
  if ((await near.network('near')) !== 'testnet')
    throw new Error('NEAR wallet network mismatch');
  await client.session.connect(owner);
  const connections = [
    {
      chain_id: 'near',
      family: 'near',
      address: owner,
      network: 'testnet',
      verified_at: new Date().toISOString(),
    },
  ];
  for (const c of d.chains) {
    const m = c.manifest,
      w = await testnet_wallet(release, d, m.family, m.chain_id),
      account = (await w.accounts())[0]!.address;
    const network = await w.network(m.chain_id);
    if (network !== m.network_fingerprint)
      throw new Error(`Wallet network mismatch: ${m.chain_id}`);
    await client.session.link(m.family, m.chain_id, account);
    connections.push({
      chain_id: m.chain_id,
      family: m.family,
      address: account,
      network,
      verified_at: new Date().toISOString(),
    });
    release.journal.contracts.authentication = { api_url, owner, connections };
    await release.save();
    console.log(
      `${m.chain_id}: real wallet ownership and API session link verified`,
    );
  }
  client.session.disconnect();
}
