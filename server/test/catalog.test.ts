import { describe, expect, it } from 'vitest';
import type { Connection } from 'mongoose';
import { chain_manifest, deployment } from '@kanso/schema';
import type { CoordinatorClient } from '@kanso/sdk';
import { CatalogService } from '@server/features/catalog/catalog.service';
import fixture from '@test/fixtures/coordinator-wire.json';

describe('capability evidence gates', () => {
  it.each([0, 7201])(
    'reports Bitcoin light-client readiness and stops new risk when headers are stale (%i seconds)',
    async (age) => {
      const genesis =
        '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';
      const manifest = chain_manifest.parse({
        ...fixture.manifest,
        chain_id: 'bitcoin',
        family: 'bitcoin',
        network_fingerprint: genesis,
      });
      const d = deployment.parse({
        deployment_id: 'sandbox_tests',
        network: 'sandbox',
        near: {
          rpc_url: 'http://localhost:1',
          coordinator: 'kanso.near',
          settlement_token: 'usdc.near',
          settlement_decimals: 6,
        },
        pool_ids: [],
        chains: [
          {
            manifest,
            rpc_url: 'http://localhost:2',
            evidence: {
              verified_at: 1700000000,
              record_url: 'https://example.com/tx',
              deposit_transaction: 'deposit',
              release_transaction: 'release',
            },
          },
        ],
      });
      const coordinator = {
        view: async (method: string) =>
          method === 'get_pause_flags'
            ? {
                origination: false,
                settlements: false,
                collateral_withdrawals: false,
              }
            : manifest,
        rpc: {
          near_view: async (_account: string, method: string) =>
            method === 'get_bitcoin_verifier'
              ? {
                  account_id: 'btc-client-v4.testnet',
                  network_fingerprint: genesis,
                  max_tip_age_seconds: 7200,
                }
              : {
                  block_height: 100,
                  block_header: { time: Math.floor(Date.now() / 1000) - age },
                },
        },
      } as unknown as CoordinatorClient;
      const catalog = new CatalogService(d, coordinator, {} as Connection, {
        relayer: true,
        solver: true,
        recipients: { bitcoin: '0014' },
      });
      const bitcoin = (await catalog.capabilities()).find(
        (c) => c.chain_id === 'bitcoin',
      );
      expect(bitcoin).toMatchObject({
        read_mpc: false,
        verification: 'bitcoin_light_client',
        light_client: age === 0,
        deposit: age === 0,
        signing: age === 0,
      });
    },
  );
  it('does not advertise remote MPC readiness merely because relayer credentials are configured', async () => {
    const manifest = chain_manifest.parse(fixture.manifest);
    const d = deployment.parse({
      deployment_id: 'sandbox_tests',
      network: 'sandbox',
      near: {
        rpc_url: 'http://localhost:1',
        coordinator: 'kanso.near',
        settlement_token: 'usdc.near',
        settlement_decimals: 6,
      },
      pool_ids: [],
      chains: [{ manifest, rpc_url: 'http://localhost:1', evidence: null }],
    });
    const coordinator = {
      view: async (method: string) =>
        method === 'get_pause_flags'
          ? {
              origination: false,
              settlements: false,
              collateral_withdrawals: false,
            }
          : manifest,
    } as unknown as CoordinatorClient;
    const catalog = new CatalogService(d, coordinator, {} as Connection, {
      relayer: true,
      solver: true,
      recipients: {},
    });
    const remote = (await catalog.capabilities()).find(
      (c) => c.chain_id === manifest.chain_id,
    );
    expect(remote).toMatchObject({
      deposit: false,
      read_mpc: false,
      signing: false,
      conversion: false,
    });
  });
});
