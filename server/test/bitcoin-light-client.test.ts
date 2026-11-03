import { describe, expect, it, vi } from 'vitest';
import { chain_manifest, deployment } from '@kanso/schema';
import { JsonRpc, bitcoin_proof_args } from '@kanso/sdk';
import { BitcoinLightClient } from '@server/shared/near/bitcoin-light-client';
import { RpcProvider } from '@server/shared/near/rpc.provider';
import fixture from '@test/fixtures/coordinator-wire.json';
import { bitcoin_block as block } from '@test/fixtures/bitcoin-block';

const genesis =
  '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';
const chain = {
  manifest: chain_manifest.parse({
    ...fixture.manifest,
    chain_id: 'bitcoin',
    family: 'bitcoin',
    network_fingerprint: genesis,
  }),
  rpc_url: 'https://bitcoin.example',
  evidence: null,
};
const config = deployment.parse({
  deployment_id: 'spv_test',
  network: 'testnet',
  near: {
    rpc_url: 'https://near.example',
    coordinator: 'kanso.testnet',
    settlement_token: 'usdc.testnet',
    settlement_decimals: 6,
  },
  chains: [chain],
  pool_ids: [],
});
function client(
  overrides: {
    genesis?: string;
    confirmations?: number;
    valid?: boolean;
    age?: number;
    configured?: boolean;
    failure?: boolean;
  } = {},
) {
  const send = vi.fn<typeof fetch>(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(url).includes('bitcoin')) {
      const result =
        request.method === 'getblockhash'
          ? (overrides.genesis ?? genesis)
          : request.method === 'getrawtransaction'
            ? {
                hex: block.hex,
                blockhash: block.hash,
                confirmations: overrides.confirmations ?? 100,
              }
            : block;
      return Response.json({ result });
    }
    const method = request.params.method_name;
    if (method === 'verify_transaction_inclusion_v2' && overrides.failure)
      return Response.json({
        result: { error: 'Block is not in the main chain' },
      });
    const result =
      method === 'get_bitcoin_verifier'
        ? overrides.configured === false
          ? null
          : {
              account_id: 'btc-client-v4.testnet',
              network_fingerprint: genesis,
              max_tip_age_seconds: 7200,
            }
        : method === 'get_last_block_header'
          ? {
              block_height: 5198573,
              block_header: {
                time: Math.floor(Date.now() / 1000) - (overrides.age ?? 0),
              },
            }
          : (overrides.valid ?? true);
    return Response.json({
      result: { result: Array.from(Buffer.from(JSON.stringify(result))) },
    });
  });
  return {
    send,
    service: new BitcoinLightClient(
      config,
      new RpcProvider({}, send),
      new JsonRpc(config.near.rpc_url, send),
    ),
  };
}
describe('Bitcoin light-client observations', () => {
  it('builds and preflights a Borsh proof without requesting read-MPC', async () => {
    const { service, send } = client();
    const observation = await service.observe(chain, block.tx[2]!);
    const queries = send.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(
      queries.some((q) =>
        JSON.stringify(q).includes('request_read_attestation'),
      ),
    ).toBe(false);
    const query = queries.find(
      (q) => q.params?.method_name === 'verify_transaction_inclusion_v2',
    );
    expect(query.params.account_id).toBe('btc-client-v4.testnet');
    expect(Buffer.from(query.params.args_base64, 'base64')).toEqual(
      Buffer.from(
        bitcoin_proof_args(
          observation.proof,
          chain.manifest.minimum_confirmations,
        ),
      ),
    );
  });
  it.each([
    [{ genesis: '00'.repeat(32) }, 'NETWORK_MISMATCH'],
    [{ confirmations: 0 }, 'SETTLEMENT_RECONCILING'],
    [{ age: 7201 }, 'SETTLEMENT_RECONCILING'],
    [{ configured: false }, 'CAPABILITY_DISABLED'],
    [{ valid: false }, 'LOCK_NOT_VERIFIED'],
    [{ failure: true }, 'SETTLEMENT_RECONCILING'],
  ] as const)(
    'rejects incompatible or unavailable source evidence: %j',
    async (overrides, code) => {
      await expect(
        client(overrides).service.observe(chain, block.tx[2]!),
      ).rejects.toMatchObject({ code });
    },
  );
});
