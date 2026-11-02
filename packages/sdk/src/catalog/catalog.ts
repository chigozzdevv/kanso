import { asset, pool_record } from '@kanso/schema';
import type { Context } from '@sdk/client/context';
export class Catalog {
  constructor(private readonly context: Context) {}
  async chains(): Promise<unknown> {
    return this.context.http.request('GET', '/v1/catalog/chains');
  }
  async assets() {
    return asset
      .array()
      .parse(await this.context.http.request('GET', '/v1/catalog/assets'));
  }
  async pools() {
    return pool_record
      .array()
      .parse(await this.context.http.request('GET', '/v1/pools'));
  }
  async capabilities(): Promise<unknown> {
    return this.context.http.request('GET', '/v1/catalog/capabilities');
  }
}
