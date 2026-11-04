import { describe, expect, it, vi } from 'vitest';
import { loan_record, deployment, U128_MAX } from '@kanso/schema';
import type { CoordinatorClient } from '@kanso/sdk';
import type { NearSigner } from '@server/shared/near/coordinator.client';
import { repayment_input } from '@server/features/solver/repayment-input';
import { SolverService } from '@server/features/solver/solver.service';
import { RiskService } from '@server/features/risk/risk.service';
import { RepaymentService } from '@server/features/repayment/repayment.service';
import type { CatalogService } from '@server/features/catalog/catalog.service';
import type { OperationService } from '@server/features/operation/operation.service';
import fixture from '@test/fixtures/coordinator-wire.json';

function setup(fee = 100) {
  const loan = loan_record.parse(fixture.loan);
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
    chains: [
      {
        manifest: fixture.manifest,
        rpc_url: 'http://localhost:2',
        evidence: {
          verified_at: 1700000000,
          record_url: 'https://example.com/tx',
          deposit_transaction: 'deposit',
          release_transaction: 'release',
        },
      },
    ],
  });
  const balance = vi.fn(async () => '100000000000');
  const view = vi.fn(async (method: string) => {
    if (method === 'get_loan') return loan;
    if (method === 'loan_summary') return { debt_atomic: '100000000' };
    if (method === 'get_chain_manifest') return d.chains[0]!.manifest;
    if (method === 'get_config')
      return { max_price_age_seconds: 60, max_confidence_bps: 100 };
    return {
      price_atomic: '5000000',
      confidence_bps: 0,
      published_at: 1700000000,
    };
  });
  const near = {
    view,
    now: async () => 1700000000,
    snapshot: async () => ({ now: 1700000000, block_id: 'block' }),
    rpc: { near_view: balance },
  } as unknown as CoordinatorClient;
  const solver = new SolverService(
    d,
    near,
    { account: { accountId: 'solver.near' } } as NearSigner,
    new RiskService(d, near),
    { base: '00' },
    fee,
  );
  const assets = vi.fn(async () => [{ asset_id: 'near', enabled: true }]);
  const service = new RepaymentService(
    near,
    solver,
    {} as OperationService,
    { assets } as unknown as CatalogService,
  );
  return { loan, solver, service, balance, view, assets, d };
}

describe('repayment target sizing', () => {
  it('finds the minimum input across rounding plateaus and network costs', () => {
    const output = (n: bigint) => {
      const fair = (n * 1234567n) / 100000000n;
      return fair - (fair * 75n) / 10000n - 123n;
    };
    const target = 1000001n;
    const input = repayment_input(target, 10n ** 20n, output);
    expect(output(input)).toBeGreaterThanOrEqual(target);
    expect(output(input - 1n)).toBeLessThan(target);
  });
  it('preserves u128 precision and bounds the search', () => {
    const output = vi.fn((n: bigint) => n / 3n);
    const target = U128_MAX / 5n;
    expect(repayment_input(target, U128_MAX, output)).toBe(target * 3n);
    expect(output.mock.calls.length).toBeLessThanOrEqual(130);
  });
  it.each([0n, 9n])('rejects insufficient unreserved balance (%s)', (max) => {
    expect(() => repayment_input(10n, max, (n) => n)).toThrow('cannot cover');
  });
  it('uses the same fees and conservative price for the estimate and final quote', async () => {
    const { loan, solver } = setup();
    const estimate = await solver.estimate(loan, {
      mode: 'collateral',
      leg_id: 'near',
      amount_atomic: '10000001',
    });
    const quote = await solver.quote({
      loan_id: 'loan',
      leg_id: 'near',
      input_atomic: estimate.input_atomic,
      max_execution_cost_atomic: estimate.execution_cost_atomic,
    });
    expect(quote.net_output_atomic).toBe(estimate.net_output_atomic);
    expect(quote.execution_cost_atomic).toBe(estimate.execution_cost_atomic);
    expect(BigInt(quote.net_output_atomic)).toBeGreaterThanOrEqual(10000001n);
    expect(estimate.decimals).toBe(24);
  });
  it('deducts the Bitcoin network fee from the estimated conversion', async () => {
    const { loan, solver, d } = setup();
    d.chains[0]!.manifest.family = 'bitcoin';
    d.chains[0]!.manifest.max_network_cost_atomic = '1000000000000000';
    const estimate = await solver.estimate(loan, {
      mode: 'wallet',
      asset_id: 'base',
      amount_atomic: '1000000',
    });
    expect(estimate.max_source_fee_atomic).toBe('1000000000000000');
    expect(BigInt(estimate.execution_cost_atomic)).toBeGreaterThan(5000n);
  });
  it('rejects reserved inputs, fee policy violations and unfunded inventory', async () => {
    const { loan, solver, balance } = setup();
    loan.locks[0]!.reserved_atomic = loan.locks[0]!.locked_atomic;
    await expect(
      solver.estimate(loan, {
        mode: 'collateral',
        leg_id: 'near',
        amount_atomic: '1',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    loan.locks[0]!.reserved_atomic = '0';
    balance.mockResolvedValue('0');
    await expect(
      solver.estimate(loan, {
        mode: 'collateral',
        leg_id: 'near',
        amount_atomic: '1',
      }),
    ).rejects.toThrow('inventory');
    await expect(
      setup(501).solver.estimate(loan, {
        mode: 'collateral',
        leg_id: 'near',
        amount_atomic: '1',
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
  });
  it('authenticates input ownership and validates debt and admission before quoting', async () => {
    const { service, assets, loan } = setup();
    await expect(
      service.estimate('other.near', 'loan', {
        mode: 'collateral',
        leg_id: 'near',
        amount_atomic: '1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      service.estimate('borrower.near', 'loan', {
        mode: 'wallet',
        leg_id: 'near',
        amount_atomic: '1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.estimate('borrower.near', 'loan', {
        mode: 'collateral',
        leg_id: 'near',
        amount_atomic: '100000001',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    assets.mockResolvedValue([]);
    await expect(
      service.estimate('borrower.near', 'loan', {
        mode: 'wallet',
        asset_id: 'near',
        amount_atomic: '1',
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' });
    loan.state = 'repaid';
    await expect(
      service.estimate('borrower.near', 'loan', {
        mode: 'wallet',
        asset_id: 'near',
        amount_atomic: '1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
