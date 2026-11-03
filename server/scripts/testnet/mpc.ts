import bs58 from 'bs58';
import { publicKeyToAddress } from 'viem/accounts';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { payments, networks } from 'bitcoinjs-lib';
import { near_view } from '@testnet/deploy-near';
import { read_json, private_json, replace_json } from '@testnet/store';
import type { Release } from '@testnet/deployment';

export interface ControllerKey {
  path: string;
  domain: number;
  public_key: string;
  address: string | null;
}
export interface MpcKeys {
  account: string;
  predecessor: string;
  read_domain: number;
  read_public_key: string;
  controllers: Record<string, ControllerKey>;
  observed_at: string;
}
export async function mpc_keys(release: Release): Promise<MpcKeys> {
  const account = 'v1.signer-prod.testnet';
  const { account_id: predecessor } = await read_json<{ account_id: string }>(
    release.folder,
    'keys/near-coordinator.json',
  );
  const state = await near_view<{
    Running?: {
      domains: { domains: { id: number; protocol: string; purpose: string }[] };
    };
  }>(account, 'state');
  const domains = state.Running?.domains.domains;
  const secp = domains?.find(
    (d) => d.purpose === 'Sign' && d.protocol === 'CaitSith',
  );
  const ed = domains?.find(
    (d) => d.purpose === 'Sign' && d.protocol === 'Frost',
  );
  const read = domains?.find(
    (d) => d.purpose === 'ForeignTx' && d.protocol === 'CaitSith',
  );
  if (!secp || !ed || !read)
    throw new Error('Required MPC domains are unavailable');
  const read_key = await near_view<string>(account, 'public_key', {
    domain_id: read.id,
  });
  if (!read_key.startsWith('secp256k1:'))
    throw new Error('Invalid MPC read key');
  const result: MpcKeys = {
    account,
    predecessor,
    read_domain: read.id,
    read_public_key: Buffer.from(bs58.decode(read_key.split(':')[1]!)).toString(
      'hex',
    ),
    controllers: {},
    observed_at: new Date().toISOString(),
  };
  for (const chain of [
    'base',
    'arbitrum',
    'bnb',
    'polygon',
    'avalanche',
    'hyperevm',
    'solana',
    'sui',
    'starknet',
    'bitcoin',
  ]) {
    const domain = chain === 'solana' || chain === 'sui' ? ed.id : secp.id;
    const path = `${release.journal.deployment_id}:${chain}:custody:v1`;
    const key = await near_view<string>(account, 'derived_public_key', {
      path,
      predecessor,
      domain_id: domain,
    });
    const bytes = bs58.decode(key.split(':')[1]!);
    if (bytes.length !== (domain === ed.id ? 32 : 64))
      throw new Error('Invalid derived MPC key');
    const public_key = Buffer.from(bytes).toString('hex');
    const address =
      chain === 'sui'
        ? new Ed25519PublicKey(bytes).toSuiAddress()
        : chain === 'solana'
          ? bs58.encode(bytes)
          : chain === 'starknet'
            ? null
            : chain === 'bitcoin'
              ? payments.p2wpkh({
                  pubkey: secp256k1.ProjectivePoint.fromHex(
                    `04${public_key}`,
                  ).toRawBytes(true),
                  network: networks.testnet,
                }).address!
              : publicKeyToAddress(`0x04${public_key}`);
    result.controllers[chain] = { path, domain, public_key, address };
  }
  try {
    const existing = await read_json<MpcKeys>(release.folder, 'mpc.json');
    if (
      existing.predecessor !== predecessor ||
      existing.account !== account ||
      Object.keys(existing.controllers).length !==
        Object.keys(result.controllers).length ||
      Object.entries(result.controllers).some(([chain, key]) => {
        const prior = existing.controllers[chain];
        return (
          !prior ||
          prior.public_key !== key.public_key ||
          prior.domain !== key.domain ||
          prior.path !== key.path
        );
      }) ||
      existing.read_domain !== result.read_domain ||
      existing.read_public_key !== result.read_public_key
    )
      throw new Error('MPC keys changed since deployment preparation');
    await replace_json(release.folder, 'mpc.json', result);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
    await private_json(release.folder, 'mpc.json', result);
  }
  console.log('MPC controller keys verified against live signer domains');
  return result;
}
