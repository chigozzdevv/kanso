import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport, JsonRpc } from '@kanso/sdk';

afterEach(() => vi.unstubAllGlobals());

describe('browser fetch binding', () => {
  it('retains the browser receiver for API and RPC requests', async () => {
    const receivers: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      async function (this: unknown, input: Parameters<typeof fetch>[0]) {
        receivers.push(this);
        return Response.json(
          String(input).includes('/rpc')
            ? { result: 'confirmed' }
            : { ready: true },
        );
      },
    );
    expect(
      await new HttpTransport('https://kanso.example').request(
        'GET',
        '/v1/pools',
      ),
    ).toEqual({ ready: true });
    expect(
      await new JsonRpc('https://kanso.example/rpc').call('query', {}),
    ).toBe('confirmed');
    expect(receivers).toEqual([globalThis, globalThis]);
  });
});
