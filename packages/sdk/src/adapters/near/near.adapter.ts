import { coordinator_views } from '@kanso/bindings';
import type { ViewMethod, ViewResult } from '@kanso/bindings';
import type { Deployment } from '@kanso/schema';
import { JsonRpc } from '@sdk/transport/rpc';
export class CoordinatorClient {
  readonly rpc: JsonRpc;
  constructor(
    readonly deployment: Deployment,
    send?: typeof fetch,
  ) {
    this.rpc = new JsonRpc(deployment.near.rpc_url, send);
  }
  async view<M extends ViewMethod>(
    method: M,
    args: Record<string, unknown> = {},
    block_id?: string,
  ): Promise<ViewResult<M>> {
    return coordinator_views[method].parse(
      await this.rpc.near_view(
        this.deployment.near.coordinator,
        method,
        args,
        block_id,
      ),
    ) as ViewResult<M>;
  }
  async maybe_view<M extends ViewMethod>(
    method: M,
    args: Record<string, unknown>,
  ): Promise<ViewResult<M> | null> {
    try {
      return await this.view(method, args);
    } catch (error) {
      if (
        error instanceof Error &&
        /(?:LOAN|POOL|SETTLEMENT|REFUND|TOPUP|REPLACEMENT|TRANSFER|WITHDRAWAL)_NOT_FOUND/.test(
          error.message,
        )
      )
        return null;
      throw error;
    }
  }
  async snapshot() {
    const b = await this.rpc.call<{
      header: { hash: string; timestamp_nanosec: string; height: number };
    }>('block', { finality: 'final' });
    return {
      block_id: b.header.hash,
      now: Number(BigInt(b.header.timestamp_nanosec) / 1000000000n),
      height: b.header.height,
    };
  }
  async now(): Promise<number> {
    const b = await this.rpc.call<{ header: { timestamp_nanosec: string } }>(
      'block',
      { finality: 'final' },
    );
    return Number(BigInt(b.header.timestamp_nanosec) / 1000000000n);
  }
  async verify_deployment(): Promise<void> {
    const c = await this.view('get_config');
    const d = this.deployment;
    if (
      c.deployment_id !== d.deployment_id ||
      c.network !== d.network ||
      c.settlement_token !== d.near.settlement_token ||
      c.settlement_decimals !== d.near.settlement_decimals
    )
      throw new Error('Configured deployment differs from coordinator state');
  }
}
