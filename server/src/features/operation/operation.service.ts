import { operation_plan, operation_snapshot, KansoError } from '@kanso/schema';
import type { Deployment, OperationPlan } from '@kanso/schema';
import { plan_hash, scoped_id, canonical_json, unbase64 } from '@kanso/sdk';
import type { CoordinatorClient } from '@kanso/sdk';
import type { OperationRepo } from '@server/features/operation/operation.repo';
import type { OperationPlanner } from '@server/features/operation/operation.planner';
import type { RequestService } from '@server/features/request/request.service';
export class OperationService {
  constructor(
    readonly repo: OperationRepo,
    private readonly planner: OperationPlanner,
    private readonly d: Deployment,
    private readonly near: CoordinatorClient,
    private readonly requests: RequestService,
  ) {}
  async authorize(owner: string, p: OperationPlan) {
    if (p.kind === 'setup') {
      if (p.offer.borrower !== owner)
        throw new KansoError('FORBIDDEN', 'Offer owner mismatch');
      await this.requests.validate(owner, {
        basket: p.offer.legs,
        loan_terms: {
          principal_atomic: p.offer.principal_atomic,
          duration_seconds: p.offer.duration_seconds,
          payout_account: p.offer.payout_account,
        },
        conditional_repayment: p.conditional_repayment,
      });
    }
    if (
      'loan_id' in p &&
      ![
        'repayment',
        'wallet_payment',
        'payment_refund',
        'loss_recognition',
      ].includes(p.kind)
    ) {
      const loan = await this.near.view('get_loan', { loan_id: p.loan_id });
      if (loan.offer.borrower !== owner)
        throw new KansoError('FORBIDDEN', 'Borrower required');
      if (p.kind === 'topup' || p.kind === 'replacement') {
        await this.requests.validate(owner, {
          basket: [p.kind === 'topup' ? p.leg : p.incoming],
          loan_terms: {
            principal_atomic: '1',
            duration_seconds: 1,
            payout_account: owner,
          },
          conditional_repayment: null,
        });
      }
    }
    if (p.kind === 'wallet_payment') {
      const leg_id = await this.near.view('wallet_payment_leg_id', {
        loan_id: p.loan_id,
        payer: owner,
        payment_id: p.payment_id,
      });
      if (leg_id !== p.leg.leg_id)
        throw new KansoError(
          'INVALID_INPUT',
          'Payment leg identity differs from coordinator derivation',
        );
      await this.requests.validate(owner, {
        basket: [p.leg],
        loan_terms: {
          principal_atomic: '1',
          duration_seconds: 1,
          payout_account: owner,
        },
        conditional_repayment: null,
      });
    }
    if (p.kind === 'payment_refund') {
      const loan = await this.near.view('get_loan', { loan_id: p.loan_id });
      const lock = loan.locks.find((l) => l.leg.leg_id === p.leg_id);
      if (lock?.purpose.kind !== 'payment' || lock.purpose.payer !== owner)
        throw new KansoError('FORBIDDEN', 'Payment input owner required');
    }
    if (p.kind === 'loss_recognition') {
      const loan = await this.near.view('get_loan', { loan_id: p.loan_id });
      const pool = await this.near.view('get_pool', {
        pool_id: loan.offer.pool_id,
      });
      if (pool.manager !== owner)
        throw new KansoError('FORBIDDEN', 'Pool manager required');
    }
    if (p.kind === 'pool_policy') {
      const pool = await this.near.view('get_pool', { pool_id: p.pool_id });
      if (pool.manager !== owner)
        throw new KansoError('FORBIDDEN', 'Pool manager required');
    }
    if (p.kind === 'withdrawal_claim' || p.kind === 'withdrawal_cancel') {
      const w = await this.near.view('get_withdrawal', {
        withdrawal_id: p.withdrawal_id,
      });
      if (w?.owner !== owner)
        throw new KansoError('FORBIDDEN', 'Withdrawal owner required');
    }
    if (p.kind === 'refund') {
      const r = await this.near.view('get_refund', { refund_id: p.refund_id });
      if (r?.owner !== owner)
        throw new KansoError('FORBIDDEN', 'Refund owner required');
    }
    if (p.kind === 'settlement') {
      const loan = await this.near.view('get_loan', {
        loan_id: p.plan.loan_id,
      });
      const lock = loan.locks.find((l) => l.leg.leg_id === p.plan.leg_id);
      if (!lock)
        throw new KansoError('NOT_FOUND', 'Settlement input not found');
      const payer =
        lock.purpose.kind === 'payment'
          ? lock.purpose.payer
          : loan.offer.borrower;
      if (p.plan.kind === 'repayment' && payer !== owner)
        throw new KansoError('FORBIDDEN', 'Input owner required');
    }
  }
  async prepare(owner: string, input: unknown, key: string) {
    const p = operation_plan.parse(input);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(key))
      throw new KansoError('INVALID_INPUT', 'Invalid idempotency key');
    const operation_id = scoped_id(this.d.deployment_id, owner, key);
    try {
      const old = await this.repo.find(operation_id);
      if (old.owner !== owner || old.plan_hash !== plan_hash(p))
        throw new KansoError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key belongs to another intent',
        );
      return this.reconcile(operation_id);
    } catch (e) {
      if (!(e instanceof KansoError) || e.code !== 'NOT_FOUND') throw e;
    }
    await this.authorize(owner, p);
    const now = Math.floor(Date.now() / 1000);
    await this.repo.create(
      operation_snapshot.parse({
        operation_id,
        deployment_id: this.d.deployment_id,
        network: this.d.network,
        owner,
        revision: '1',
        plan: p,
        plan_hash: plan_hash(p),
        steps: [],
        status: 'running',
        cancellation_requested: false,
        created_at: now,
        updated_at: now,
        next_poll_after_ms: 1000,
      }),
      key,
    );
    return this.reconcile(operation_id);
  }
  async owned(owner: string, id: string) {
    const s = await this.repo.find(id);
    if (s.owner !== owner)
      throw new KansoError('FORBIDDEN', 'Operation belongs to another account');
    return s;
  }
  async reconcile(id: string) {
    const lease = await this.repo.claim(id);
    if (!lease) return this.repo.find(id);
    try {
      if (['succeeded', 'cancelled', 'failed'].includes(lease.snapshot.status))
        return lease.snapshot;
      let updated;
      try {
        updated = await this.planner.reconcile(lease.snapshot);
        updated.error = null;
      } catch (error) {
        if (!(error instanceof KansoError)) throw error;
        updated = structuredClone(lease.snapshot);
        updated.error = {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        };
        updated.status = error.retryable ? 'reconciling' : 'failed';
        updated.next_poll_after_ms = error.retryable ? 5000 : 1000;
      }
      if (
        canonical_json({ ...updated, updated_at: 0 }) ===
        canonical_json({ ...lease.snapshot, updated_at: 0 })
      )
        return lease.snapshot;
      return await this.repo.update(updated, lease.snapshot.revision);
    } finally {
      await this.repo.release(id, lease.owner);
    }
  }
  async begin(owner: string, id: string, step_id: string, revision: string) {
    const s = await this.owned(owner, id);
    if (['succeeded', 'failed', 'cancelled'].includes(s.status))
      throw new KansoError(
        'INVALID_INPUT',
        'Operation no longer accepts wallet actions',
      );
    if (s.revision !== revision)
      throw new KansoError('REVISION_CONFLICT', 'Operation changed', true);
    const step = s.steps.find((x) => x.step_id === step_id);
    if (!step || step.state !== 'pending' || !step.action)
      throw new KansoError(
        'INVALID_INPUT',
        'Step is not ready for a wallet action',
      );
    step.state = 'submitted';
    s.status = 'reconciling';
    return this.repo.update(s, s.revision);
  }
  async submit(
    owner: string,
    id: string,
    step_id: string,
    transaction_id: string,
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = await this.owned(owner, id);
      const step = s.steps.find((x) => x.step_id === step_id);
      if (!step || !['submitted', 'unknown', 'confirmed'].includes(step.state))
        throw new KansoError('INVALID_INPUT', 'No committed wallet action');
      if (step.transaction_id) {
        if (step.transaction_id !== transaction_id)
          throw new KansoError(
            'IDEMPOTENCY_CONFLICT',
            'Step already has a transaction identity',
          );
        return this.reconcile(id);
      }
      // A worker can observe finalized state before the wallet returns its transaction ID.
      if (step.state === 'confirmed') {
        const action = step.action;
        if (action?.family !== 'near')
          throw new KansoError('INVALID_INPUT', 'No unresolved wallet receipt');
        const receipt = await this.near.rpc.call<{
          status: { SuccessValue?: string };
          transaction: {
            hash: string;
            signer_id: string;
            receiver_id: string;
            actions: {
              FunctionCall?: {
                method_name: string;
                args: string;
                gas: string;
                deposit: string;
              };
            }[];
          };
        }>('tx', {
          tx_hash: transaction_id,
          sender_account_id: action.signer_id,
          wait_until: 'FINAL',
        });
        const t = receipt.transaction;
        if (
          !Object.hasOwn(receipt.status, 'SuccessValue') ||
          t.hash !== transaction_id ||
          t.signer_id !== action.signer_id ||
          t.receiver_id !== action.receiver_id ||
          t.actions.length !== action.calls.length ||
          t.actions.some((a, i) => {
            const expected = action.calls[i]!,
              actual = a.FunctionCall;
            if (
              !actual ||
              actual.method_name !== expected.method ||
              BigInt(actual.gas) !== BigInt(expected.gas) ||
              BigInt(actual.deposit) !== BigInt(expected.deposit)
            )
              return true;
            try {
              return (
                canonical_json(
                  JSON.parse(new TextDecoder().decode(unbase64(actual.args))),
                ) !== canonical_json(expected.args)
              );
            } catch {
              return true;
            }
          })
        )
          throw new KansoError(
            'INVALID_INPUT',
            'Transaction differs from the committed wallet action',
          );
      }
      step.transaction_id = transaction_id;
      try {
        await this.repo.update(s, s.revision);
        return this.reconcile(id);
      } catch (error) {
        if (
          !(
            error instanceof KansoError && error.code === 'REVISION_CONFLICT'
          ) ||
          attempt === 2
        )
          throw error;
      }
    }
    throw new KansoError(
      'REVISION_CONFLICT',
      'Operation changed while recording its wallet receipt',
      true,
    );
  }
  async rejected(owner: string, id: string, step_id: string) {
    const s = await this.owned(owner, id);
    const step = s.steps.find((x) => x.step_id === step_id);
    if (!step || step.state !== 'submitted' || step.transaction_id)
      throw new KansoError('INVALID_INPUT', 'Broadcast already unresolved');
    step.state = 'pending';
    s.status = 'requires_action';
    return this.repo.update(s, s.revision);
  }
  async cancel(owner: string, id: string) {
    const s = await this.owned(owner, id);
    if (s.plan.kind !== 'setup')
      throw new KansoError(
        'INVALID_INPUT',
        'Use the contract-specific cancellation operation',
      );
    if (
      s.steps.some(
        (x) =>
          x.step_id === 'fund' &&
          ['submitted', 'unknown', 'confirmed'].includes(x.state),
      )
    )
      throw new KansoError(
        'SETTLEMENT_RECONCILING',
        'Resolve principal payout before cancelling',
        true,
      );
    s.cancellation_requested = true;
    await this.repo.update(s, s.revision);
    return this.reconcile(id);
  }
}
