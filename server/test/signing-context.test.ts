import { afterEach, describe, expect, it, vi } from 'vitest';
import { chain_manifest, remote_operation } from '@kanso/schema';
import { decodeFunctionData, serializeTransaction } from 'viem';
import { evm_vault_abi } from '@kanso/bindings';
import { transaction_context } from '@server/shared/near/chain-signatures.client';
import fixture from '@test/fixtures/coordinator-wire.json';

function setup() {
  const manifest = chain_manifest.parse({
    ...fixture.manifest,
    max_fee_per_gas: '1000',
    max_network_cost_atomic: '500000000',
    max_gas: 250000,
  });
  const command = {
    operation_id: Array(32).fill(1),
    lock_id: Array(32).fill(2),
    agreement: Array(32).fill(3),
    settlement_id: Array(32).fill(4),
    recipient: Array(20).fill(5),
    amount_atomic: '123',
    nonce: 0,
    deadline: 2000000000,
    kind: 1,
  };
  const op = remote_operation.parse({
    operation_id: 'sale',
    settlement_id: 'settle',
    loan_id: 'loan',
    leg_id: 'eth',
    owner: 'solver.near',
    manifest,
    command,
    state: 'prepared',
    signing_attempts: [],
    network_cost_reserved_atomic: '0',
    revision: 1,
  });
  const c = { manifest, rpc_url: 'http://localhost:1', evidence: null };
  const send = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === 'eth_estimateGas') {
      const decoded = decodeFunctionData({
        abi: evm_vault_abi,
        data: request.params[0].data,
      });
      expect(decoded.functionName).toBe('execute');
      expect(decoded.args?.[0]).toMatchObject({
        amount: 123n,
        nonce: 0n,
        kind: 1,
      });
    }
    const result =
      request.method === 'eth_getTransactionCount'
        ? '0x7'
        : request.method === 'eth_gasPrice'
          ? '0x64'
          : '0x186a0';
    return new Response(JSON.stringify({ id: request.id, result }));
  });
  vi.stubGlobal('fetch', send);
  return { op, c, send };
}
afterEach(() => vi.unstubAllGlobals());
describe('bounded source signing contexts', () => {
  it('estimates the actual authorized command and includes a nonzero EVM priority fee', async () => {
    const { op, c } = setup();
    expect(await transaction_context(c, op)).toEqual({
      family: 'evm',
      nonce: 7,
      gas_limit: 120000,
      max_fee_per_gas: '200',
      max_priority_fee_per_gas: '100',
    });
  });
  it('blocks signing when the estimated execution cannot fit the network budget', async () => {
    const { op, c } = setup();
    op.manifest.max_network_cost_atomic = '1000000';
    await expect(transaction_context(c, op)).rejects.toThrow(
      'execution exceeds gas budget',
    );
  });
  it('uses the accepted fee ceiling when a fresh market quote still fits that limit', async () => {
    const { op, c } = setup();
    op.manifest.max_fee_per_gas = '150';
    expect(await transaction_context(c, op)).toMatchObject({
      max_fee_per_gas: '150',
      max_priority_fee_per_gas: '100',
    });
    op.manifest.max_fee_per_gas = '99';
    await expect(transaction_context(c, op)).rejects.toMatchObject({
      code: 'SETTLEMENT_RECONCILING',
      retryable: true,
    });
  });
  it('reuses the original signed nonce and fee bounds after a restart without requesting another nonce', async () => {
    const { op, c, send } = setup();
    const tx = serializeTransaction({
      type: 'eip1559',
      chainId: 84532,
      nonce: 4,
      maxPriorityFeePerGas: 5n,
      maxFeePerGas: 10n,
      gas: 130000n,
      to: ('0x' + '11'.repeat(20)) as `0x${string}`,
      value: 0n,
      data: '0x',
    });
    op.signing_attempts.push({
      attempt_id: 'initial',
      transaction: Array.from(Buffer.from(tx.slice(2), 'hex')),
      payload: Array(32).fill(0),
      ed25519: false,
      signature: null,
      invalidation: false,
      account_nonce: 4,
      source_deadline: 2000000000,
    });
    expect(await transaction_context(c, op)).toEqual({
      family: 'evm',
      nonce: 4,
      gas_limit: 130000,
      max_priority_fee_per_gas: '5',
      max_fee_per_gas: '10',
    });
    expect(send).not.toHaveBeenCalled();
  });
});
