import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { KansoError } from '@kanso/schema';
import { scoped_id, delay, coordinator_transaction } from '@kanso/sdk';
import { NearSigner } from '@server/shared/near/coordinator.client';
import { RemoteActionRepo } from '@server/features/operation/remote-action.repo';
import { vi } from 'vitest';
import type { Operation } from '@kanso/sdk';
async function complete(op: Operation) {
  const end = Date.now() + 60000;
  for (;;) {
    const s = await op.execute();
    if (s.status === 'succeeded' || s.status === 'failed' || Date.now() > end)
      return s;
    await delay(100);
  }
}
import { integration_context } from '@test/integration/context';
import type { IntegrationContext } from '@test/integration/context';
import { policy, NEAR, signed } from '@test/sandbox/context';

describe('headless SDK, API, transactional journal and workers on actual local services', () => {
  let context: IntegrationContext;
  beforeAll(async () => {
    context = await integration_context();
  });
  afterAll(async () => {
    await context?.close();
  });
  it('reconciles an unknown Bitcoin proof transaction before retrying a final callback failure', async () => {
    const account = context.sandbox.borrower;
    const key = await account.getKey();
    if (!key) throw new Error('Missing sandbox account key');
    const journal = new RemoteActionRepo(context.db);
    const signer = await NearSigner.create(
      context.deployment,
      account.accountId,
      key.toString(),
      journal,
    );
    const action = coordinator_transaction(
      context.deployment,
      account.accountId,
      'submit_bitcoin_delivery',
      { operation_id: 'missing_spend', proof: {}, raw_transaction: [] },
    );
    const id = 'bitcoin_proof_retry';
    const prepare = vi.spyOn(signer.account, 'prepare');
    const unavailable = vi
      .spyOn(signer.rpc, 'call')
      .mockRejectedValue(
        new KansoError('RPC_UNAVAILABLE', 'Transport interrupted', true),
      );
    try {
      await expect(signer.send(action, id, true)).rejects.toMatchObject({
        code: 'RPC_UNAVAILABLE',
      });
      const pending = await journal.model.findById(id).lean();
      expect(pending?.state).toBe('prepared');
      await expect(signer.send(action, id, true)).rejects.toMatchObject({
        code: 'RPC_UNAVAILABLE',
      });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect((await journal.model.findById(id).lean())?.transaction_id).toBe(
        pending?.transaction_id,
      );
    } finally {
      unavailable.mockRestore();
    }
    await expect(signer.send(action, id, true)).rejects.toMatchObject({
      code: 'SETTLEMENT_RECONCILING',
      retryable: true,
    });
    await expect(signer.send(action, id, true)).rejects.toMatchObject({
      code: 'SETTLEMENT_RECONCILING',
      retryable: true,
    });
    const effects = await journal.model
      .find({ _id: { $in: [id, `${id}-retry-1`] } })
      .lean();
    expect(effects).toHaveLength(2);
    expect(effects.every((e) => e.state === 'failed')).toBe(true);
    expect(new Set(effects.map((e) => e.transaction_id)).size).toBe(2);
    await expect(
      signer.send(
        coordinator_transaction(
          context.deployment,
          account.accountId,
          'fund_loan',
          {},
        ),
        'unsafe_retry',
        true,
      ),
    ).rejects.toThrow('Only Bitcoin inclusion');
    prepare.mockRestore();
  });
  it('records a late wallet receipt after canonical confirmation and rejects unrelated transactions', async () => {
    const { sandbox: b, runtime: r } = context;
    const client = context.client(b.lp);
    await client.session.connect(b.lp.accountId);
    const op = await client.pools.create({
      pool_id: 'late_receipt',
      policy,
      idempotency_key: 'late_receipt',
    });
    const snapshot = await op.snapshot();
    const step = snapshot.steps.find((s) => s.state === 'pending' && s.action);
    if (step?.action?.family !== 'near')
      throw new Error('Expected NEAR wallet action');
    const action = step.action;
    await r.operations.begin(
      b.lp.accountId,
      op.operation_id,
      step.step_id,
      snapshot.revision,
    );
    const call = action.calls[0]!;
    const sent = await b.lp.callRaw(
      action.receiver_id,
      call.method,
      call.args,
      {
        gas: BigInt(call.gas),
        attachedDeposit: BigInt(call.deposit),
      },
    );
    expect(sent.failed).toBe(false);
    const end = Date.now() + 30000;
    for (;;) {
      const state = await r.operations.reconcile(op.operation_id);
      if (
        state.steps.find((s) => s.step_id === step.step_id)?.state ===
        'confirmed'
      )
        break;
      if (Date.now() >= end)
        throw new Error('Canonical pool creation did not reconcile');
      await delay(100);
    }
    const unrelated = await b.lp.callRaw(
      b.coordinator,
      'storage_deposit',
      {},
      {
        gas: BigInt(call.gas),
        attachedDeposit: 10n ** 21n,
      },
    );
    await expect(
      r.operations.submit(
        b.lp.accountId,
        op.operation_id,
        step.step_id,
        unrelated.transactionReceipt.hash,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const id = sent.transactionReceipt.hash;
    const accepted = await r.operations.submit(
      b.lp.accountId,
      op.operation_id,
      step.step_id,
      id,
    );
    expect(
      accepted.steps.find((s) => s.step_id === step.step_id)?.transaction_id,
    ).toBe(id);
    const replay = await r.operations.submit(
      b.lp.accountId,
      op.operation_id,
      step.step_id,
      id,
    );
    expect(replay.revision).toBe(accepted.revision);
    await expect(
      r.operations.submit(
        b.lp.accountId,
        op.operation_id,
        step.step_id,
        unrelated.transactionReceipt.hash,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('creates an LP-funded pool, borrows, resumes after restart, repays and releases through the SDK', async () => {
    const { sandbox } = context;
    const lp = context.client(sandbox.lp),
      borrower = context.client(sandbox.borrower);
    await lp.session.connect(sandbox.lp.accountId);
    const created = await lp.pools.create({
      pool_id: 'sdk_pool',
      policy,
      idempotency_key: 'pool_create',
    });
    expect((await complete(created)).status).toBe('succeeded');
    const deposit = await lp.pool('sdk_pool').deposit({
      amount_atomic: '1000000000',
      idempotency_key: 'pool_deposit',
    });
    expect((await complete(deposit)).status).toBe('succeeded');
    const original = await lp.pool('sdk_pool').summary();
    expect(original.pool.cash_atomic).toBe('1000000000');
    const terms = await sandbox.offer('unused', 'sdk_pool');
    const request = borrower.request({
      basket: terms.legs.map((l) => ({
        asset_id: l.asset_id,
        amount_atomic: l.amount_atomic,
      })),
      loan_terms: {
        principal_atomic: '100000000',
        duration_seconds: 3600,
        payout_account: sandbox.borrower.accountId,
      },
      conditional_repayment: { enabled: false },
    });
    await request.connect_required_wallets();
    const { offers } = await request.offers();
    expect(offers).toHaveLength(1);
    const selected = offers[0]!;
    const setup = await request.accept({
      offer_id: selected.offer_id,
      idempotency_key: 'borrow',
    });
    expect((await borrower.loan(selected.offer_id).record()).state).toBe(
      'pending_funding',
    );
    const checkpoint = setup.checkpoint();
    await context.restart();
    const reconnected = context.client(sandbox.borrower);
    await reconnected.session.connect(sandbox.borrower.accountId);
    const resumed = await reconnected.operations.resume(checkpoint);
    const balance = await sandbox.token_balance(sandbox.borrower);
    expect((await complete(resumed)).status).toBe('succeeded');
    expect(await sandbox.token_balance(sandbox.borrower)).toBe(
      balance + 100_000_000n,
    );
    await resumed.execute();
    expect(await sandbox.token_balance(sandbox.borrower)).toBe(
      balance + 100_000_000n,
    );
    const loan = reconnected.loan(selected.offer_id);
    const review = await loan.repayment.review({
      mode: 'direct',
      amount_atomic: '200000000',
    });
    const repayment = await loan.repay({
      review,
      idempotency_key: 'repayment',
    });
    expect((await complete(repayment)).status).toBe('succeeded');
    expect((await loan.summary()).debt_atomic).toBe('0');
    const release = await loan.collateral.release({
      leg_id: 'near',
      idempotency_key: 'release',
    });
    expect((await complete(release)).status).toBe('succeeded');
    expect((await loan.record()).locks[0]!.locked_atomic).toBe('0');
    const position = lp.pool('sdk_pool').position(sandbox.lp.accountId);
    const shares = (await position.summary()).shares;
    const claim = await position.request_withdrawal({
      shares,
      idempotency_key: 'request_exit',
    });
    expect((await complete(claim)).status).toBe('succeeded');
    const withdrawal_id = claim.operation_id;
    const exit = await position.claim_withdrawal({
      withdrawal_id,
      idempotency_key: 'claim_exit',
    });
    expect((await complete(exit)).status).toBe('succeeded');
    expect((await position.summary()).shares).toBe('0');
    expect(
      (await reconnected.loans.list()).some(
        (value) => value.loan_id === selected.offer_id,
      ),
    ).toBe(true);
    await sandbox.lp.call(
      sandbox.coordinator,
      'close_pool',
      { pool_id: 'sdk_pool' },
      signed,
    );
    await expect
      .poll(
        async () =>
          (await reconnected.loans.list()).some(
            (value) => value.loan_id === selected.offer_id,
          ),
        { timeout: 10000, interval: 200 },
      )
      .toBe(false);
    await context.runtime.indexer.projections.pools.deleteOne({
      pool_id: 'sdk_pool',
    });
    await context.workers.indexer.tick();
    expect(
      (await reconnected.catalog.pools()).some(
        (value) => value.pool_id === 'sdk_pool',
      ),
    ).toBe(false);
    expect((await loan.record()).state).toBe('repaid');
  });
  async function active(loan_id: string, collateral?: bigint[]) {
    const b = context.sandbox;
    const lp = context.client(b.lp);
    await lp.session.connect(b.lp.accountId);
    expect(
      (
        await complete(
          await lp.pools.create({
            pool_id: loan_id,
            policy,
            idempotency_key: 'create_' + loan_id,
          }),
        )
      ).status,
    ).toBe('succeeded');
    expect(
      (
        await complete(
          await lp.pool(loan_id).deposit({
            amount_atomic: '1000000000',
            idempotency_key: 'fund_' + loan_id,
          }),
        )
      ).status,
    ).toBe('succeeded');
    const offer = await b.offer(loan_id, loan_id);
    if (collateral)
      offer.legs = collateral.map((amount, index) => ({
        ...offer.legs[0]!,
        leg_id: `near_${index}`,
        amount_atomic: amount.toString(),
      }));
    await b.borrower.call(b.coordinator, 'accept_offer', { offer }, signed);
    for (const leg of offer.legs)
      await b.borrower.call(
        b.coordinator,
        'lock_native',
        { loan_id, leg_id: leg.leg_id },
        { ...signed, attachedDeposit: BigInt(leg.amount_atomic) },
      );
    await b.borrower.call(
      b.coordinator,
      'fund_loan',
      { loan_id, transfer_id: loan_id + '_fund' },
      signed,
    );
    const client = context.client(b.borrower);
    await client.session.connect(b.borrower.accountId);
    for (let i = 0; i < 100; i++) {
      if ((await client.loan(loan_id).record()).started_at) {
        await context.workers.indexer.tick();
        expect(
          (await client.loans.list()).some(
            (value) => value.loan_id === loan_id,
          ),
        ).toBe(true);
        return { client, loan: client.loan(loan_id) };
      }
      await delay(50);
    }
    throw new Error('Loan funding did not finalize');
  }
  it('handles native top-ups, revision-bound withdrawals and incoming-first replacements', async () => {
    const { client, loan } = await active('manage');
    const owner = context.sandbox.borrower.accountId;
    const extra = {
      asset_id: 'near',
      custody: { family: 'near' as const },
      leg_id: 'extra',
      owner,
      amount_atomic: (20n * NEAR).toString(),
      release_recipient: owner,
    };
    const topup = await loan.collateral.top_up({
      leg: extra,
      idempotency_key: 'topup',
    });
    expect((await complete(topup)).status).toBe('succeeded');
    expect(
      (
        await client.coordinator.view('get_topup', {
          operation_id: scoped_id(topup.operation_id, 'topup'),
        })
      )?.accepted,
    ).toBe(true);
    const before = await loan.record();
    const withdraw = await loan.collateral.withdraw({
      leg_id: 'extra',
      amount_atomic: (5n * NEAR).toString(),
      expected_revision: before.revision,
      idempotency_key: 'excess',
    });
    expect((await complete(withdraw)).status).toBe('succeeded');
    const replacement = await loan.collateral.replace({
      incoming: { ...extra, leg_id: 'replacement' },
      outgoing_leg_id: 'extra',
      outgoing_amount_atomic: (15n * NEAR).toString(),
      expected_revision: (await loan.record()).revision,
      idempotency_key: 'replace',
    });
    expect((await complete(replacement)).status).toBe('succeeded');
    expect(
      (await loan.record()).locks.find((l) => l.leg.leg_id === 'extra')
        ?.locked_atomic,
    ).toBe('0');
    const stale = await loan.collateral.withdraw({
      leg_id: 'replacement',
      amount_atomic: '1',
      expected_revision: before.revision,
      idempotency_key: 'stale',
    });
    await expect(stale.execute()).rejects.toThrow();
  });
  it('funds solver escrow before converting pledged collateral and returns a wallet input independently', async () => {
    const { loan, client } = await active('conversion');
    const estimate = await loan.repayment.estimate({
      mode: 'collateral',
      leg_id: 'near',
      amount_atomic: '10000000',
    });
    const review = await loan.repayment.review({
      mode: 'collateral',
      leg_id: 'near',
      input_atomic: estimate.input_atomic,
      max_execution_cost_atomic: estimate.execution_cost_atomic,
    });
    const repayment = await loan.repay({ review, idempotency_key: 'sale' });
    const result = await complete(repayment);
    expect(result.error, result.error?.message).toBeNull();
    expect(result.status).toBe('succeeded');
    expect(BigInt((await loan.summary()).debt_atomic)).toBeLessThan(91000000n);
    const walletEstimate = await loan.repayment.estimate({
      mode: 'wallet',
      asset_id: 'near',
      amount_atomic: '2000000',
    });
    const payment = await loan.repayment.prepare_wallet_input({
      asset: { asset_id: 'near', amount_atomic: NEAR.toString() },
      payment_id: 'external',
      idempotency_key: 'external',
    });
    expect((await complete(payment)).status).toBe('succeeded');
    const snap = await payment.snapshot();
    if (snap.plan.kind !== 'wallet_payment') throw new Error('Unexpected plan');
    const stranger = context.client(context.sandbox.lp);
    await stranger.session.connect(context.sandbox.lp.accountId);
    await expect(
      stranger.loan(loan.loan_id).repayment.estimate({
        mode: 'wallet',
        leg_id: snap.plan.leg.leg_id,
        amount_atomic: '2000000',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const fresh = await loan.repayment.estimate({
      mode: 'wallet',
      leg_id: snap.plan.leg.leg_id,
      amount_atomic: '2000000',
    });
    expect(fresh.input_atomic).toBe(walletEstimate.input_atomic);
    const walletReview = await loan.repayment.review({
      mode: 'wallet',
      leg_id: snap.plan.leg.leg_id,
      input_atomic: fresh.input_atomic,
      max_execution_cost_atomic: fresh.execution_cost_atomic,
    });
    const beforeRepayment = BigInt((await loan.summary()).debt_atomic);
    expect(
      (
        await complete(
          await loan.repay({
            review: walletReview,
            idempotency_key: 'wallet_conversion',
          }),
        )
      ).status,
    ).toBe('succeeded');
    expect(BigInt((await loan.summary()).debt_atomic)).toBeLessThan(
      beforeRepayment - 1900000n,
    );
    const capacity = (await loan.summary()).borrowing_capacity_atomic;
    const refund = await loan.repayment.refund_wallet_input({
      leg_id: snap.plan.leg.leg_id,
      idempotency_key: 'payment_refund',
    });
    expect((await complete(refund)).status).toBe('succeeded');
    expect((await loan.summary()).borrowing_capacity_atomic).toBe(capacity);
    const lp = context.client(context.sandbox.lp);
    await lp.session.connect(context.sandbox.lp.accountId);
    await context.workers.indexer.tick();
    expect(
      (await client.catalog.pools()).some((p) => p.pool_id === 'conversion'),
    ).toBe(true);
  });
  it('repays from a valued basket across two collateral sources and resumes the staged sales after restart', async () => {
    const { loan } = await active('basket_repay', [
      18n * NEAR,
      18n * NEAR,
      18n * NEAR,
    ]);
    const owner = context.sandbox.borrower.accountId;
    const review = await loan.repayment.review_basket('100000000');
    if (review.plan.kind !== 'basket_repayment')
      throw new Error('Expected basket repayment');
    expect(review.plan.quote.basket_value_atomic).toBe('270000000');
    expect(review.plan.quote.allocations).toHaveLength(2);
    const repayment = await loan.repay({
      review,
      idempotency_key: 'basket_sale',
    });
    const checkpoint = repayment.checkpoint();
    await context.restart();
    const client = context.client(context.sandbox.borrower);
    await client.session.connect(owner);
    const resumed = await client.operations.resume(checkpoint);
    const result = await complete(resumed);
    expect(result.error, JSON.stringify(result.error)).toBeNull();
    expect(result.status).toBe('succeeded');
    expect(result.settlement_quotes).toHaveLength(2);
    expect(BigInt((await loan.summary()).debt_atomic)).toBeLessThan(1000000n);
    const remaining = (await loan.record()).locks
      .filter((lock) => lock.purpose.kind === 'collateral')
      .reduce((sum, lock) => sum + BigInt(lock.locked_atomic), 0n);
    expect(remaining).toBe(34n * NEAR);
  });
  it('claims excess USDC for the borrower before a collateral settlement is reported complete', async () => {
    const { loan } = await active('sale_surplus');
    const review = await loan.repayment.review({
      mode: 'collateral',
      leg_id: 'near',
      input_atomic: (30n * NEAR).toString(),
      max_execution_cost_atomic: '0',
    });
    const repayment = await loan.repay({
      review,
      idempotency_key: 'surplus_sale',
    });
    const result = await complete(repayment);
    expect(result.error, JSON.stringify(result.error)).toBeNull();
    expect(result.status).toBe('succeeded');
    expect((await loan.summary()).debt_atomic).toBe('0');
    if (review.plan.kind !== 'settlement')
      throw new Error('Expected settlement');
    const settled = await context.runtime.coordinator.view('get_settlement', {
      operation_id: review.plan.plan.operation_id,
    });
    expect(settled?.refund_id).toBeTruthy();
    const refund = await context.runtime.coordinator.view('get_refund', {
      refund_id: settled!.refund_id!,
    });
    expect(refund?.owner).toBe(context.sandbox.borrower.accountId);
    expect(refund?.paid).toBe(true);
  });
  it('returns expired uncommitted solver escrow after a failed operation', async () => {
    const { loan } = await active('expired_solver');
    const r = context.runtime,
      b = context.sandbox;
    const quoted = await r.solver.quote({
      loan_id: loan.loan_id,
      leg_id: 'near',
      input_atomic: NEAR.toString(),
      max_execution_cost_atomic: '0',
    });
    const { operation_id: discard, ...fields } = quoted;
    expect(discard).toBeTruthy();
    fields.expires_at = (await r.coordinator.now()) + 10;
    const plan = {
      operation_id: scoped_id(
        'solver-quote',
        context.deployment.deployment_id,
        JSON.stringify(fields),
      ),
      ...fields,
    };
    const initial = await b.token_balance(b.lp);
    await r.solver.quote_on_chain(plan);
    await r.solver.fund(plan);
    const operation = await r.operations.prepare(
      b.borrower.accountId,
      { kind: 'settlement', plan },
      'expired_solver',
    );
    await r.repo.update({ ...operation, status: 'failed' }, operation.revision);
    while ((await r.coordinator.now()) < plan.expires_at) await delay(100);
    const end = Date.now() + 20000;
    while ((await b.token_balance(b.lp)) < initial && Date.now() < end) {
      await context.workers.tick();
      await delay(100);
    }
    expect(await b.token_balance(b.lp)).toBe(initial);
    expect(
      (
        await r.coordinator.view('get_settlement', {
          operation_id: plan.operation_id,
        })
      )?.state,
    ).toBe('cancelled');
    expect(
      (await r.coordinator.view('get_loan', { loan_id: loan.loan_id }))
        .locks[0]!.locked_atomic,
    ).toBe((100n * NEAR).toString());
  });
  it('executes cumulative conditional repayment within its budget after a price trigger', async () => {
    const { loan } = await active('conditional_loan');
    const terms = {
      enabled: true,
      trigger_health_ppm: 2000000,
      target_health_ppm: 2200000,
      max_total_repayment_atomic: '15000000',
      max_collateral_spend: [
        { asset_id: 'near', max_total_atomic: (10n * NEAR).toString() },
      ],
      max_execution_cost_bps: 0,
      max_execution_cost_atomic: '0',
      expires_at: null,
    };
    const config = await loan.conditional_repayment.update({
      terms,
      expected_version: 0,
      idempotency_key: 'authorize',
    });
    expect((await complete(config)).status).toBe('succeeded');
    await context.sandbox.refresh_price('2500000');
    const end = Date.now() + 60000;
    let authorization = await loan.conditional_repayment.get();
    while (
      BigInt(authorization?.consumed_repayment_atomic ?? '0') === 0n &&
      Date.now() < end
    ) {
      await context.workers.tick();
      await delay(200);
      authorization = await loan.conditional_repayment.get();
    }
    expect(
      BigInt(authorization?.consumed_repayment_atomic ?? '0'),
    ).toBeGreaterThan(0n);
    expect(
      BigInt(authorization!.consumed_repayment_atomic),
    ).toBeLessThanOrEqual(15000000n);
    expect(
      BigInt(authorization!.reserved_repayment_atomic) +
        BigInt(authorization!.consumed_repayment_atomic),
    ).toBeLessThanOrEqual(15000000n);
    await context.sandbox.refresh_price();
  });
  it('recovers a verified underwater loan through funded keeper liquidation', async () => {
    const { loan } = await active('liquidation_loan');
    await context.sandbox.refresh_price('1400000');
    const end = Date.now() + 60000;
    while (
      BigInt((await loan.summary()).health_ppm ?? '0') < 1300000n &&
      Date.now() < end
    ) {
      await context.workers.tick();
      await delay(200);
    }
    const repaired = await loan.summary();
    expect(BigInt(repaired.debt_atomic)).toBeLessThan(100000000n);
    expect(BigInt(repaired.health_ppm ?? '0')).toBeGreaterThanOrEqual(1300000n);
    await context.sandbox.refresh_price();
  });
  it('prevents session challenge replay and funds and withdraws storage through the SDK', async () => {
    const b = context.sandbox,
      c = context.client(b.borrower);
    await c.session.connect(b.borrower.accountId);
    const deposit = await c.storage.deposit({
      account_id: b.borrower.accountId,
      amount_atomic: NEAR.toString(),
      idempotency_key: 'storage',
    });
    expect((await complete(deposit)).status).toBe('succeeded');
    const withdrawn = await c.storage.withdraw({
      amount_atomic: (NEAR / 10n).toString(),
      idempotency_key: 'storage_return',
    });
    expect((await complete(withdrawn)).status).toBe('succeeded');
    const used = await context.runtime.auth.models.challenges
      .findOne({ used: true, 'challenge.purpose': 'login' })
      .lean();
    expect(used).not.toBeNull();
    await expect(
      context.runtime.auth.verify({ challenge_id: used!._id, signature: '1' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('aborts an accepted setup and returns a lock whose wallet response was lost', async () => {
    const b = context.sandbox;
    await b.create_pool('cancel_setup');
    const offer = await b.offer('cancel_setup_loan', 'cancel_setup');
    const prepared = await context.runtime.operations.prepare(
      b.borrower.accountId,
      { kind: 'setup', offer, conditional_repayment: null },
      'cancel_setup',
    );
    const c = context.client(b.borrower);
    await c.session.connect(b.borrower.accountId);
    const op = await c.operation(prepared.operation_id);
    await op.execute({ max_steps: 1 });
    for (let i = 0; i < 100; i++) {
      if (
        (await op.snapshot()).steps.some(
          (x) => x.step_id === 'accept' && x.state === 'confirmed',
        )
      )
        break;
      await delay(50);
    }
    const lossy = context.client(b.borrower, { lose_reply: () => true });
    await lossy.session.connect(b.borrower.accountId);
    const locking = await lossy.operation(op.operation_id);
    await expect(locking.execute({ max_steps: 1 })).rejects.toThrow(
      'Connection lost after broadcast',
    );
    await op.cancel();
    const end = Date.now() + 30000;
    let state = await op.snapshot();
    while (
      state.status !== 'cancelled' &&
      state.status !== 'failed' &&
      Date.now() < end
    ) {
      await op.execute();
      await delay(100);
      state = await op.snapshot();
    }
    expect(state.status, JSON.stringify(state)).toBe('cancelled');
    const loan = await b.loan(offer.offer_id);
    expect(loan.started_at).toBe(0);
    expect(loan.locks[0]!.locked_atomic).toBe('0');
    expect(loan.locks[0]!.reserved_atomic).toBe('0');
  });
  it('recovers a lost wallet response using canonical state without sending another transfer', async () => {
    const { sandbox } = context;
    await sandbox.create_pool('lost_response');
    let lose = true,
      sends = 0;
    const client = context.client(sandbox.lp, {
      lose_reply: () => {
        sends++;
        if (lose) {
          lose = false;
          return true;
        }
        return false;
      },
    });
    await client.session.connect(sandbox.lp.accountId);
    const op = await client
      .pool('lost_response')
      .deposit({ amount_atomic: '1000000', idempotency_key: 'lost_deposit' });
    const before = await sandbox.token_balance(sandbox.lp);
    await expect(op.execute()).rejects.toThrow(
      'Connection lost after broadcast',
    );
    expect(sends).toBe(1);
    const resumed = await client.operations.resume(op.checkpoint());
    expect((await complete(resumed)).status).toBe('succeeded');
    expect(sends).toBe(1);
    expect(await sandbox.token_balance(sandbox.lp)).toBe(before - 1_000_000n);
  });
  it('keeps private operations owner-scoped and rejects changed idempotency intent', async () => {
    const a = context.client(context.sandbox.lp),
      b = context.client(context.sandbox.borrower);
    await a.session.connect(context.sandbox.lp.accountId);
    await b.session.connect(context.sandbox.borrower.accountId);
    const operation = await a
      .pool('lost_response')
      .deposit({ amount_atomic: '2000000', idempotency_key: 'identity' });
    await expect(
      a
        .pool('lost_response')
        .deposit({ amount_atomic: '3000000', idempotency_key: 'identity' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(b.operation(operation.operation_id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      b.operations.resume({
        ...operation.checkpoint(),
        owner: context.sandbox.borrower.accountId,
      }),
    ).rejects.toBeInstanceOf(KansoError);
  });
  it('uses compare-and-swap to prevent two executors from committing the same wallet step', async () => {
    const c = context.client(context.sandbox.lp);
    await c.session.connect(context.sandbox.lp.accountId);
    const op = await c
      .pool('lost_response')
      .deposit({ amount_atomic: '1000000', idempotency_key: 'concurrent' });
    const s = await op.snapshot();
    const step = s.steps.find((x) => x.action)!;
    const owner = context.sandbox.lp.accountId;
    const results = await Promise.allSettled([
      context.runtime.operations.begin(
        owner,
        op.operation_id,
        step.step_id,
        s.revision,
      ),
      context.runtime.operations.begin(
        owner,
        op.operation_id,
        step.step_id,
        s.revision,
      ),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect(op.operation_id).toBe(scoped_id('sandbox', owner, 'concurrent'));
  });
});
