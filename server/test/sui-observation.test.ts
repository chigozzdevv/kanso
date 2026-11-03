import { afterEach, describe, expect, it, vi } from 'vitest';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { TransactionError } from '@mysten/sui/client';
import { deployment, chain_manifest } from '@kanso/schema';
import { ReadMpcClient } from '@server/shared/near/read-mpc.client';
import fixture from '@test/fixtures/coordinator-wire.json';

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
  chains: [],
});
afterEach(() => vi.restoreAllMocks());
describe('Sui transaction indexing', () => {
  it('keeps a newly broadcast Sui transaction reconciling until the RPC indexes it', async () => {
    const missing = new TransactionError('notFound', 'pending');
    vi.spyOn(SuiGrpcClient.prototype, 'getTransaction').mockRejectedValue(
      missing,
    );
    const manifest = {
      ...chain_manifest.parse(fixture.manifest),
      family: 'sui' as const,
    };
    await expect(
      new ReadMpcClient(d, undefined, '1').observe(
        { manifest, rpc_url: 'http://localhost:1', evidence: null },
        'pending',
        'CommandExecuted',
      ),
    ).rejects.toMatchObject({
      code: 'SETTLEMENT_RECONCILING',
      retryable: true,
    });
  });
  it('does not classify unrelated Sui observation failures as a pending transaction', async () => {
    const failure = new Error('Invalid response');
    vi.spyOn(SuiGrpcClient.prototype, 'getTransaction').mockRejectedValue(
      failure,
    );
    const manifest = {
      ...chain_manifest.parse(fixture.manifest),
      family: 'sui' as const,
    };
    await expect(
      new ReadMpcClient(d, undefined, '1').observe(
        { manifest, rpc_url: 'http://localhost:1', evidence: null },
        'pending',
        'CommandExecuted',
      ),
    ).rejects.toBe(failure);
  });
});
