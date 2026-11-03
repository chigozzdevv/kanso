import { JsonRpc, delay } from '@kanso/sdk';
import { KansoError } from '@kanso/schema';
import type { ChainConfiguration, Deployment } from '@kanso/schema';

export interface RpcSettings {
  BASE_RPC_URL?: string | undefined;
  BITCOIN_RPC_URL?: string | undefined;
  TATUM_API_KEY?: string | undefined;
}

export class RpcProvider {
  constructor(
    private readonly settings: RpcSettings = {},
    private readonly send: typeof fetch = globalThis.fetch,
  ) {}

  client(chain: ChainConfiguration) {
    const override =
      chain.manifest.chain_id === 'base'
        ? this.settings.BASE_RPC_URL
        : chain.manifest.chain_id === 'bitcoin'
          ? this.settings.BITCOIN_RPC_URL
          : undefined;
    const url = override ?? chain.rpc_url;
    const endpoint = new URL(url);
    const tatum = endpoint.hostname.endsWith('.gateway.tatum.io');
    if (
      tatum &&
      (endpoint.protocol !== 'https:' ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash)
    )
      throw new Error('Tatum RPC requires HTTPS and header authentication');
    const key = tatum ? this.settings.TATUM_API_KEY : undefined;
    const send: typeof fetch = async (input, init) => {
      if (!key) return this.send(input, init);
      const target = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (target.origin !== endpoint.origin)
        throw new Error('RPC credential destination changed');
      const headers = new Headers(init?.headers);
      headers.set('x-api-key', key);
      for (let attempt = 0; ; attempt++) {
        const response = await this.send(input, {
          ...init,
          headers,
          redirect: 'error',
        });
        if (response.status !== 429 || attempt === 3) return response;
        const retry_after = response.headers.get('retry-after');
        const requested =
          retry_after === null
            ? 0
            : Number.isFinite(Number(retry_after))
              ? Number(retry_after) * 1000
              : Date.parse(retry_after) - Date.now();
        const wait_ms = Math.max(
          1000 * 2 ** attempt,
          Number.isFinite(requested) ? requested : 0,
        );
        if (wait_ms > 10_000) return response;
        await response.body?.cancel();
        await delay(wait_ms, init?.signal ?? undefined);
      }
    };
    return new JsonRpc(url, send);
  }

  async verify(deployment: Deployment) {
    for (const chain of deployment.chains) {
      const id = chain.manifest.chain_id;
      if (
        !(id === 'base' && this.settings.BASE_RPC_URL) &&
        !(id === 'bitcoin' && this.settings.BITCOIN_RPC_URL)
      )
        continue;
      const rpc = this.client(chain);
      const actual = await rpc.call<string>(
        id === 'bitcoin' ? 'getblockhash' : 'eth_chainId',
        id === 'bitcoin' ? [0] : [],
      );
      const expected = chain.manifest.network_fingerprint;
      const matches =
        id === 'bitcoin'
          ? actual === expected
          : BigInt(actual) === BigInt(expected);
      if (!matches)
        throw new KansoError(
          'NETWORK_MISMATCH',
          `Configured ${id} RPC does not match the deployed network`,
        );
    }
  }
}
