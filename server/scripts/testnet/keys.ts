import { randomBytes } from 'node:crypto';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { privateKeyToAccount } from 'viem/accounts';
import { Keypair } from '@solana/web3.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { payments, networks } from 'bitcoinjs-lib';
import { ec } from 'starknet';
import { keys_directory, private_json, read_json } from '@testnet/store';
import type { KeyIndex, WalletRecord } from '@testnet/store';
export async function generate_keys() {
  const folder = await keys_directory();
  try {
    await access(join(folder, 'index.json'));
    return read_json<KeyIndex>(folder, 'index.json');
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e;
  }
  if ((await readdir(folder)).length > 0)
    throw new Error(
      'Incomplete key initialization: preserve the existing keys and restore index.json before continuing',
    );
  const suffix = randomBytes(5).toString('hex'),
    wallets: WalletRecord[] = [];
  for (const role of [
    'owner',
    'coordinator',
    'oracle',
    'relayer',
    'solver',
    'manager',
    'lp',
    'borrower',
  ]) {
    const key = KeyPair.fromRandom('ed25519'),
      address = `kanso-${role}-${suffix}.testnet`,
      key_file = `near-${role}.json`;
    await private_json(folder, key_file, {
      account_id: address,
      public_key: key.getPublicKey().toString(),
      private_key: key.toString(),
    });
    wallets.push({ family: 'near', role, address, key_file });
  }
  for (let i = 0; i < 3; i++) {
    const key = KeyPair.fromRandom('ed25519');
    await private_json(folder, `recovery-attestor-${i}.json`, {
      scheme: 'ed25519',
      public_key: key.getPublicKey().toString(),
      private_key: key.toString(),
    });
  }
  for (const role of ['deployer', 'borrower']) {
    const private_key = ('0x' +
        randomBytes(32).toString('hex')) as `0x${string}`,
      evm = privateKeyToAccount(private_key),
      evm_file = `evm-${role}.json`;
    await private_json(folder, evm_file, { address: evm.address, private_key });
    wallets.push({
      family: 'evm',
      role,
      address: evm.address,
      key_file: evm_file,
    });
    const solana = Keypair.generate(),
      solana_file = `solana-${role}.json`;
    await private_json(folder, solana_file, Array.from(solana.secretKey));
    wallets.push({
      family: 'solana',
      role,
      address: solana.publicKey.toBase58(),
      key_file: solana_file,
    });
    const sui = Ed25519Keypair.generate(),
      sui_file = `sui-${role}.json`;
    await private_json(folder, sui_file, {
      address: sui.toSuiAddress(),
      private_key: sui.getSecretKey(),
    });
    wallets.push({
      family: 'sui',
      role,
      address: sui.toSuiAddress(),
      key_file: sui_file,
    });
    const btc_key = secp256k1.utils.randomPrivateKey(),
      btc_public = secp256k1.getPublicKey(btc_key, true),
      btc = payments.p2wpkh({ pubkey: btc_public, network: networks.testnet }),
      bitcoin_file = `bitcoin-${role}.json`;
    if (!btc.address) throw new Error('Bitcoin address derivation failed');
    await private_json(folder, bitcoin_file, {
      network: 'testnet3',
      address: btc.address,
      private_key: Buffer.from(btc_key).toString('hex'),
      public_key: Buffer.from(btc_public).toString('hex'),
    });
    wallets.push({
      family: 'bitcoin',
      role,
      address: btc.address,
      key_file: bitcoin_file,
    });
    const starknet_key = ec.starkCurve.utils.randomPrivateKey();
    await private_json(folder, `starknet-${role}.json`, {
      network: 'SN_SEPOLIA',
      private_key: '0x' + Buffer.from(starknet_key).toString('hex'),
      public_key: ec.starkCurve.getStarkKey(starknet_key),
    });
  }
  const index: KeyIndex = {
    version: 1,
    created_at: new Date().toISOString(),
    wallets,
  };
  await private_json(folder, 'index.json', index);
  return index;
}
