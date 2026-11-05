// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  loan_record,
  repayment_estimate,
  settlement_plan,
  basket_repayment_quote,
} from '@kanso/schema';
import type { LoanSummary } from '@kanso/schema';
import type { Kanso, Operation } from '@kanso/sdk';
import { useKanso } from '@client/components/layout/providers';
import { RepaymentFlow } from '@client/features/repayment/flow';
import { checkedSettlement } from '@client/features/repayment/state';
import { inputAmount, parseAmount } from '@client/lib/amounts';
import fixture from '@test/fixtures/coordinator-wire.json';

vi.mock('@client/components/layout/providers', () => ({ useKanso: vi.fn() }));
vi.mock('@client/features/borrow/lock-progress', () => ({
  LockProgress: ({ onDone }: { onDone: () => void }) =>
    createElement('button', { onClick: onDone }, 'Finish operation'),
}));

const estimate = repayment_estimate.parse({
  mode: 'wallet',
  loan_id: 'loan',
  leg_id: null,
  asset_id: 'near',
  chain_id: 'near',
  decimals: 24,
  amount_atomic: '10000000',
  input_atomic: '2000000000000000000000000',
  net_output_atomic: '10000000',
  execution_cost_atomic: '0',
  max_source_fee_atomic: '0',
  expires_at: 2000000000,
});

const basket = basket_repayment_quote.parse({
  loan_id: 'loan',
  amount_atomic: estimate.amount_atomic,
  basket_value_atomic: '500000000',
  execution_cost_atomic: '0',
  net_output_atomic: estimate.net_output_atomic,
  expires_at: estimate.expires_at,
  sources: [
    {
      leg_id: 'near',
      asset_id: 'near',
      chain_id: 'near',
      decimals: 24,
      available_atomic: fixture.loan.locks[0]!.locked_atomic,
      value_atomic: '500000000',
    },
  ],
  allocations: [{ ...estimate, mode: 'collateral', leg_id: 'near' }],
});

function setup() {
  const record = loan_record.parse(fixture.loan);
  const summary = { debt_atomic: '100000000' } as LoanSummary;
  const payment = {
    estimate: vi.fn(async () => estimate),
    review: vi.fn<ReturnType<Kanso['loan']>['repayment']['review']>(
      async () => ({
        plan: { kind: 'repayment', loan_id: 'loan', amount_atomic: '10000000' },
        plan_hash: 'hash',
        expires_at: 2000000000,
      }),
    ),
    review_basket: vi.fn<
      ReturnType<Kanso['loan']>['repayment']['review_basket']
    >(async () => ({
      plan: { kind: 'basket_repayment', loan_id: 'loan', quote: basket },
      plan_hash: 'hash',
      expires_at: basket.expires_at,
    })),
    execute: vi.fn(),
    prepare_wallet_input: vi.fn(),
    refund_wallet_input: vi.fn(),
  };
  const wallet = {
    address: 'borrower.near',
    balance: vi.fn(async () => '1000000000000000000000000000'),
  };
  const client = {
    deployment: { deployment_id: 'ui-test' },
    session: { account_id: 'borrower.near', connect: vi.fn() },
    loan: () => ({ repayment: payment, summary: async () => summary }),
    operation: vi.fn(),
  };
  const context = {
    client: client as unknown as Kanso,
    account: 'borrower.near',
    connect: vi.fn(async () => wallet),
    catalog: {
      pools: [],
      assets: [
        {
          asset_id: 'near',
          chain_id: 'near',
          family: 'near',
          symbol: 'NEAR',
          decimals: 24,
          enabled: true,
          network_fingerprint: 'sandbox',
          token_address: null,
          reason: null,
        },
      ],
    },
  };
  vi.mocked(useKanso).mockReturnValue(
    context as unknown as ReturnType<typeof useKanso>,
  );
  const onChanged = vi.fn(async () => {});
  render(createElement(RepaymentFlow, { record, summary, onChanged }));
  return { record, payment, client, context, wallet, onChanged };
}

beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('repayment screens', () => {
  it('offers Assets and Collateral and treats USDC as a payment asset', async () => {
    const { payment } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Repay' }));
    expect(screen.getByRole('button', { name: 'Assets' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collateral' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'USDC · NEAR' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Repay amount · USDC'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review repayment' }));
    await screen.findByRole('button', { name: 'Confirm repayment' });
    expect(payment.review).toHaveBeenCalledWith({
      mode: 'direct',
      amount_atomic: '10000000',
    });
    expect(payment.execute).not.toHaveBeenCalled();
    expect(payment.prepare_wallet_input).not.toHaveBeenCalled();
  });
  it('reviews wallet funding separately and preserves an operation for resumption', async () => {
    const { payment, client } = setup();
    payment.prepare_wallet_input.mockResolvedValue({
      operation_id: 'payment-op',
    } as Operation);
    fireEvent.click(screen.getByRole('button', { name: 'Repay' }));
    fireEvent.change(screen.getByLabelText('Asset'), {
      target: { value: 'asset:near' },
    });
    fireEvent.change(screen.getByLabelText('Repay amount · USDC'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review repayment' }));
    await screen.findByRole('button', { name: 'Deposit payment asset' });
    expect(payment.prepare_wallet_input).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Deposit payment asset' }),
    );
    await screen.findByRole('button', { name: 'Finish operation' });
    expect(payment.execute).not.toHaveBeenCalled();
    const sent = payment.prepare_wallet_input.mock.calls[0]![0];
    expect(sent.asset.amount_atomic).toBe(estimate.input_atomic);
    const saved = JSON.parse(
      localStorage.getItem(
        `kanso:repayment:${client.deployment.deployment_id}:loan`,
      )!,
    );
    expect(saved.phase).toBe('wallet_payment');
    expect(saved.amount_atomic).toBe('10000000');
  });
  it('rechecks the quote after wallet funding and keeps the asset return available on failure', async () => {
    const { payment, record, onChanged } = setup();
    payment.estimate.mockRejectedValueOnce(new Error('Price is stale'));
    const lock = {
      ...record.locks[0]!,
      purpose: { kind: 'payment', payment_id: 'pay', payer: 'borrower.near' },
      leg: { ...record.locks[0]!.leg, leg_id: 'pay' },
    };
    record.locks.push(lock as (typeof record.locks)[number]);
    localStorage.setItem(
      'kanso:repayment:ui-test:loan',
      JSON.stringify({
        owner: 'borrower.near',
        phase: 'wallet_payment',
        operation_id: 'saved',
        amount_atomic: '10000000',
      }),
    );
    cleanup();
    const context = vi.mocked(useKanso).mock.results[0]!.value;
    context.client.operation = vi.fn(async () => ({
      snapshot: async () => ({
        owner: 'borrower.near',
        status: 'succeeded',
        plan: { kind: 'wallet_payment', loan_id: 'loan', leg: lock.leg },
      }),
    })) as unknown as Kanso['operation'];
    render(
      createElement(RepaymentFlow, {
        record,
        summary: { debt_atomic: '100000000' } as LoanSummary,
        onChanged,
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Resume payment' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Finish operation' }),
    );
    await screen.findByText('Price is stale');
    expect(payment.estimate).toHaveBeenCalledWith({
      mode: 'wallet',
      leg_id: 'pay',
      amount_atomic: '10000000',
    });
    expect(payment.execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.getByRole('button', { name: 'Return asset' })).toBeTruthy();
  });
  it('rejects amounts above the current debt before asking for a quote', async () => {
    const { payment } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Repay' }));
    fireEvent.change(screen.getByLabelText('Repay amount · USDC'), {
      target: { value: '101' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review repayment' }));
    await screen.findByText('Enter an amount up to the current debt.');
    expect(payment.review).not.toHaveBeenCalled();
  });
  it('blocks expired direct reviews', async () => {
    const { payment } = setup();
    payment.review.mockResolvedValue({
      plan: { kind: 'repayment', loan_id: 'loan', amount_atomic: '10000000' },
      plan_hash: 'hash',
      expires_at: 1,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Repay' }));
    fireEvent.change(screen.getByLabelText('Repay amount · USDC'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review repayment' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Confirm repayment' }),
    );
    await screen.findByText('This quote expired. Review your repayment again.');
    expect(payment.execute).not.toHaveBeenCalled();
  });
  it('reviews the whole basket and does not ask users to choose an individual collateral asset', async () => {
    const { payment } = setup();
    payment.execute.mockResolvedValue({ operation_id: 'repay' } as Operation);
    fireEvent.click(screen.getByRole('button', { name: 'Repay' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collateral' }));
    expect(screen.queryByLabelText('Asset')).toBeNull();
    expect(screen.getByLabelText('Collateral basket')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Repay amount · USDC'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review repayment' }));
    const confirm = await screen.findByRole('button', {
      name: 'Confirm repayment',
    });
    expect(payment.review_basket).toHaveBeenCalledWith('10000000');
    expect(payment.estimate).not.toHaveBeenCalled();
    expect(screen.getByText('500 USDC')).toBeTruthy();
    expect(screen.getByText('2 NEAR')).toBeTruthy();
    expect(payment.execute).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await screen.findByRole('button', { name: 'Finish operation' });
    expect(payment.execute).toHaveBeenCalledOnce();
    expect(payment.prepare_wallet_input).not.toHaveBeenCalled();
  });
  it('does not deposit an amount exceeding the source wallet balance', async () => {
    const { payment, wallet } = setup();
    wallet.balance.mockResolvedValue('1');
    fireEvent.click(screen.getByRole('button', { name: 'Repay' }));
    fireEvent.change(screen.getByLabelText('Asset'), {
      target: { value: 'asset:near' },
    });
    fireEvent.change(screen.getByLabelText('Repay amount · USDC'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review repayment' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Deposit payment asset' }),
    );
    await screen.findByText(
      'Your NEAR amount exceeds the available wallet balance.',
    );
    expect(payment.prepare_wallet_input).not.toHaveBeenCalled();
  });
});

describe('repayment review safety', () => {
  it('preserves dust and large editable amounts', () => {
    for (const value of ['1', '1000000000000000000000000', '9007199254740993'])
      expect(parseAmount(inputAmount(value, 24), 24)).toBe(value);
  });
  it('rejects a lowered output or changed input, recipient leg and costs', () => {
    const expected = { ...estimate, leg_id: 'near' };
    const plan = settlement_plan.parse({
      ...fixture.settlement.plan,
      loan_id: 'loan',
      leg_id: 'near',
      input_atomic: estimate.input_atomic,
      net_output_atomic: estimate.net_output_atomic,
      execution_cost_atomic: '0',
      max_source_fee_atomic: '0',
      expires_at: 2000000000,
    });
    const review = {
      plan: { kind: 'settlement' as const, plan },
      plan_hash: 'hash',
      expires_at: 2000000000,
    };
    expect(checkedSettlement(expected, review).input_atomic).toBe(
      estimate.input_atomic,
    );
    for (const patch of [
      { net_output_atomic: '9999999' },
      { input_atomic: '1' },
      { leg_id: 'other' },
      { execution_cost_atomic: '1' },
      { max_source_fee_atomic: '1' },
    ])
      expect(() =>
        checkedSettlement(expected, {
          ...review,
          plan: { ...review.plan, plan: { ...plan, ...patch } },
        }),
      ).toThrow('quote changed');
  });
});
