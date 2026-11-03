import { afterEach, describe, it, expect, vi } from 'vitest';
import { ReadMpcClient } from '@server/shared/near/read-mpc.client';
import { deployment, chain_manifest } from '@kanso/schema';
import { JsonRpc, to_hex } from '@kanso/sdk';
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
afterEach(() => vi.unstubAllGlobals());
describe('foreign observation wire encoding', () => {
  it('reconstructs the exact EVM Read MPC payload emitted by Rust and selects the committed event', async () => {
    const f = fixture.read_proof.payload.V1.values[0]!.EvmExtractedValue.Log;
    const log = {
      ...f,
      address: '0x' + f.address,
      transactionHash: '0x' + f.transaction_hash,
      blockHash: '0x' + f.block_hash,
      logIndex: '0x0',
      transactionIndex: '0x0',
      blockNumber: '0x64',
      topics: f.topics.map((x) => '0x' + x),
    };
    const send = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      const result =
        request.method === 'eth_getTransactionReceipt'
          ? {
              status: '0x1',
              blockNumber: '0x64',
              logs: [
                {
                  ...log,
                  topics: [
                    log.topics[0],
                    '0x' + '22'.repeat(32),
                    ...log.topics.slice(2),
                  ],
                },
                log,
              ],
            }
          : request.method === 'eth_getBlockByNumber'
            ? { number: '0x64' }
            : null;
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
      );
    });
    vi.stubGlobal('fetch', send);
    const observer = new ReadMpcClient(d, undefined, '1'),
      m = chain_manifest.parse(fixture.manifest);
    const actual = await observer.observe(
      { manifest: m, rpc_url: 'http://localhost:1', evidence: null },
      '0x' + '09'.repeat(32),
      'LockAccepted',
      Array(32).fill(11),
    );
    expect(actual.payload).toEqual(fixture.read_proof.payload);
    expect(send).toHaveBeenCalledTimes(2);
    expect(to_hex(m.vault)).toBe(f.address);
  });
  it('surfaces contract-level NEAR query errors and preserves an explicit block identity', async () => {
    const send = vi.fn(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(String(_input)).toBe('http://localhost:1');
        expect(init?.method).toBe('POST');
        return new Response(
          JSON.stringify({ result: { error: 'LOAN_NOT_FOUND', logs: [] } }),
        );
      },
    );
    const rpc = new JsonRpc('http://localhost:1', send);
    await expect(
      rpc.near_view(
        'kanso.near',
        'get_loan',
        { loan_id: 'missing' },
        'block_hash',
      ),
    ).rejects.toMatchObject({
      code: 'RPC_UNAVAILABLE',
      message: 'LOAN_NOT_FOUND',
    });
    const request = JSON.parse(String(send.mock.calls[0]?.[1]?.body));
    expect(request.params.block_id).toBe('block_hash');
    expect(request.params).not.toHaveProperty('finality');
  });
});
