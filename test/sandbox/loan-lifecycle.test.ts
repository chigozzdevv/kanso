import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loan_summary, settlement, refund, topup } from '@kanso/schema';
import { create_sandbox, GAS, NEAR, signed } from '@test/sandbox/context';
import type { Sandbox } from '@test/sandbox/context';

describe('NEAR loan lifecycle on sandbox', () => {
  let sandbox: Sandbox;

  beforeAll(async () => {
    sandbox = await create_sandbox();
  });

  afterAll(async () => {
    await sandbox?.node.tearDown();
  });

  it('funds a loan, applies partial and full repayment, releases collateral and pays LP shares', async () => {
    const {
      coordinator,
      borrower,
      lp,
      create_pool,
      offer,
      pay,
      loan,
      operation,
      token_balance,
    } = sandbox;
    await create_pool('lifecycle');
    const terms = await offer('loan', 'lifecycle');
    await borrower.call(coordinator, 'accept_offer', { offer: terms }, signed);
    const pending = loan_summary.parse(
      await coordinator.view('loan_summary', { loan_id: 'loan' }),
    );
    expect(pending.debt_atomic).toBe('0');
    expect(pending.health_ppm).toBeNull();
    expect(pending.started_at).toBeNull();
    await borrower.call(
      coordinator,
      'lock_native',
      { loan_id: 'loan', leg_id: 'near' },
      { gas: GAS, attachedDeposit: 100n * NEAR },
    );
    const beforePayout = await token_balance(borrower);
    await borrower.call(
      coordinator,
      'fund_loan',
      { loan_id: 'loan', transfer_id: 'fund' },
      signed,
    );
    expect(await operation('fund')).toMatchObject({
      outcome: 'succeeded',
      finalized: true,
    });
    expect(await token_balance(borrower)).toBe(beforePayout + 100_000_000n);
    expect((await loan('loan')).state).toBe('active');
    await borrower.call(
      coordinator,
      'fund_loan',
      { loan_id: 'loan', transfer_id: 'fund' },
      signed,
    );
    expect(await token_balance(borrower)).toBe(beforePayout + 100_000_000n);
    await expect(
      borrower.call(
        coordinator,
        'release_collateral',
        { loan_id: 'loan', leg_id: 'near', transfer_id: 'premature' },
        signed,
      ),
    ).rejects.toThrow('DEBT_NOT_CLEARED');

    await pay(borrower, '50000000', {
      kind: 'repayment',
      loan_id: 'loan',
      operation_id: 'partial',
    });
    const partial = await loan('loan');
    expect(BigInt(partial.principal_outstanding_atomic)).toBeGreaterThan(
      50_000_000n,
    );
    expect(BigInt(partial.principal_outstanding_atomic)).toBeLessThan(
      100_000_000n,
    );
    const beforeDuplicate = await token_balance(borrower);
    expect(
      await pay(borrower, '50000000', {
        kind: 'repayment',
        loan_id: 'loan',
        operation_id: 'partial',
      }),
    ).toBe('0');
    expect(await token_balance(borrower)).toBe(beforeDuplicate);

    const beforeRepay = await token_balance(borrower);
    const used = BigInt(
      await pay(borrower, '100000000', {
        kind: 'repayment',
        loan_id: 'loan',
        operation_id: 'full',
      }),
    );
    expect(used).toBeGreaterThan(50_000_000n);
    expect(used).toBeLessThan(100_000_000n);
    expect(await token_balance(borrower)).toBe(beforeRepay - used);
    const repaid = await loan('loan');
    expect(repaid.state).toBe('repaid');
    expect(repaid.principal_outstanding_atomic).toBe('0');
    expect(repaid.locks[0]?.locked_atomic).toBe((100n * NEAR).toString());
    const beforeRelease = BigInt((await borrower.balance()).total);
    await borrower.call(
      coordinator,
      'release_collateral',
      { loan_id: 'loan', leg_id: 'near', transfer_id: 'release' },
      signed,
    );
    expect(await operation('release')).toMatchObject({
      outcome: 'succeeded',
      finalized: true,
    });
    expect(BigInt((await borrower.balance()).total)).toBeGreaterThan(
      beforeRelease + 99n * NEAR,
    );
    expect((await loan('loan')).locks[0]?.locked_atomic).toBe('0');

    const pool = await coordinator.view<{
      cash_atomic: string;
      total_shares: string;
    }>('get_pool', { pool_id: 'lifecycle' });
    expect(BigInt(pool.cash_atomic)).toBeGreaterThan(1_000_000_000n);
    await lp.call(
      coordinator,
      'request_withdrawal',
      {
        withdrawal_id: 'exit',
        pool_id: 'lifecycle',
        shares: pool.total_shares,
      },
      signed,
    );
    const beforeWithdrawal = await token_balance(lp);
    await lp.call(
      coordinator,
      'claim_withdrawal',
      { withdrawal_id: 'exit', transfer_id: 'lp_payout' },
      signed,
    );
    expect(await operation('lp_payout')).toMatchObject({
      outcome: 'succeeded',
      finalized: true,
    });
    expect(await token_balance(lp)).toBe(
      beforeWithdrawal + BigInt(pool.cash_atomic),
    );
    expect(
      await coordinator.view('get_pool', { pool_id: 'lifecycle' }),
    ).toMatchObject({
      cash_atomic: '0',
      total_shares: '0',
      in_flight_atomic: '0',
    });
  });

  it('recovers collateral after an actual token payout failure', async () => {
    const {
      coordinator,
      borrower,
      unregistered,
      create_pool,
      offer,
      operation,
      loan,
    } = sandbox;
    await create_pool('failed_payout');
    const terms = await offer('failed_loan', 'failed_payout', {
      payout_account: unregistered.accountId,
    });
    await borrower.call(coordinator, 'accept_offer', { offer: terms }, signed);
    await borrower.call(
      coordinator,
      'lock_native',
      { loan_id: 'failed_loan', leg_id: 'near' },
      { gas: GAS, attachedDeposit: 100n * NEAR },
    );
    await borrower.callRaw(
      coordinator,
      'fund_loan',
      { loan_id: 'failed_loan', transfer_id: 'failed_fund' },
      signed,
    );
    expect(await operation('failed_fund')).toMatchObject({
      outcome: 'failed',
      finalized: true,
    });
    expect(await loan('failed_loan')).toMatchObject({
      state: 'pending_funding',
      started_at: 0,
      principal_outstanding_atomic: '0',
    });
    expect(
      await coordinator.view('get_pool', { pool_id: 'failed_payout' }),
    ).toMatchObject({
      cash_atomic: '1000000000',
      reserved_atomic: '100000000',
      in_flight_atomic: '0',
    });
    await borrower.call(
      coordinator,
      'abort_setup',
      { loan_id: 'failed_loan' },
      signed,
    );
    await borrower.call(
      coordinator,
      'release_collateral',
      { loan_id: 'failed_loan', leg_id: 'near', transfer_id: 'failed_release' },
      signed,
    );
    expect((await loan('failed_loan')).setup_state).toBe('aborted');
  });

  it('preserves partial setup and accepts a recoverable late deposit after cancellation', async () => {
    const { coordinator, borrower, create_pool, offer, loan } = sandbox;
    await create_pool('partial_setup');
    const terms = await offer('partial_loan', 'partial_setup');
    const first = terms.legs[0];
    if (!first) throw new Error('Expected a native collateral leg');
    terms.legs.push({
      ...first,
      leg_id: 'late',
      amount_atomic: NEAR.toString(),
    });
    await borrower.call(coordinator, 'accept_offer', { offer: terms }, signed);
    await borrower.call(
      coordinator,
      'lock_native',
      { loan_id: 'partial_loan', leg_id: 'near' },
      { gas: GAS, attachedDeposit: 100n * NEAR },
    );
    await expect(
      borrower.call(
        coordinator,
        'fund_loan',
        { loan_id: 'partial_loan', transfer_id: 'partial_fund' },
        signed,
      ),
    ).rejects.toThrow('LOCK_NOT_VERIFIED');
    expect((await loan('partial_loan')).locks[0]?.locked_atomic).toBe(
      (100n * NEAR).toString(),
    );
    await borrower.call(
      coordinator,
      'abort_setup',
      { loan_id: 'partial_loan' },
      signed,
    );
    await borrower.call(
      coordinator,
      'lock_native',
      { loan_id: 'partial_loan', leg_id: 'late' },
      { gas: GAS, attachedDeposit: NEAR },
    );
    expect((await loan('partial_loan')).state).toBe('cancelled');
    await borrower.call(
      coordinator,
      'release_collateral',
      {
        loan_id: 'partial_loan',
        leg_id: 'near',
        transfer_id: 'partial_release',
      },
      signed,
    );
    await borrower.call(
      coordinator,
      'release_collateral',
      { loan_id: 'partial_loan', leg_id: 'late', transfer_id: 'late_release' },
      signed,
    );
    expect((await loan('partial_loan')).setup_state).toBe('aborted');
  });

  it('rejects forged token receipts and callback calls on the deployed contract', async () => {
    const { coordinator, borrower } = sandbox;
    await expect(
      borrower.call(coordinator, 'ft_on_transfer', {
        sender_id: borrower.accountId,
        amount: '1000000',
        msg: JSON.stringify({
          kind: 'pool_deposit',
          pool_id: 'partial_setup',
          operation_id: 'forged',
        }),
      }),
    ).rejects.toThrow('SETTLEMENT_TOKEN_REQUIRED');
    await expect(
      borrower.call(coordinator, 'record_transfer_result', {
        transfer_id: 'fund',
      }),
    ).rejects.toThrow(/private/i);
  });

  it('refunds a token payment when storage charging fails without leaving a partial credit', async () => {
    const { root, coordinator, token, worker, token_balance } = sandbox;
    const payer = await root.createSubAccount('no_credit', {
      initialBalance: 5n * NEAR,
    });
    await root.call(
      token,
      'storage_deposit',
      { account_id: payer.accountId },
      { attachedDeposit: NEAR / 10n },
    );
    await root.call(
      token,
      'ft_transfer',
      { receiver_id: payer.accountId, amount: '1000000' },
      signed,
    );
    const before = await coordinator.view('get_pool', {
      pool_id: 'partial_setup',
    });
    const result = await payer.callRaw(
      token,
      'ft_transfer_call',
      {
        receiver_id: coordinator.accountId,
        amount: '1000000',
        msg: JSON.stringify({
          kind: 'pool_deposit',
          pool_id: 'partial_setup',
          operation_id: 'no_storage',
        }),
      },
      signed,
    );
    expect(
      result.receiptFailureMessagesContain('STORAGE_CREDIT_REQUIRED'),
    ).toBe(true);
    expect(await token_balance(payer)).toBe(1_000_000n);
    expect(
      await coordinator.view('get_pool', { pool_id: 'partial_setup' }),
    ).toEqual(before);
    expect(
      await coordinator.view('get_payment', {
        sender_id: payer.accountId,
        operation_id: 'no_storage',
      }),
    ).toBeNull();
    expect(await worker.provider.accountExists(payer.accountId)).toBe(true);
  });
  it('settles a funded collateral sale and pays only its surplus through a durable refund', async () => {
    const {
      coordinator,
      borrower,
      lp,
      create_pool,
      offer,
      pay,
      loan,
      operation,
      token_balance,
      now,
    } = sandbox;
    await create_pool('conversion');
    const terms = await offer('conversion_loan', 'conversion');
    await borrower.call(coordinator, 'accept_offer', { offer: terms }, signed);
    await borrower.call(
      coordinator,
      'lock_native',
      { loan_id: 'conversion_loan', leg_id: 'near' },
      { gas: GAS, attachedDeposit: 100n * NEAR },
    );
    await borrower.call(
      coordinator,
      'fund_loan',
      { loan_id: 'conversion_loan', transfer_id: 'conversion_fund' },
      signed,
    );
    const before = await loan('conversion_loan');
    const plan = {
      operation_id: 'collateral_sale',
      loan_id: 'conversion_loan',
      expected_revision: before.revision,
      leg_id: 'near',
      input_atomic: (24n * NEAR).toString(),
      net_output_atomic: '120000000',
      execution_cost_atomic: '0',
      max_source_fee_atomic: '0',
      solver: lp.accountId,
      source_recipient: lp.accountId,
      remote_recipient: [],
      expires_at: (await now()) + 300,
      kind: 'repayment',
      conditional_version: 0,
    };
    await lp.call(coordinator, 'quote_settlement', { plan }, signed);
    await expect(
      borrower.call(
        coordinator,
        'commit_settlement',
        { operation_id: plan.operation_id, transfer_id: 'sale_delivery' },
        signed,
      ),
    ).rejects.toThrow('ESCROW_NOT_FUNDED');
    expect(
      await pay(lp, plan.net_output_atomic, {
        kind: 'solver_escrow',
        operation_id: plan.operation_id,
      }),
    ).toBe(plan.net_output_atomic);
    await borrower.call(
      coordinator,
      'commit_settlement',
      { operation_id: plan.operation_id, transfer_id: 'sale_delivery' },
      signed,
    );
    expect((await operation('sale_delivery')).outcome).toBe('succeeded');
    expect((await loan('conversion_loan')).state).toBe('active');
    await borrower.call(
      coordinator,
      'apply_settlement',
      { operation_id: plan.operation_id },
      { gas: GAS },
    );
    const applied = settlement.parse(
      await coordinator.view('get_settlement', {
        operation_id: plan.operation_id,
      }),
    );
    expect(applied.state).toBe('applied');
    expect(BigInt(applied.applied_atomic)).toBeGreaterThanOrEqual(100_000_000n);
    const liability = refund.parse(
      await coordinator.view('get_refund', { refund_id: applied.refund_id }),
    );
    expect(liability.owner).toBe(borrower.accountId);
    expect(
      BigInt(liability.amount_atomic) + BigInt(applied.applied_atomic),
    ).toBe(120_000_000n);
    const balance = await token_balance(borrower);
    await borrower.call(
      coordinator,
      'claim_refund',
      { refund_id: liability.refund_id, transfer_id: 'sale_surplus' },
      signed,
    );
    expect(await token_balance(borrower)).toBe(
      balance + BigInt(liability.amount_atomic),
    );
    await borrower.call(
      coordinator,
      'apply_settlement',
      { operation_id: plan.operation_id },
      { gas: GAS },
    );
    expect(await token_balance(borrower)).toBe(
      balance + BigInt(liability.amount_atomic),
    );
    const repaid = await loan('conversion_loan');
    expect(repaid.state).toBe('repaid');
    expect(repaid.locks[0]?.locked_atomic).toBe((76n * NEAR).toString());
  });

  it('keeps an external wallet payment outside collateral capacity and returns surplus to that payer', async () => {
    const {
      coordinator,
      borrower,
      lp,
      create_pool,
      offer,
      pay,
      loan,
      token_balance,
      now,
    } = sandbox;
    await create_pool('wallet');
    await borrower.call(
      coordinator,
      'accept_offer',
      { offer: await offer('wallet_loan', 'wallet') },
      signed,
    );
    await borrower.call(
      coordinator,
      'lock_native',
      { loan_id: 'wallet_loan', leg_id: 'near' },
      { gas: GAS, attachedDeposit: 100n * NEAR },
    );
    await borrower.call(
      coordinator,
      'fund_loan',
      { loan_id: 'wallet_loan', transfer_id: 'wallet_fund' },
      signed,
    );
    const leg_id = await coordinator.view<string>('wallet_payment_leg_id', {
      loan_id: 'wallet_loan',
      payer: lp.accountId,
      payment_id: 'external',
    });
    await lp.call(
      coordinator,
      'create_wallet_payment',
      {
        loan_id: 'wallet_loan',
        payment_id: 'external',
        leg: {
          asset_id: 'near',
          custody: { family: 'near' },
          leg_id,
          owner: lp.accountId,
          amount_atomic: (24n * NEAR).toString(),
          release_recipient: lp.accountId,
        },
      },
      signed,
    );
    await lp.call(
      coordinator,
      'lock_native',
      { loan_id: 'wallet_loan', leg_id },
      { gas: GAS, attachedDeposit: 24n * NEAR },
    );
    const risk = await coordinator.view<{ borrowing_capacity_atomic: string }>(
      'basket_risk',
      { loan_id: 'wallet_loan' },
    );
    expect(risk.borrowing_capacity_atomic).toBe('250000000');
    const plan = {
      operation_id: 'wallet_sale',
      loan_id: 'wallet_loan',
      expected_revision: (await loan('wallet_loan')).revision,
      leg_id,
      input_atomic: (24n * NEAR).toString(),
      net_output_atomic: '120000000',
      execution_cost_atomic: '0',
      max_source_fee_atomic: '0',
      solver: borrower.accountId,
      source_recipient: borrower.accountId,
      remote_recipient: [],
      expires_at: (await now()) + 300,
      kind: 'repayment',
      conditional_version: 0,
    };
    await borrower.call(coordinator, 'quote_settlement', { plan }, signed);
    await pay(borrower, plan.net_output_atomic, {
      kind: 'solver_escrow',
      operation_id: plan.operation_id,
    });
    await lp.call(
      coordinator,
      'commit_settlement',
      { operation_id: plan.operation_id, transfer_id: 'wallet_delivery' },
      signed,
    );
    await lp.call(
      coordinator,
      'apply_settlement',
      { operation_id: plan.operation_id },
      { gas: GAS },
    );
    const result = settlement.parse(
      await coordinator.view('get_settlement', {
        operation_id: plan.operation_id,
      }),
    );
    const liability = refund.parse(
      await coordinator.view('get_refund', { refund_id: result.refund_id }),
    );
    expect(liability.owner).toBe(lp.accountId);
    const balance = await token_balance(lp);
    await lp.call(
      coordinator,
      'claim_refund',
      { refund_id: liability.refund_id, transfer_id: 'wallet_surplus' },
      signed,
    );
    expect(await token_balance(lp)).toBe(
      balance + BigInt(liability.amount_atomic),
    );
    const closed = await loan('wallet_loan');
    expect(closed.state).toBe('repaid');
    expect(closed.locks[0]?.locked_atomic).toBe((100n * NEAR).toString());
    expect(closed.locks[1]?.locked_atomic).toBe('0');
  });

  it('replaces collateral only after the incoming deposit without resetting debt terms', async () => {
    const { coordinator, borrower, create_pool, offer, loan, operation } =
      sandbox;
    await create_pool('replacement');
    await borrower.call(
      coordinator,
      'accept_offer',
      { offer: await offer('replacement_loan', 'replacement') },
      signed,
    );
    await borrower.call(
      coordinator,
      'lock_native',
      { loan_id: 'replacement_loan', leg_id: 'near' },
      { gas: GAS, attachedDeposit: 100n * NEAR },
    );
    await borrower.call(
      coordinator,
      'fund_loan',
      { loan_id: 'replacement_loan', transfer_id: 'replacement_fund' },
      signed,
    );
    const original = await loan('replacement_loan');
    const leg = {
      asset_id: 'near',
      custody: { family: 'near' },
      leg_id: 'incoming',
      owner: borrower.accountId,
      amount_atomic: (100n * NEAR).toString(),
      release_recipient: borrower.accountId,
    };
    await borrower.call(
      coordinator,
      'commit_topup',
      { operation_id: 'replacement_topup', loan_id: 'replacement_loan', leg },
      signed,
    );
    await borrower.call(
      coordinator,
      'commit_replacement',
      {
        operation_id: 'replace',
        loan_id: 'replacement_loan',
        incoming_topup_id: 'replacement_topup',
        outgoing_leg_id: 'near',
        outgoing_amount_atomic: (100n * NEAR).toString(),
      },
      signed,
    );
    const revision = (await loan('replacement_loan')).revision;
    await expect(
      borrower.call(
        coordinator,
        'finalize_replacement',
        {
          operation_id: 'replace',
          transfer_id: 'replace_release',
          expected_revision: revision,
        },
        signed,
      ),
    ).rejects.toThrow('INCOMING_NOT_VERIFIED');
    await borrower.call(
      coordinator,
      'lock_native_topup',
      { operation_id: 'replacement_topup' },
      { gas: GAS, attachedDeposit: 100n * NEAR },
    );
    expect(
      topup.parse(
        await coordinator.view('get_topup', {
          operation_id: 'replacement_topup',
        }),
      ).accepted,
    ).toBe(true);
    await borrower.call(
      coordinator,
      'finalize_replacement',
      {
        operation_id: 'replace',
        transfer_id: 'replace_release',
        expected_revision: (await loan('replacement_loan')).revision,
      },
      signed,
    );
    expect((await operation('replace_release')).outcome).toBe('succeeded');
    const replaced = await loan('replacement_loan');
    expect(replaced.principal_outstanding_atomic).toBe(
      original.principal_outstanding_atomic,
    );
    expect(replaced.matures_at).toBe(original.matures_at);
    expect(replaced.started_at).toBe(original.started_at);
    expect(replaced.locks[0]?.locked_atomic).toBe('0');
    expect(replaced.locks[1]?.locked_atomic).toBe((100n * NEAR).toString());
  });
});
