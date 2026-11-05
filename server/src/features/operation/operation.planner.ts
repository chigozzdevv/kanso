import { KansoError } from '@kanso/schema';
import type {
  Deployment,
  OperationSnapshot,
  OperationStep,
  TransactionAction,
  Loan,
  BasketLeg,
} from '@kanso/schema';
import {
  coordinator_transaction,
  token_transaction,
  deposit_action,
  scoped_id,
  to_hex,
  digest,
  encode_offer,
} from '@kanso/sdk';
import type { CoordinatorClient } from '@kanso/sdk';
import type { RemoteService } from '@server/features/collateral/collateral.service';
import type { SolverService } from '@server/features/solver/solver.service';
import { reconcile_basket_repayment } from '@server/features/repayment/basket.workflow';
export class OperationPlanner {
  constructor(
    private readonly d: Deployment,
    private readonly near: CoordinatorClient,
    private readonly remote: RemoteService,
    private readonly solver: SolverService,
  ) {}
  async reconcile(previous: OperationSnapshot): Promise<OperationSnapshot> {
    const s = structuredClone(previous),
      p = s.plan,
      owner = s.owner,
      steps: OperationStep[] = [];
    let can_progress = true;
    const tx = (method: string, args: Record<string, unknown>, deposit = '1') =>
      coordinator_transaction(this.d, owner, method, args, deposit);
    const id = (name: string) => scoped_id(s.operation_id, name);
    const step = async (
      name: string,
      label: string,
      done: boolean,
      action: () => Promise<TransactionAction> | TransactionAction | null,
    ) => {
      const old = previous.steps.find((x) => x.step_id === name);
      let state: OperationStep['state'] = done
        ? 'confirmed'
        : (old?.state ?? 'pending');
      let error = old?.error ?? null;
      if (!done && old?.transaction_id && old.family === 'near') {
        try {
          const result = await this.near.rpc.call<{ status: unknown }>('tx', {
            tx_hash: old.transaction_id,
            sender_account_id: old.action?.signer_id ?? owner,
            wait_until: 'FINAL',
          });
          if (
            typeof result.status === 'object' &&
            result.status !== null &&
            'Failure' in result.status
          ) {
            state = 'failed';
            error = JSON.stringify(result.status.Failure);
          }
        } catch (e) {
          if (!(e instanceof KansoError)) throw e;
        }
      }
      const packet = done
        ? (old?.action ?? null)
        : !can_progress
          ? null
          : old && old.state !== 'pending'
            ? old.action
            : await action();
      const item: OperationStep = {
        step_id: name,
        label,
        family: packet?.family ?? old?.family ?? 'near',
        chain_id: packet?.chain_id ?? old?.chain_id ?? 'near',
        state,
        action: packet,
        transaction_id: old?.transaction_id ?? null,
        error,
      };
      steps.push(item);
      if (!done) can_progress = false;
      return done;
    };
    const background = async (name: string, label: string, done: boolean) =>
      step(name, label, done, () => null);
    const transfer = async (name: string) => {
      const t = await this.near.view('get_transfer', { transfer_id: id(name) });
      if (t?.finalized && t.outcome === 'failed')
        throw new KansoError(
          'INVALID_INPUT',
          'Transfer failed with a verified outcome; prepare a new operation to retry',
        );
      return !!t?.finalized && t.outcome === 'succeeded';
    };
    const payment = async (kind: string, target: string) => {
      const receipt = await this.near.view('get_payment', {
        sender_id: owner,
        operation_id: s.operation_id,
      });
      if (!receipt) return false;
      return (
        receipt.intent.kind === kind &&
        (kind === 'pool_deposit'
          ? 'pool_id' in receipt.intent && receipt.intent.pool_id === target
          : 'loan_id' in receipt.intent && receipt.intent.loan_id === target)
      );
    };
    const deposit = async (loan: Loan, leg: BasketLeg, name: string) => {
      const lock = loan.locks.find((l) => l.leg.leg_id === leg.leg_id);
      if (!lock) throw new Error('Committed lock not found');
      const custody = leg.custody;
      if (
        custody.family === 'remote' &&
        this.d.chains.find((c) => c.manifest.chain_id === custody.chain_id)
          ?.manifest.family === 'bitcoin'
      ) {
        const derived = await this.remote.bitcoin_key_ready(
          loan.loan_id,
          leg.leg_id,
        );
        if (
          !(await step(
            name + '_key',
            'Derive Bitcoin custody key',
            derived,
            () =>
              tx('derive_bitcoin_deposit_key', {
                loan_id: loan.loan_id,
                leg_id: leg.leg_id,
              }),
          ))
        )
          return;
      }
      const deposited = lock.receipt_verified;
      await step(name, 'Lock ' + leg.asset_id, deposited, () =>
        leg.custody.family === 'near' &&
        (p.kind === 'topup' || p.kind === 'replacement')
          ? tx(
              'lock_native_topup',
              { operation_id: id('topup') },
              leg.amount_atomic,
            )
          : deposit_action(
              this.d,
              loan.loan_id,
              leg,
              lock.agreement,
              lock.purpose.kind === 'payment' ? 1 : 0,
            ),
      );
      if (!deposited && leg.custody.family === 'remote') {
        const old = previous.steps.find((x) => x.step_id === name);
        if (old?.transaction_id)
          await this.remote.accept_lock(loan, leg, old.transaction_id);
      }
    };
    const release = async (
      loan: Loan,
      leg_id: string,
      amount: string,
      name: string,
      expected_revision?: string,
    ) => {
      const lock = loan.locks.find((l) => l.leg.leg_id === leg_id);
      if (!lock) throw new KansoError('NOT_FOUND', 'Collateral leg not found');
      if (lock.leg.custody.family === 'near')
        await step(
          name,
          'Release ' + lock.leg.asset_id,
          await transfer(name),
          () =>
            expected_revision
              ? tx('withdraw_excess', {
                  loan_id: loan.loan_id,
                  leg_id,
                  amount_atomic: amount,
                  transfer_id: id(name),
                  expected_revision,
                })
              : tx('release_collateral', {
                  loan_id: loan.loan_id,
                  leg_id,
                  transfer_id: id(name),
                }),
        );
      else {
        const progress = await this.remote.outgoing(
          loan,
          lock.leg,
          id(name),
          owner,
          amount,
          expected_revision ?? loan.revision,
        );
        for (const item of progress)
          await step(
            name + '_' + item.name,
            item.label,
            item.done,
            () => item.action,
          );
      }
    };
    for (const old of previous.steps) {
      const call =
        old.action?.family === 'near' ? old.action.calls[0] : undefined;
      if (call && typeof call.args.transfer_id === 'string')
        await this.remote.finalize_native(call.args.transfer_id);
      if (
        old.transaction_id &&
        call &&
        ['request_remote_signature', 'request_bitcoin_signature'].includes(
          call.method,
        )
      ) {
        const bitcoin = call.method === 'request_bitcoin_signature',
          operation_id = String(call.args.operation_id);
        const op = bitcoin
          ? await this.near.view('get_bitcoin_spend', { operation_id })
          : await this.near.view('get_remote_operation', { operation_id });
        const attempts =
          op && ('attempts' in op ? op.attempts : op.signing_attempts);
        if (
          attempts?.some(
            (a) => a.attempt_id === call.args.attempt_id && !a.signature,
          )
        )
          await this.remote.recover_signature(
            operation_id,
            String(call.args.attempt_id),
            old.transaction_id,
            owner,
            bitcoin,
          );
      }
    }
    if (p.kind === 'storage_deposit') {
      const old = previous.steps.find((x) => x.step_id === 'storage');
      let paid = false;
      if (old?.transaction_id) {
        const result = await this.near.rpc.call<{
          status: unknown;
          transaction: { signer_id: string; receiver_id: string };
        }>('tx', {
          tx_hash: old.transaction_id,
          sender_account_id: owner,
          wait_until: 'FINAL',
        });
        paid =
          !!result.status &&
          typeof result.status === 'object' &&
          'SuccessValue' in result.status &&
          result.transaction.signer_id === owner &&
          result.transaction.receiver_id === this.d.near.coordinator;
      }
      await step('storage', 'Prepay coordinator storage', paid, () =>
        tx('storage_deposit', {}, p.amount_atomic),
      );
    } else if (p.kind === 'storage_withdraw') {
      await step(
        'storage',
        'Withdraw unused storage credit',
        await transfer('storage'),
        () =>
          tx('withdraw_storage', {
            amount_atomic: p.amount_atomic,
            transfer_id: id('storage'),
          }),
      );
    } else if (p.kind === 'wallet_payment') {
      let loan = await this.near.view('get_loan', { loan_id: p.loan_id });
      if (
        await step(
          'payment_commit',
          'Commit wallet repayment input',
          loan.locks.some((l) => l.leg.leg_id === p.leg.leg_id),
          () =>
            tx('create_wallet_payment', {
              loan_id: p.loan_id,
              payment_id: p.payment_id,
              leg: p.leg,
            }),
        )
      ) {
        loan = await this.near.view('get_loan', { loan_id: p.loan_id });
        await deposit(loan, p.leg, 'incoming');
      }
    } else if (p.kind === 'payment_refund') {
      const loan = await this.near.view('get_loan', { loan_id: p.loan_id }),
        lock = loan.locks.find((l) => l.leg.leg_id === p.leg_id);
      if (!lock) throw new KansoError('NOT_FOUND', 'Payment input not found');
      if (lock.leg.custody.family === 'near')
        await step(
          'release',
          'Refund wallet repayment input',
          await transfer('release'),
          () =>
            tx('refund_native_wallet_payment', {
              loan_id: p.loan_id,
              leg_id: p.leg_id,
              transfer_id: id('release'),
            }),
        );
      else await release(loan, p.leg_id, lock.locked_atomic, 'release');
    } else if (p.kind === 'loss_recognition') {
      const loan = await this.near.view('get_loan', { loan_id: p.loan_id });
      await step(
        'loss',
        'Recognize exhausted default loss',
        loan.state === 'written_off',
        () =>
          tx('recognize_loss', {
            loan_id: p.loan_id,
            expected_revision: p.expected_revision,
          }),
      );
    } else if (p.kind === 'setup') {
      let loan = await this.near.maybe_view('get_loan', {
        loan_id: p.offer.offer_id,
      });
      if (
        loan &&
        to_hex(loan.offer_hash) !== to_hex(digest(encode_offer(p.offer)))
      )
        throw new KansoError(
          'IDEMPOTENCY_CONFLICT',
          'Accepted offer differs from this operation',
        );
      if (s.cancellation_requested) {
        if (!loan) {
          s.status = previous.steps.some(
            (x) => x.state === 'submitted' || x.state === 'unknown',
          )
            ? 'reconciling'
            : 'cancelled';
          s.steps = previous.steps;
          return s;
        }
        const accepted = previous.steps.find((x) => x.step_id === 'accept');
        if (accepted) steps.push({ ...accepted, state: 'confirmed' });
        if (loan.started_at)
          throw new KansoError(
            'INVALID_INPUT',
            'A funded loan cannot be cancelled',
          );
        if (
          await step(
            'abort',
            'Abort collateral setup',
            loan.state === 'cancelled',
            () => tx('abort_setup', { loan_id: p.offer.offer_id }),
          )
        ) {
          loan = await this.near.view('get_loan', { loan_id: loan.loan_id });
          for (const old of previous.steps.filter(
            (x) =>
              x.step_id.startsWith('lock_') &&
              ['submitted', 'unknown'].includes(x.state),
          )) {
            const lock = loan.locks.find(
              (l) => 'lock_' + l.leg.leg_id === old.step_id,
            );
            if (lock?.receipt_verified)
              steps.push({ ...old, state: 'confirmed' });
            else if (
              lock?.leg.custody.family === 'remote' &&
              old.transaction_id
            )
              await this.remote.accept_lock(loan, lock.leg, old.transaction_id);
            else steps.push(old);
          }
          for (const lock of loan.locks)
            if (
              lock.locked_atomic !== '0' ||
              previous.steps.some(
                (x) =>
                  x.step_id === 'refund_' + lock.leg.leg_id ||
                  x.step_id.startsWith('refund_' + lock.leg.leg_id + '_'),
              )
            )
              await release(
                loan,
                lock.leg.leg_id,
                lock.locked_atomic,
                'refund_' + lock.leg.leg_id,
              );
          for (const old of previous.steps.filter(
            (x) => x.state === 'submitted' || x.state === 'unknown',
          ))
            if (!steps.some((x) => x.step_id === old.step_id)) steps.push(old);
        }
      } else if (
        await step('accept', 'Accept offer and reserve liquidity', !!loan, () =>
          tx('accept_offer', { offer: p.offer }),
        )
      ) {
        loan ??= await this.near.view('get_loan', {
          loan_id: p.offer.offer_id,
        });
        for (const leg of p.offer.legs) {
          can_progress = true;
          await deposit(loan, leg, 'lock_' + leg.leg_id);
        }
        if (loan.locks.every((l) => l.accepted)) {
          if (
            (await step(
              'fund',
              'Fund principal payout',
              loan.started_at > 0,
              () =>
                tx('fund_loan', {
                  loan_id: p.offer.offer_id,
                  transfer_id: id('fund'),
                }),
            )) &&
            p.conditional_repayment
          ) {
            const a = await this.near.view('get_conditional_repayment', {
              loan_id: loan.loan_id,
            });
            await step('conditional', 'Configure optional repayment', !!a, () =>
              tx('set_conditional_repayment', {
                loan_id: p.offer.offer_id,
                expected_version: 0,
                terms: p.conditional_repayment,
              }),
            );
          }
        }
      }
    } else if (p.kind === 'pool_create')
      await step(
        'create',
        'Create lending pool',
        !!(await this.near.maybe_view('get_pool', { pool_id: p.pool_id })),
        () => tx('create_pool', { pool_id: p.pool_id, policy: p.policy }),
      );
    else if (p.kind === 'pool_policy') {
      const pool = await this.near.view('get_pool', { pool_id: p.pool_id });
      await step(
        'policy',
        'Update pool policy',
        pool.policy.version >= p.policy.version,
        () =>
          tx('update_pool_policy', { pool_id: p.pool_id, policy: p.policy }),
      );
    } else if (p.kind === 'pool_deposit')
      await step(
        'deposit',
        'Deposit settlement tokens',
        await payment('pool_deposit', p.pool_id),
        () =>
          token_transaction(this.d, owner, p.amount_atomic, {
            kind: 'pool_deposit',
            pool_id: p.pool_id,
            operation_id: s.operation_id,
          }),
      );
    else if (p.kind === 'repayment') {
      const loan = await this.near.view('get_loan', { loan_id: p.loan_id });
      await step(
        'repay',
        'Repay in settlement tokens',
        loan.state === 'repaid' || (await payment('repayment', p.loan_id)),
        () =>
          token_transaction(this.d, owner, p.amount_atomic, {
            kind: 'repayment',
            loan_id: p.loan_id,
            operation_id: s.operation_id,
          }),
      );
    } else if (p.kind === 'lp_withdrawal')
      await step(
        'request',
        'Reserve LP shares',
        !!(await this.near.view('get_withdrawal', {
          withdrawal_id: s.operation_id,
        })),
        () =>
          tx('request_withdrawal', {
            withdrawal_id: s.operation_id,
            pool_id: p.pool_id,
            shares: p.shares,
          }),
      );
    else if (p.kind === 'withdrawal_claim') {
      const w = await this.near.view('get_withdrawal', {
        withdrawal_id: p.withdrawal_id,
      });
      await step('claim', 'Claim LP withdrawal', w?.state === 'paid', () =>
        tx('claim_withdrawal', {
          withdrawal_id: p.withdrawal_id,
          transfer_id: id('claim'),
        }),
      );
    } else if (p.kind === 'withdrawal_cancel') {
      const w = await this.near.view('get_withdrawal', {
        withdrawal_id: p.withdrawal_id,
      });
      await step(
        'cancel',
        'Cancel withdrawal reservation',
        w?.state === 'cancelled',
        () => tx('cancel_withdrawal', { withdrawal_id: p.withdrawal_id }),
      );
    } else if (p.kind === 'conditional') {
      const a = await this.near.view('get_conditional_repayment', {
        loan_id: p.loan_id,
      });
      await step(
        'conditional',
        'Update cumulative repayment authorization',
        !!a && a.version > p.expected_version,
        () =>
          tx('set_conditional_repayment', {
            loan_id: p.loan_id,
            expected_version: p.expected_version,
            terms: p.terms,
          }),
      );
    } else if (p.kind === 'topup' || p.kind === 'replacement') {
      const leg = p.kind === 'topup' ? p.leg : p.incoming;
      const t = await this.near.view('get_topup', {
        operation_id: id('topup'),
      });
      if (
        await step('topup_commit', 'Commit incoming collateral', !!t, () =>
          tx('commit_topup', {
            operation_id: id('topup'),
            loan_id: p.loan_id,
            leg,
          }),
        )
      ) {
        let ready = true;
        if (p.kind === 'replacement') {
          const r = await this.near.view('get_replacement', {
            operation_id: id('replace'),
          });
          ready = await step(
            'replace_commit',
            'Commit collateral replacement',
            !!r,
            () =>
              tx('commit_replacement', {
                operation_id: id('replace'),
                loan_id: p.loan_id,
                incoming_topup_id: id('topup'),
                outgoing_leg_id: p.outgoing_leg_id,
                outgoing_amount_atomic: p.outgoing_amount_atomic,
              }),
          );
        }
        if (ready) {
          const loan = await this.near.view('get_loan', { loan_id: p.loan_id });
          await deposit(loan, leg, 'incoming');
          if (p.kind === 'replacement' && t?.accepted) {
            const outgoing = loan.locks.find(
              (l) => l.leg.leg_id === p.outgoing_leg_id,
            )!;
            if (outgoing.leg.custody.family === 'near')
              await step(
                'replace_release',
                'Release replaced collateral',
                await transfer('replace_release'),
                () =>
                  tx('finalize_replacement', {
                    operation_id: id('replace'),
                    transfer_id: id('replace_release'),
                    expected_revision: loan.revision,
                  }),
              );
            else {
              const progress = await this.remote.replacement(
                loan,
                outgoing.leg,
                id('replace'),
                id('replace_release'),
                owner,
              );
              for (const item of progress)
                await step(
                  'replace_' + item.name,
                  item.label,
                  item.done,
                  () => item.action,
                );
            }
          }
        }
      }
    } else if (p.kind === 'withdraw' || p.kind === 'release') {
      const loan = await this.near.view('get_loan', { loan_id: p.loan_id });
      const lock = loan.locks.find((l) => l.leg.leg_id === p.leg_id);
      if (!lock) throw new KansoError('NOT_FOUND', 'Collateral leg not found');
      await release(
        loan,
        p.leg_id,
        p.kind === 'withdraw' ? p.amount_atomic : lock.locked_atomic,
        'release',
        p.kind === 'withdraw' ? p.expected_revision : undefined,
      );
    } else if (p.kind === 'refund') {
      const r = await this.near.view('get_refund', { refund_id: p.refund_id });
      await step('refund', 'Claim owed settlement surplus', !!r?.paid, () =>
        tx('claim_refund', {
          refund_id: p.refund_id,
          transfer_id: id('refund'),
        }),
      );
    } else if (p.kind === 'setup_cancel') {
      const loan = await this.near.view('get_loan', { loan_id: p.loan_id });
      await step('abort', 'Abort setup', loan.state === 'cancelled', () =>
        tx('abort_setup', { loan_id: p.loan_id }),
      );
    } else if (p.kind === 'basket_repayment') {
      return reconcile_basket_repayment(
        previous,
        this.near,
        this.solver,
        (child) => this.reconcile(child),
      );
    } else if (p.kind === 'settlement') {
      let settlement = await this.near.view('get_settlement', {
        operation_id: p.plan.operation_id,
      });
      if (!settlement) {
        await this.solver.quote_on_chain(p.plan);
        settlement = await this.near.view('get_settlement', {
          operation_id: p.plan.operation_id,
        });
      }
      if (settlement?.state === 'cancelled') {
        await this.solver.refund_cancelled(p.plan);
        s.status = 'cancelled';
        s.steps = previous.steps.map((x) =>
          x.state === 'pending'
            ? { ...x, state: 'cancelled', action: null }
            : x,
        );
        return s;
      }
      if (settlement?.state === 'quoted') await this.solver.fund(p.plan);
      if (
        await background(
          'escrow',
          'Verify funded solver escrow',
          !!settlement && settlement.state !== 'quoted',
        )
      ) {
        const committed =
          !!settlement &&
          ['committed', 'delivered', 'applied'].includes(settlement.state);
        if (
          await step(
            'commit',
            'Commit bounded source settlement',
            committed,
            () =>
              tx('commit_settlement', {
                operation_id: p.plan.operation_id,
                transfer_id: id('delivery'),
              }),
          )
        ) {
          const loan = await this.near.view('get_loan', {
            loan_id: p.plan.loan_id,
          });
          const leg = loan.locks.find(
            (l) => l.leg.leg_id === p.plan.leg_id,
          )!.leg;
          if (leg.custody.family === 'remote') {
            for (const item of await this.remote.progress(
              loan,
              leg,
              id('delivery'),
              owner,
            ))
              await step(
                'source_' + item.name,
                item.label,
                item.done,
                () => item.action,
              );
          }
          if (
            await background(
              'delivery',
              'Verify source delivery',
              !!settlement &&
                ['delivered', 'applied'].includes(settlement.state),
            )
          )
            if (
              (await step(
                'apply',
                'Apply verified USDC repayment',
                settlement?.state === 'applied',
                () =>
                  tx(
                    'apply_settlement',
                    { operation_id: p.plan.operation_id },
                    '0',
                  ),
              )) &&
              p.plan.kind === 'repayment' &&
              settlement?.refund_id
            ) {
              const refund = await this.near.view('get_refund', {
                refund_id: settlement.refund_id,
              });
              await step('surplus', 'Return excess USDC', !!refund?.paid, () =>
                tx('claim_refund', {
                  refund_id: settlement.refund_id!,
                  transfer_id: id('surplus'),
                }),
              );
            }
        }
      }
    }
    for (const old of previous.steps)
      if (!steps.some((x) => x.step_id === old.step_id))
        steps.push(
          s.cancellation_requested && old.state === 'pending'
            ? { ...old, state: 'cancelled', action: null }
            : old,
        );
    s.steps = steps;
    if (steps.some((x) => x.state === 'failed')) s.status = 'failed';
    else if (
      steps.length &&
      steps.every((x) => x.state === 'confirmed' || x.state === 'cancelled')
    ) {
      if (p.kind === 'setup') {
        const loan = await this.near.view('get_loan', {
          loan_id: p.offer.offer_id,
        });
        s.status = s.cancellation_requested
          ? loan.locks.every(
              (l) => l.locked_atomic === '0' && l.reserved_atomic === '0',
            )
            ? 'cancelled'
            : 'reconciling'
          : loan.started_at
            ? 'succeeded'
            : 'running';
      } else s.status = 'succeeded';
    } else if (steps.some((x) => x.state === 'pending' && x.action))
      s.status = 'requires_action';
    else
      s.status = steps.some(
        (x) => x.state === 'unknown' || x.state === 'submitted',
      )
        ? 'reconciling'
        : 'running';
    return s;
  }
}
