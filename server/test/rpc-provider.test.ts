import { describe, expect, it, vi } from 'vitest';
import { chain_manifest, deployment } from '@kanso/schema';
import type { ChainConfiguration } from '@kanso/schema';
import { RpcProvider } from '@server/shared/near/rpc.provider';
import fixture from '@test/fixtures/coordinator-wire.json';

const bitcoin_genesis =
  '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';
const chain = (id: 'base' | 'bitcoin'): ChainConfiguration => ({
  manifest: chain_manifest.parse({
    ...fixture.manifest,
    chain_id: id,
    family: id === 'bitcoin' ? 'bitcoin' : 'evm',
    network_fingerprint: id === 'bitcoin' ? bitcoin_genesis : '84532',
    ...(id === 'bitcoin'
      ? { asset_id: 'btc', decimals: 8, vault: [], controller: [] }
      : {}),
  }),
  rpc_url: `https://${id}.public.example`,
  evidence: null,
});
const settings = {
  TATUM_API_KEY: 'test-credential',
  BASE_RPC_URL: 'https://base-sepolia.gateway.tatum.io',
  BITCOIN_RPC_URL: 'https://bitcoin-testnet.gateway.tatum.io',
};
const configuration = deployment.parse({
  deployment_id: 'rpc_test',
  network: 'testnet',
  near: {
    rpc_url: 'http://localhost:1',
    coordinator: 'coordinator.testnet',
    settlement_token: 'token.testnet',
    settlement_decimals: 6,
  },
  pool_ids: [],
  chains: [chain('base'), chain('bitcoin')],
});

describe('private RPC connections', () => {
  it('bounds repeated Tatum throttling and backs off even with a malformed retry header', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn<typeof fetch>(
        async () =>
          new Response('Rate limited', {
            status: 429,
            headers: { 'retry-after': 'invalid' },
          }),
      );
      const result = new RpcProvider(settings, send)
        .client(chain('bitcoin'))
        .call('getblockhash', [0]);
      const rejected = expect(result).rejects.toMatchObject({
        code: 'RPC_UNAVAILABLE',
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(7000);
      await rejected;
      expect(send).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
  it('retries a Tatum rate limit with the same authenticated request', async () => {
    vi.useFakeTimers();
    try {
      const send = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response('Rate limited', {
            status: 429,
            headers: { 'retry-after': '1' },
          }),
        )
        .mockResolvedValueOnce(Response.json({ result: bitcoin_genesis }));
      const result = new RpcProvider(settings, send)
        .client(chain('bitcoin'))
        .call('getblockhash', [0]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toBe(bitcoin_genesis);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0]![1]?.body).toBe(send.mock.calls[1]![1]?.body);
      expect(
        new Headers(send.mock.calls[1]![1]?.headers).get('x-api-key'),
      ).toBe(settings.TATUM_API_KEY);
      expect(send.mock.calls[1]![1]?.redirect).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });
  it('authenticates Tatum in headers, blocks redirects and preserves public configuration', async () => {
    const original = structuredClone(configuration);
    const send = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({
        result: request.method === 'eth_chainId' ? '0x14a34' : bitcoin_genesis,
      });
    });
    const rpc = new RpcProvider(settings, send);
    await rpc.verify(configuration);
    expect(configuration).toEqual(original);
    expect(send.mock.calls.map(([url]) => url)).toEqual([
      settings.BASE_RPC_URL,
      settings.BITCOIN_RPC_URL,
    ]);
    for (const [url, init] of send.mock.calls) {
      expect(new Headers(init?.headers).get('x-api-key')).toBe(
        settings.TATUM_API_KEY,
      );
      expect(init?.redirect).toBe('error');
      expect(String(url)).not.toContain(settings.TATUM_API_KEY);
      expect(init?.body).not.toContain(settings.TATUM_API_KEY);
    }
  });

  it('does not send a Tatum key to another provider', async () => {
    const send = vi.fn<typeof fetch>(async () =>
      Response.json({ result: '0x14a34' }),
    );
    await new RpcProvider({ TATUM_API_KEY: settings.TATUM_API_KEY }, send)
      .client(chain('base'))
      .call('eth_chainId', []);
    expect(String(send.mock.calls[0]![0])).toBe(chain('base').rpc_url);
    expect(new Headers(send.mock.calls[0]![1]?.headers).has('x-api-key')).toBe(
      false,
    );
  });

  it.each(['base', 'bitcoin'] as const)(
    'rejects a %s override serving another network',
    async (id) => {
      const send = vi.fn<typeof fetch>(async () =>
        Response.json({ result: id === 'base' ? '0x2105' : 'wrong-genesis' }),
      );
      await expect(
        new RpcProvider(settings, send).verify({
          ...configuration,
          chains: [chain(id)],
        }),
      ).rejects.toMatchObject({ code: 'NETWORK_MISMATCH' });
    },
  );

  it('rejects credentials in a Tatum URL before making a request', () => {
    const send = vi.fn<typeof fetch>();
    const rpc = new RpcProvider(
      {
        ...settings,
        BASE_RPC_URL: settings.BASE_RPC_URL + '?xApiKey=test-credential',
      },
      send,
    );
    expect(() => rpc.client(chain('base'))).toThrow('header authentication');
    expect(send).not.toHaveBeenCalled();
  });
});
