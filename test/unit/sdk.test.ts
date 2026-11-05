import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  deployment,
  operation_snapshot,
  loan_offer,
  operation_step,
  basket_repayment_quote,
  repayment_estimate,
} from '@kanso/schema';
import type { OperationPlan } from '@kanso/schema';
import {
  CoordinatorClient,
  coordinator_transaction,
  token_transaction,
  plan_hash,
  scoped_id,
} from '@kanso/sdk';
import { assert_action_intent } from '@sdk/operation/intent';
import { Context } from '@sdk/client/context';
import { Wallets } from '@sdk/wallet/resolver';
import { validate_checkpoint } from '@sdk/operation/checkpoint';
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
const owner = 'borrower.near';
function snapshot(plan: OperationPlan) {
  return operation_snapshot.parse({
    operation_id: scoped_id('test'),
    deployment_id: d.deployment_id,
    network: d.network,
    owner,
    revision: '1',
    plan,
    plan_hash: plan_hash(plan),
    steps: [],
    status: 'requires_action',
    created_at: 1,
    updated_at: 1,
    next_poll_after_ms: 1000,
    cancellation_requested: false,
  });
}
const step = (action: unknown) =>
  operation_step.parse({
    step_id: 'deposit',
    label: 'Deposit',
    family: 'near',
    chain_id: 'near',
    state: 'pending',
    action,
    transaction_id: null,
    error: null,
  });
afterEach(() => vi.restoreAllMocks());
describe('SDK signing boundaries', () => {
  it('allows only the reviewed token amount, pool, receiver and replay identity', async () => {
    const s = snapshot({
        kind: 'pool_deposit',
        pool_id: 'pool',
        amount_atomic: '100',
      }),
      near = new CoordinatorClient(d);
    const intent = {
      kind: 'pool_deposit',
      pool_id: 'pool',
      operation_id: s.operation_id,
    };
    await expect(
      assert_action_intent(
        s,
        step(token_transaction(d, owner, '100', intent)),
        near,
      ),
    ).resolves.toBeUndefined();
    for (const action of [
      token_transaction(d, owner, '101', intent),
      token_transaction(d, owner, '100', { ...intent, pool_id: 'other' }),
      token_transaction(d, owner, '100', { ...intent, operation_id: 'other' }),
      {
        ...token_transaction(d, owner, '100', intent),
        receiver_id: 'other.near',
      },
      coordinator_transaction(d, owner, 'withdraw_storage', {
        amount_atomic: '100',
        transfer_id: 'other',
      }),
    ])
      await expect(
        assert_action_intent(s, step(action), near),
      ).rejects.toThrow();
  });
  it('rejects added calls, owner changes, excess deposits and arbitrary MPC authorization', async () => {
    const s = snapshot({
        kind: 'pool_create',
        pool_id: 'pool',
        policy: fixture.loan.policy,
      }),
      near = new CoordinatorClient(d),
      action = coordinator_transaction(d, owner, 'create_pool', {
        pool_id: 'pool',
        policy: fixture.loan.policy,
      });
    await expect(
      assert_action_intent(s, step(action), near),
    ).resolves.toBeUndefined();
    for (const a of [
      { ...action, calls: [...action.calls, ...action.calls] },
      { ...action, signer_id: 'attacker.near' },
      {
        ...action,
        calls: action.calls.map((c) => ({
          ...c,
          deposit: '1000000000000000000000000',
        })),
      },
      coordinator_transaction(d, owner, 'request_remote_signature', {
        operation_id: 'unrelated',
        attempt_id: 'initial',
        invalidation: false,
        context: {},
      }),
    ])
      await expect(assert_action_intent(s, step(a), near)).rejects.toThrow();
  });
  it('binds acceptance to the complete reviewed offer', async () => {
    const offer = loan_offer.parse(fixture.loan.offer),
      s = snapshot({ kind: 'setup', offer, conditional_repayment: null }),
      near = new CoordinatorClient(d);
    await expect(
      assert_action_intent(
        s,
        step(coordinator_transaction(d, owner, 'accept_offer', { offer })),
        near,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assert_action_intent(
        s,
        step(
          coordinator_transaction(d, owner, 'accept_offer', {
            offer: { ...offer, payout_account: 'attacker.near' },
          }),
        ),
        near,
      ),
    ).rejects.toThrow();
  });
  it('rejects an API response that substitutes a different valid plan and hash', async () => {
    const plan = {
        kind: 'pool_deposit' as const,
        pool_id: 'pool',
        amount_atomic: '100',
      },
      changed = snapshot({ ...plan, amount_atomic: '999' });
    const c = new Context({
      deployment: d,
      api_url: 'http://localhost:1',
      fetch: async () => new Response(JSON.stringify(changed), { status: 200 }),
    });
    await expect(c.prepare(plan, 'key')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });
  it('does not send through a wallet connected to another network', async () => {
    const send = vi.fn(),
      wallets = new Wallets(d, async () => ({
        family: 'near',
        accounts: async () => [{ chain_id: 'near', address: owner }],
        network: async () => 'mainnet',
        prove_ownership: async () => ({ signature: 'unused' }),
        send_transaction: send,
      }));
    await expect(
      wallets.send(
        token_transaction(d, owner, '1', {
          kind: 'pool_deposit',
          pool_id: 'pool',
          operation_id: 'payment',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_MISMATCH' });
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects checkpoints scoped to another deployment or environment', () => {
    const point = {
      version: 1,
      deployment_id: d.deployment_id,
      network: d.network,
      operation_id: 'operation',
      owner,
      plan_hash: plan_hash({}),
    };
    expect(validate_checkpoint(point, d)).toEqual(point);
    expect(() =>
      validate_checkpoint({ ...point, network: 'testnet' }, d),
    ).toThrow();
    expect(() =>
      validate_checkpoint({ ...point, deployment_id: 'another' }, d),
    ).toThrow();
  });
});

describe('basket repayment wallet boundaries', () => {
  const allocation = repayment_estimate.parse({
    mode: 'collateral',
    loan_id: 'loan',
    leg_id: 'near',
    asset_id: 'near',
    chain_id: 'near',
    decimals: 24,
    amount_atomic: '5000000',
    input_atomic: fixture.settlement.plan.input_atomic,
    net_output_atomic: '5000000',
    execution_cost_atomic: '0',
    max_source_fee_atomic: '0',
    expires_at: 1700000300,
  });
  const quote = basket_repayment_quote.parse({
    loan_id: 'loan',
    amount_atomic: '5000000',
    basket_value_atomic: '500000000',
    execution_cost_atomic: '0',
    net_output_atomic: '5000000',
    expires_at: 1700000300,
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
    allocations: [allocation],
  });
  it('binds each wallet action to both the reviewed basket limit and the actual on-chain quote', async () => {
    const state = snapshot({
      kind: 'basket_repayment',
      loan_id: 'loan',
      quote,
    });
    const plan = { ...fixture.settlement.plan, kind: 'repayment' as const };
    state.settlement_quotes = [plan];
    let onchainPlan = plan;
    const near = {
      deployment: d,
      view: async (method: string) =>
        method === 'loan_summary'
          ? { debt_atomic: '100000000' }
          : { plan: onchainPlan, state: 'funded' },
    } as unknown as CoordinatorClient;
    const action = {
      ...step(
        coordinator_transaction(d, owner, 'commit_settlement', {
          operation_id: plan.operation_id,
          transfer_id: scoped_id(
            scoped_id(state.operation_id, 'sale_0'),
            'delivery',
          ),
        }),
      ),
      step_id: 'sale_0_commit',
    };
    await expect(
      assert_action_intent(state, action, near),
    ).resolves.toBeUndefined();
    onchainPlan = { ...plan, input_atomic: '9999999999999999999999999999' };
    await expect(assert_action_intent(state, action, near)).rejects.toThrow(
      'reviewed operation',
    );
    state.settlement_quotes = [onchainPlan];
    await expect(assert_action_intent(state, action, near)).rejects.toThrow(
      'reviewed repayment limits',
    );
  });
  it('only claims settlement surplus belonging to the repayment account', async () => {
    const plan = { ...fixture.settlement.plan, kind: 'repayment' as const };
    const state = snapshot({ kind: 'settlement', plan });
    let refundOwner = 'other.near';
    const near = {
      deployment: d,
      view: async (method: string) =>
        method === 'get_settlement'
          ? { refund_id: 'surplus' }
          : { owner: refundOwner },
    } as unknown as CoordinatorClient;
    const action = {
      ...step(
        coordinator_transaction(d, owner, 'claim_refund', {
          refund_id: 'surplus',
          transfer_id: scoped_id(state.operation_id, 'surplus'),
        }),
      ),
      step_id: 'surplus',
    };
    await expect(assert_action_intent(state, action, near)).rejects.toThrow(
      'reviewed operation',
    );
    refundOwner = owner;
    await expect(
      assert_action_intent(state, action, near),
    ).resolves.toBeUndefined();
  });
});
