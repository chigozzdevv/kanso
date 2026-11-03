import { KansoError } from '@kanso/schema';
import type { Deployment, Asset } from '@kanso/schema';
import type { Connection } from 'mongoose';
import { canonical_json } from '@kanso/sdk';
import { projection_models } from '@server/features/loan/loan.model';
import type { CoordinatorClient } from '@kanso/sdk';
import { BitcoinLightClient } from '@server/shared/near/bitcoin-light-client';
const symbols: Record<string, string> = {
  bitcoin: 'BTC',
  solana: 'SOL',
  sui: 'SUI',
  starknet: 'STRK',
  bnb: 'BNB',
  polygon: 'POL',
  avalanche: 'AVAX',
  hyperevm: 'HYPE',
  base: 'ETH',
  arbitrum: 'ETH',
};
export class CatalogService {
  constructor(
    readonly deployment: Deployment,
    readonly coordinator: CoordinatorClient,
    private readonly db: Connection,
    private readonly services: {
      relayer: boolean;
      solver: boolean;
      recipients: Record<string, string>;
    },
  ) {}
  chains() {
    return [
      { chain_id: 'near', family: 'near', network: this.deployment.network },
      ...this.deployment.chains.map((c) => ({
        chain_id: c.manifest.chain_id,
        family: c.manifest.family,
        network_fingerprint: c.manifest.network_fingerprint,
      })),
    ];
  }
  private async verified_chains() {
    return new Map(
      await Promise.all(
        this.deployment.chains.map(async (c) => {
          let current;
          try {
            current = await this.coordinator.view('get_chain_manifest', {
              chain_id: c.manifest.chain_id,
            });
          } catch (e) {
            if (!(
              e instanceof KansoError &&
              e.message.includes('MANIFEST_NOT_FOUND')
            ))
              throw e;
          }
          let verified =
            canonical_json(current) === canonical_json(c.manifest) &&
            !!c.evidence &&
            this.services.relayer;
          if (verified && c.manifest.family === 'bitcoin') {
            try {
              await new BitcoinLightClient(
                this.deployment,
                undefined,
                this.coordinator.rpc,
              ).ready(c);
            } catch (error) {
              if (!(error instanceof KansoError)) throw error;
              verified = false;
            }
          }
          return [c.manifest.chain_id, verified] as const;
        }),
      ),
    );
  }
  async assets(): Promise<Asset[]> {
    const [verified, pauses] = await Promise.all([
      this.verified_chains(),
      this.coordinator.view('get_pause_flags'),
    ]);
    return [
      {
        asset_id: 'near',
        chain_id: 'near',
        family: 'near',
        symbol: 'NEAR',
        decimals: 24,
        network_fingerprint: this.deployment.network,
        token_address: null,
        enabled: !pauses.origination,
        reason: pauses.origination ? 'New borrowing is paused' : null,
      },
      ...this.deployment.chains.map((c) => ({
        asset_id: c.manifest.asset_id,
        chain_id: c.manifest.chain_id,
        family: c.manifest.family,
        symbol: symbols[c.manifest.chain_id] ?? c.manifest.asset_id,
        decimals: c.manifest.decimals,
        network_fingerprint: c.manifest.network_fingerprint,
        token_address: c.manifest.asset_address.length
          ? '0x' +
            c.manifest.asset_address
              .map((x) => x.toString(16).padStart(2, '0'))
              .join('')
          : null,
        enabled:
          !pauses.origination &&
          !!verified.get(c.manifest.chain_id) &&
          c.manifest.new_locks_enabled &&
          c.manifest.signing_enabled,
        reason: verified.get(c.manifest.chain_id)
          ? null
          : 'Manifest evidence or reconciliation relayer is unavailable',
      })),
    ];
  }
  async capabilities() {
    const pauses = await this.coordinator.view('get_pause_flags');
    return (await this.assets()).map((a) => ({
      chain_id: a.chain_id,
      asset_id: a.asset_id,
      deposit: a.enabled,
      read_mpc:
        !['near', 'bitcoin'].includes(a.family) &&
        this.services.relayer &&
        a.reason === null,
      light_client:
        a.family === 'bitcoin' && this.services.relayer && a.reason === null,
      verification:
        a.family === 'near'
          ? 'native'
          : a.family === 'bitcoin'
            ? 'bitcoin_light_client'
            : 'read_mpc',
      signing:
        a.family === 'near' ||
        (this.services.relayer &&
          a.reason === null &&
          !!this.deployment.chains.find(
            (c) => c.manifest.chain_id === a.chain_id,
          )?.manifest.signing_enabled),
      conversion:
        !pauses.settlements &&
        this.services.solver &&
        (a.family === 'near' ||
          (a.enabled && !!this.services.recipients[a.chain_id])),
      provider: this.services.solver ? 'internal_testnet_solver' : null,
    }));
  }
  async pools() {
    const indexed = await projection_models(this.db)
      .pools.find({ deployment_id: this.deployment.deployment_id })
      .lean();
    const pools = await Promise.all(
      [
        ...new Set([
          ...this.deployment.pool_ids,
          ...indexed.map((x) => x.pool_id),
        ]),
      ].map((pool_id) => this.coordinator.maybe_view('get_pool', { pool_id })),
    );
    return pools.filter((p): p is NonNullable<typeof p> => p !== null);
  }
}
