import { KansoError } from '@kanso/schema';
import { base64 } from '@sdk/transport/codec';

export class JsonRpcError extends KansoError {
  constructor(
    method: string,
    public readonly fault: unknown,
  ) {
    super('RPC_UNAVAILABLE', `RPC ${method}: ${JSON.stringify(fault)}`, true);
  }
}

export class JsonRpc {
  private sequence = 0;
  constructor(
    readonly url: string,
    private readonly send: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}
  async call<T>(method: string, params: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.send(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++this.sequence,
          method,
          params,
        }),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new KansoError(
        'RPC_UNAVAILABLE',
        `RPC transport failed for ${method}`,
        true,
      );
    }
    if (!response.ok)
      throw new KansoError(
        'RPC_UNAVAILABLE',
        `RPC ${method} returned HTTP ${response.status}`,
        true,
      );
    const result = (await response.json()) as {
      result?: T;
      error?: { message?: string; data?: unknown };
    };
    if (result.error) throw new JsonRpcError(method, result.error);
    if (!('result' in result))
      throw new KansoError(
        'RPC_UNAVAILABLE',
        'Malformed JSON-RPC response',
        true,
      );
    return result.result as T;
  }
  async near_view<T>(
    account_id: string,
    method_name: string,
    args: Record<string, unknown>,
    block_id?: string,
  ): Promise<T> {
    return this.near_view_bytes(
      account_id,
      method_name,
      new TextEncoder().encode(JSON.stringify(args)),
      block_id,
    );
  }
  async near_view_bytes<T>(
    account_id: string,
    method_name: string,
    args: Uint8Array,
    block_id?: string,
  ): Promise<T> {
    const result = await this.call<{ result?: number[]; error?: string }>(
      'query',
      {
        request_type: 'call_function',
        ...(block_id ? { block_id } : { finality: 'final' }),
        account_id,
        method_name,
        args_base64: base64(args),
      },
    );
    if (result.error)
      throw new KansoError('RPC_UNAVAILABLE', result.error, true);
    if (!Array.isArray(result.result))
      throw new KansoError(
        'RPC_UNAVAILABLE',
        'Malformed NEAR view result',
        true,
      );
    return JSON.parse(
      new TextDecoder().decode(Uint8Array.from(result.result)),
    ) as T;
  }
}
