import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transactions } from 'near-api-js';
import { near_send, near_view } from '@testnet/deploy-near';
import type { Release } from '@testnet/deployment';
import { rpc } from '@testnet/network';

vi.mock('@testnet/network', () => ({
  NEAR_RPC: 'https://rpc.testnet.near.org',
  NEAR_SIGNER_RPC: 'https://test.rpc.fastnear.com',
  rpc: vi.fn(),
}));
const mocked_rpc = vi.mocked(rpc);

function context() {
  const order: string[] = [];
  const journal = {
    version: 1 as const,
    deployment_id: 'test',
    effects: {},
    contracts: {},
  };
  const save = vi.fn(async () => {
    order.push('save');
  });
  const release = { journal, save } as unknown as Release;
  const prepare = vi.fn(async () => ({
    transaction_id: 'original-hash',
    raw_transaction: 'original-signed-bytes',
  }));
  const signer = {
    accountId: 'deployer.testnet',
    prepare,
  } as unknown as Parameters<typeof near_send>[2];
  const actions = [transactions.transfer(1n)];
  mocked_rpc.mockImplementation(async (_url, method) => {
    order.push(method);
    if (method === 'send_tx')
      throw new Error('Connection closed after broadcast');
    return {
      final_execution_status: 'FINAL',
      status: { SuccessValue: '' },
      receipts_outcome: [],
    };
  });
  return { order, release, prepare, signer, actions };
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe('deployment transaction recovery', () => {
  it('waits for final receipts even when an optimistic execution already returned success', async () => {
    vi.useFakeTimers();
    const c = context();
    let queries = 0;
    mocked_rpc.mockImplementation(async (_url, method, params) => {
      if (method === 'send_tx') return {};
      expect(params).toMatchObject({
        tx_hash: 'original-hash',
        wait_until: 'NONE',
      });
      if (++queries === 1) throw new Error('UNKNOWN_TRANSACTION');
      return {
        final_execution_status: queries === 2 ? 'EXECUTED_OPTIMISTIC' : 'FINAL',
        status: { SuccessValue: '' },
        receipts_outcome: [],
      };
    });
    const pending = near_send(
      c.release,
      'deploy',
      c.signer,
      'vault.testnet',
      c.actions,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(c.release.journal.effects.deploy?.state).toBe('prepared');
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.release.journal.effects.deploy?.state).toBe('prepared');
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).state).toBe('confirmed');
    expect(c.prepare).toHaveBeenCalledTimes(1);
    expect(queries).toBe(3);
  });
  it('preserves contract panics returned inside a successful RPC query response', async () => {
    mocked_rpc.mockResolvedValue({ error: 'LOAN_NOT_FOUND', logs: [] });
    await expect(
      near_view('coordinator.testnet', 'get_loan', { loan_id: 'missing' }),
    ).rejects.toThrow('LOAN_NOT_FOUND');
  });
  it('persists the signed transaction before broadcast and reconciles an ambiguous RPC response', async () => {
    const c = context();
    const result = await near_send(
      c.release,
      'deploy',
      c.signer,
      'vault.testnet',
      c.actions,
    );
    expect(c.order).toEqual(['save', 'send_tx', 'tx', 'save']);
    expect(result).toMatchObject({
      transaction_id: 'original-hash',
      state: 'confirmed',
    });
  });
  it('resumes with the original signed bytes after a lost response without signing a second transaction', async () => {
    const c = context();
    mocked_rpc.mockRejectedValue(new Error('RPC unavailable'));
    await expect(
      near_send(c.release, 'deploy', c.signer, 'vault.testnet', c.actions),
    ).rejects.toThrow('RPC unavailable');
    expect(c.release.journal.effects.deploy?.state).toBe('prepared');
    mocked_rpc.mockImplementation(async (_url, method, params) => {
      if (method === 'send_tx') {
        expect(params).toEqual({
          signed_tx_base64: 'original-signed-bytes',
          wait_until: 'FINAL',
        });
        return {};
      }
      return { final_execution_status: 'FINAL', status: { SuccessValue: '' } };
    });
    await near_send(c.release, 'deploy', c.signer, 'vault.testnet', c.actions);
    expect(c.prepare).toHaveBeenCalledTimes(1);
  });
  it('refuses a changed receiver or amount for an existing deployment step', async () => {
    const c = context();
    await near_send(c.release, 'deploy', c.signer, 'vault.testnet', c.actions);
    mocked_rpc.mockClear();
    await expect(
      near_send(c.release, 'deploy', c.signer, 'other.testnet', c.actions),
    ).rejects.toThrow('Deployment intent changed');
    await expect(
      near_send(c.release, 'deploy', c.signer, 'vault.testnet', [
        transactions.transfer(2n),
      ]),
    ).rejects.toThrow('Deployment intent changed');
    expect(mocked_rpc).not.toHaveBeenCalled();
  });
  it('records a chain failure and blocks blind retries', async () => {
    const c = context();
    mocked_rpc.mockResolvedValue({
      final_execution_status: 'FINAL',
      status: { Failure: { ActionError: 'storage balance too low' } },
    });
    await expect(
      near_send(c.release, 'deploy', c.signer, 'vault.testnet', c.actions),
    ).rejects.toThrow('storage balance too low');
    expect(c.release.journal.effects.deploy?.state).toBe('failed');
    mocked_rpc.mockClear();
    await expect(
      near_send(c.release, 'deploy', c.signer, 'vault.testnet', c.actions),
    ).rejects.toThrow('Recorded transaction failed');
    expect(mocked_rpc).not.toHaveBeenCalled();
  });
});
