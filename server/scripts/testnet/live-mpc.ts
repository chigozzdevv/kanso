import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { transactions } from 'near-api-js';
import { k256_signature, mpc_signature } from '@kanso/schema';
import { near_send, near_signer } from '@testnet/deploy-near';
import { evm_networks, rpc } from '@testnet/network';
import { read_json } from '@testnet/store';
import type { Release } from '@testnet/deployment';
import type { MpcKeys } from '@testnet/mpc';

export function payload_hash(release: Release, payload: unknown) {
  const result = spawnSync(
    join(
      release.folder,
      '..',
      'contracts/near/target/debug/examples/mpc_payload',
    ),
    [],
    { input: JSON.stringify(payload), encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(`Pinned MPC payload encoder failed: ${result.stderr}`);
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid MPC payload hash');
  return hash;
}
export function verify_read_signature(
  hash: string,
  signature: unknown,
  public_key: string,
) {
  const parsed = k256_signature.parse(signature);
  const r =
    secp256k1.ProjectivePoint.fromHex(parsed.big_r.affine_point).toAffine().x %
    secp256k1.CURVE.n;
  const value = new secp256k1.Signature(r, BigInt('0x' + parsed.s.scalar));
  if (
    !secp256k1.verify(
      value.toCompactRawBytes(),
      Buffer.from(hash, 'hex'),
      Buffer.from('04' + public_key, 'hex'),
      {
        lowS: true,
      },
    )
  )
    throw new Error('Invalid live MPC read signature');
}
export async function probe_reads(release: Release) {
  const deployed = await read_json<{
    contracts: Record<string, { transaction: string }>;
  }>(release.folder, 'deployment.json');
  const mpc = await read_json<MpcKeys>(release.folder, 'mpc.json');
  const relayer = await near_signer(release, 'relayer');
  const names: Record<number, string> = {
    84532: 'base',
    421614: 'arbitrum',
    97: 'bnb',
    80002: 'polygon',
    43113: 'avalanche',
    998: 'hyperevm',
  };
  const variants: Record<string, string> = {
    base: 'Base',
    arbitrum: 'Arbitrum',
    bnb: 'Bnb',
    polygon: 'Polygon',
    avalanche: 'Avalanche',
    hyperevm: 'HyperEvm',
  };
  for (const chain of evm_networks) {
    const name = names[chain.id]!;
    if (process.env.LIVE_CHAIN && process.env.LIVE_CHAIN !== name) continue;
    const tx = deployed.contracts[name]!.transaction;
    const url = chain.rpcUrls.default.http[0];
    const receipt = await rpc<{
      blockHash: string;
      blockNumber: string;
      status: string;
    }>(url, 'eth_getTransactionReceipt', [tx]);
    const final = await rpc<{ number: string }>(url, 'eth_getBlockByNumber', [
      'finalized',
      false,
    ]);
    if (
      receipt.status !== '0x1' ||
      BigInt(receipt.blockNumber) > BigInt(final.number)
    )
      throw new Error(`${name}: deployment has not finalized`);
    const request = {
      [variants[name]!]: {
        tx_id: tx.slice(2),
        finality: 'Finalized',
        extractors: ['BlockHash'],
      },
    };
    const payload = {
      V1: {
        request,
        values: [
          { EvmExtractedValue: { BlockHash: receipt.blockHash.slice(2) } },
        ],
      },
    };
    const expected = payload_hash(release, payload);
    const effect = await near_send(
      release,
      `read-probe-${name}-v1`,
      relayer,
      mpc.account,
      [
        transactions.functionCall(
          'verify_foreign_transaction',
          {
            request: {
              request,
              domain_id: mpc.read_domain,
              payload_version: 1,
              expected_payload_hash: expected,
            },
          },
          100_000_000_000_000n,
          1n,
        ),
      ],
    );
    const result = effect.result as { status: { SuccessValue: string } };
    const response = JSON.parse(
      Buffer.from(result.status.SuccessValue, 'base64').toString(),
    ) as { payload_hash: string; signature: unknown };
    const signature = mpc_signature.parse(response.signature);
    if (response.payload_hash !== expected || signature.scheme !== 'Secp256k1')
      throw new Error('Unexpected MPC read response');
    const fields = {
      big_r: signature.big_r,
      s: signature.s,
      recovery_id: signature.recovery_id,
    };
    verify_read_signature(expected, fields, mpc.read_public_key);
    release.journal.contracts[`read-${name}`] = {
      chain_id: name,
      source_transaction: tx,
      block_hash: receipt.blockHash,
      payload,
      payload_hash: expected,
      signature,
      near_transaction: effect.transaction_id,
      verified_at: new Date().toISOString(),
    };
    await release.save();
    console.log(`${name}: live MPC observation and root signature verified`);
  }
}
