import { KansoError, kanso_error } from '@kanso/schema';
export class HttpTransport {
  token: string | undefined;
  constructor(
    private readonly url: string | undefined,
    private readonly send: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.url)
      throw new KansoError(
        'CAPABILITY_DISABLED',
        'An API URL is required for operations',
      );
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.token) headers.authorization = 'Bearer ' + this.token;
    const response = await this.send(new URL(path, this.url), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ?? AbortSignal.timeout(30000),
    });
    const data: unknown = await response.json();
    if (!response.ok) {
      const parsed = kanso_error.safeParse(data);
      if (parsed.success)
        throw new KansoError(
          parsed.data.code,
          parsed.data.message,
          parsed.data.retryable,
          parsed.data.operation_id,
        );
      throw new KansoError(
        'RPC_UNAVAILABLE',
        `API returned HTTP ${response.status}`,
        response.status >= 500,
      );
    }
    return data as T;
  }
}
