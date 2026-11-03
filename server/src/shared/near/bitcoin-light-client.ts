import { KansoError, bitcoin_verifier } from '@kanso/schema';
import type { ChainConfiguration, Deployment } from '@kanso/schema';
import { JsonRpc, bitcoin_proof, bitcoin_proof_args } from '@kanso/sdk';
import { RpcProvider } from '@server/shared/near/rpc.provider';
import { z } from 'zod';

const light_client_tip = z.object({
  block_header: z.object({
    time: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  block_height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export class BitcoinLightClient {
  private readonly near;
  constructor(
    private readonly deployment: Deployment,
    private readonly providers = new RpcProvider(),
    near?: JsonRpc,
  ) {
    this.near = near ?? new JsonRpc(deployment.near.rpc_url);
  }
  async observe(chain: ChainConfiguration, transaction_id: string) {
    const manifest = chain.manifest;
    if (manifest.family !== 'bitcoin')
      throw new Error('Bitcoin chain required');
    const rpc = this.providers.client(chain);
    const genesis = await rpc.call<string>('getblockhash', [0]);
    if (genesis !== manifest.network_fingerprint)
      throw new KansoError(
        'NETWORK_MISMATCH',
        'Bitcoin RPC must match the custody network',
      );
    const tx = await rpc.call<{
      hex: string;
      blockhash?: string;
      confirmations?: number;
    }>('getrawtransaction', [transaction_id, true]);
    if (
      !tx.blockhash ||
      !Number.isSafeInteger(tx.confirmations) ||
      tx.confirmations! < manifest.minimum_confirmations
    )
      throw new KansoError(
        'SETTLEMENT_RECONCILING',
        'Bitcoin transaction needs more confirmations',
        true,
      );
    const block = await rpc.call<{
      hash: string;
      merkleroot: string;
      tx: string[];
    }>('getblock', [tx.blockhash, 1]);
    if (block.hash !== tx.blockhash)
      throw new KansoError('LOCK_NOT_VERIFIED', 'Bitcoin block hash mismatch');
    const observation = bitcoin_proof(
      tx.hex,
      block.hash,
      block.tx,
      block.merkleroot,
    );
    if (observation.proof.tx_id !== transaction_id.toLowerCase())
      throw new KansoError(
        'LOCK_NOT_VERIFIED',
        'Bitcoin transaction ID mismatch',
      );
    const verifier = await this.ready(chain);
    let valid: boolean;
    try {
      valid = await this.near.near_view_bytes<boolean>(
        verifier.account_id,
        'verify_transaction_inclusion_v2',
        bitcoin_proof_args(observation.proof, manifest.minimum_confirmations),
      );
    } catch (error) {
      if (!(error instanceof KansoError)) throw error;
      throw new KansoError(
        'SETTLEMENT_RECONCILING',
        'Bitcoin inclusion is not yet available in the light client',
        true,
      );
    }
    if (valid !== true)
      throw new KansoError(
        'LOCK_NOT_VERIFIED',
        'Bitcoin inclusion proof was rejected',
      );
    return observation;
  }
  async ready(chain: ChainConfiguration) {
    if (chain.manifest.family !== 'bitcoin')
      throw new Error('Bitcoin chain required');
    const binding = bitcoin_verifier
      .nullable()
      .safeParse(
        await this.near.near_view(
          this.deployment.near.coordinator,
          'get_bitcoin_verifier',
          { manifest_version: chain.manifest.version },
        ),
      );
    if (!binding.success)
      throw new KansoError(
        'RPC_UNAVAILABLE',
        'Malformed Bitcoin verifier binding',
        true,
      );
    const verifier = binding.data;
    if (!verifier)
      throw new KansoError(
        'CAPABILITY_DISABLED',
        'Bitcoin light client is not configured for this manifest',
      );
    if (verifier.network_fingerprint !== chain.manifest.network_fingerprint)
      throw new KansoError(
        'NETWORK_MISMATCH',
        'Bitcoin light client network mismatch',
      );
    const response = light_client_tip.safeParse(
      await this.near.near_view(
        verifier.account_id,
        'get_last_block_header',
        {},
      ),
    );
    if (!response.success)
      throw new KansoError(
        'RPC_UNAVAILABLE',
        'Malformed Bitcoin light-client tip',
        true,
      );
    const tip = response.data;
    const now = Math.floor(Date.now() / 1000);
    if (
      tip.block_header.time > now + 7200 ||
      tip.block_header.time + verifier.max_tip_age_seconds < now
    )
      throw new KansoError(
        'SETTLEMENT_RECONCILING',
        'Bitcoin light client is stale',
        true,
      );
    return verifier;
  }
}
