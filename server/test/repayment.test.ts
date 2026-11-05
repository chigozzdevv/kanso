import { describe, expect, it, vi } from 'vitest';
import {
  loan_record,
  deployment,
  U128_MAX,
  operation_snapshot,
  settlement_plan,
} from '@kanso/schema';
import { assert_basket_settlement, plan_hash } from '@kanso/sdk';
import { OperationPlanner } from '@server/features/operation/operation.planner';
import type { RemoteService } from '@server/features/collateral/collateral.service';
import type { CoordinatorClient } from '@kanso/sdk';
import type { NearSigner } from '@server/shared/near/coordinator.client';
import {
  repayment_input,
  repayment_sources,
} from '@server/features/solver/repayment-input';
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
  return { loan, solver, service, balance, view, assets, d, near };
}

describe('repayment target sizing', () => {
  it('reserves enough for fixed-fee sources instead of leaving an uneconomic remainder', () => {
    const sources = [
      { minimum: 1n, maximum: 190n, fee: 0n },
      { minimum: 38n, maximum: 98n, fee: 2n },
    ];
    expect(repayment_sources(sources, 200n)).toEqual([0, 1]);
    expect(repayment_sources(sources, 50n)).toEqual([0]);
    expect(() => repayment_sources(sources, 289n)).toThrow('fee limits');
  });
  it('chooses fewer sales for equal fees and the cheapest feasible source set', () => {
    expect(
      repayment_sources(
        [
          { minimum: 1n, maximum: 30n, fee: 0n },
          { minimum: 1n, maximum: 40n, fee: 0n },
          { minimum: 1n, maximum: 80n, fee: 0n },
        ],
        70n,
      ),
    ).toEqual([2]);
    expect(
      repayment_sources(
        [
          { minimum: 1n, maximum: 30n, fee: 1n },
          { minimum: 1n, maximum: 40n, fee: 1n },
          { minimum: 1n, maximum: 80n, fee: 3n },
        ],
        70n,
      ),
    ).toEqual([0, 1]);
    expect(() =>
      repayment_sources([{ minimum: 10n, maximum: 9n, fee: 1n }], 5n),
    ).toThrow('fee limits');
  });
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

describe('collateral basket repayment', () => {
  const NEAR = 10n ** 24n;
  function split() {
    const context = setup(0);
    const first = context.loan.locks[0]!;
    first.locked_atomic = (8n * NEAR).toString();
    context.loan.locks.push({
      ...first,
      leg: { ...first.leg, leg_id: 'second' },
      locked_atomic: (6n * NEAR).toString(),
    });
    return context;
  }
  it('values every available asset and sizes the minimum sales across multiple sources', async () => {
    const { loan, solver } = split();
    const quote = await solver.basket(loan, '50000000');
    expect(quote.basket_value_atomic).toBe('70000000');
    expect(
      quote.allocations.map((allocation) => allocation.input_atomic),
    ).toEqual([(8n * NEAR).toString(), (2n * NEAR).toString()]);
    expect(quote.net_output_atomic).toBe('50000000');
    expect(quote.execution_cost_atomic).toBe('0');
  });
  it('leaves unneeded collateral unsold and rejects an underfunded basket', async () => {
    const { loan, solver } = split();
    const quote = await solver.basket(loan, '10000000');
    expect(quote.sources).toHaveLength(2);
    expect(quote.allocations).toHaveLength(1);
    expect(quote.allocations[0]!.input_atomic).toBe((2n * NEAR).toString());
    await expect(solver.basket(loan, '70000001')).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
  });
  it('sizes a fixed-fee sale above its policy minimum while valuing the whole basket', async () => {
    const { loan, solver, d } = setup(0);
    const native = loan.locks[0]!;
    native.locked_atomic = (38n * NEAR).toString();
    const manifest = d.chains[0]!.manifest;
    manifest.family = 'bitcoin';
    manifest.max_network_cost_atomic = (4n * 10n ** 17n).toString();
    loan.locks.push({
      ...native,
      leg: {
        ...native.leg,
        leg_id: 'remote',
        asset_id: manifest.asset_id,
        custody: {
          family: 'remote',
          chain_id: manifest.chain_id,
          manifest_version: manifest.version,
          lock_id: Array(32).fill(1),
          source_owner: Array(20).fill(2),
          release_recipient: Array(20).fill(3),
          min_price_atomic: '1',
          max_price_atomic: '10000000',
        },
      },
      locked_atomic: (20n * 10n ** 18n).toString(),
    });
    const quote = await solver.basket(loan, '200000000');
    expect(quote.basket_value_atomic).toBe('290000000');
    expect(
      quote.allocations.map((allocation) => allocation.amount_atomic),
    ).toEqual(['162000000', '38000000']);
    expect(quote.execution_cost_atomic).toBe('2000000');
    await expect(
      solver.estimate(loan, {
        mode: 'collateral',
        leg_id: 'remote',
        amount_atomic: '1000000',
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
  });
  it('requires the borrower and blocks unresolved collateral operations', async () => {
    const { loan, service } = split();
    await expect(
      service.review_basket('other.near', 'loan', '10000000'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    loan.active_outflow = 'pending';
    await expect(
      service.review_basket('borrower.near', 'loan', '10000000'),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_RECONCILING' });
  });
  it('persists a bounded per-asset quote before any solver funding or wallet action', async () => {
    const { loan, solver, d, near } = split();
    const quote = await solver.basket(loan, '50000000');
    const plan = { kind: 'basket_repayment' as const, loan_id: 'loan', quote };
    const state = operation_snapshot.parse({
      operation_id: 'basket',
      deployment_id: d.deployment_id,
      network: d.network,
      owner: 'borrower.near',
      revision: '1',
      plan,
      plan_hash: plan_hash(plan),
      steps: [],
      status: 'running',
      created_at: 1,
      updated_at: 1,
      next_poll_after_ms: 1000,
      cancellation_requested: false,
    });
    const fund = vi.spyOn(solver, 'fund');
    const publish = vi.spyOn(solver, 'quote_on_chain');
    const planner = new OperationPlanner(d, near, {} as RemoteService, solver);
    const staged = await planner.reconcile(state);
    expect(staged.settlement_quotes).toHaveLength(1);
    expect(staged.steps.every((step) => step.action === null)).toBe(true);
    expect(fund).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    vi.spyOn(solver, 'cancel_uncommitted').mockResolvedValue(true);
    expect(
      (await planner.reconcile({ ...staged, cancellation_requested: true }))
        .status,
    ).toBe('cancelled');
    expect(fund).not.toHaveBeenCalled();
  });
  it('rejects source amounts, costs or outputs outside the approved basket limits', async () => {
    const { loan, solver } = split();
    const quote = await solver.basket(loan, '50000000');
    const limit = quote.allocations[0]!;
    const plan = settlement_plan.parse({
      ...fixture.settlement.plan,
      input_atomic: limit.input_atomic,
      net_output_atomic: limit.net_output_atomic,
    });
    expect(() =>
      assert_basket_settlement(quote, 0, plan, BigInt(limit.amount_atomic)),
    ).not.toThrow();
    for (const patch of [
      { input_atomic: (BigInt(limit.input_atomic) + 1n).toString() },
      { execution_cost_atomic: '1' },
      { max_source_fee_atomic: '1' },
      { net_output_atomic: '1' },
      { loan_id: 'other' },
    ])
      expect(() =>
        assert_basket_settlement(
          quote,
          0,
          { ...plan, ...patch },
          BigInt(limit.amount_atomic),
        ),
      ).toThrow('reviewed repayment limits');
  });
});
