import { workspace_root } from '@testnet/store';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deployment, bitcoin_verifier } from '@kanso/schema';
import { RpcProvider } from '@server/shared/near/rpc.provider';
import type { Release } from '@testnet/deployment';
import { near_view, near_send, near_signer, call } from '@testnet/deploy-near';
import { NEAR_SIGNER_RPC, rpc } from '@testnet/network';

export async function configure_bitcoin(release: Release) {
  const d = deployment.parse(
    JSON.parse(
      await readFile(join(workspace_root, 'deployments/testnet.json'), 'utf8'),
    ),
  );
  const chain = d.chains.find((c) => c.manifest.chain_id === 'bitcoin');
  if (!chain) throw new Error('Bitcoin deployment is not configured');
  const verifier = bitcoin_verifier.parse({
    account_id: 'btc-client-v4.testnet',
    network_fingerprint: chain.manifest.network_fingerprint,
    max_tip_age_seconds: 21_600,
  });
  const account = await rpc<{ code_hash: string }>(NEAR_SIGNER_RPC, 'query', {
    request_type: 'view_account',
    account_id: verifier.account_id,
    finality: 'final',
  });
  if (account.code_hash !== 'GoMf83WAKXNL1y4ApPtzm2Q88oJvEp3hmR3Ps6tjaG6W')
    throw new Error(
      'Bitcoin light-client code changed; review it before configuring custody',
    );
  const network = await near_view<unknown>(verifier.account_id, 'get_network');
  if (JSON.stringify(network) !== '["Bitcoin","Testnet"]')
    throw new Error('Expected the reviewed Bitcoin Testnet3 light client');
  const genesis = await new RpcProvider(process.env)
    .client(chain)
    .call<string>('getblockhash', [0]);
  if (genesis !== verifier.network_fingerprint)
    throw new Error(
      'Bitcoin RPC does not match the reviewed light-client network',
    );
  const current = await near_view<{ version: number }>(
    d.near.coordinator,
    'get_chain_manifest',
    { chain_id: 'bitcoin', version: null },
  );
  const owner = await near_signer(release, 'owner');
  for (
    let manifest_version = 1;
    manifest_version <= current.version;
    manifest_version++
  )
    await near_send(
      release,
      `bitcoin-verifier-${manifest_version}`,
      owner,
      d.near.coordinator,
      [call('register_bitcoin_verifier', { manifest_version, verifier })],
    );
  release.journal.contracts.bitcoin_verifier = {
    ...verifier,
    code_hash: account.code_hash,
    manifest_versions: current.version,
  };
  await release.save();
  console.log(
    `Bitcoin light client configured for manifest versions 1–${current.version}; borrowing policy is unchanged`,
  );
}
