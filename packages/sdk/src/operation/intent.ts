import { Transaction } from '@solana/web3.js';
import { KansoError } from '@kanso/schema';
import type {
  OperationSnapshot,
  OperationStep,
  BasketLeg,
  TransactionAction,
} from '@kanso/schema';
import type { CoordinatorClient } from '@sdk/adapters/near/near.adapter';
import { assert_near_transaction } from '@sdk/adapters/near/near.transaction';
import { deposit_action } from '@sdk/adapters/deposit';
import { canonical_json, scoped_id, unbase64 } from '@sdk/transport/codec';

const same = (a: unknown, b: unknown) =>
  canonical_json(a) === canonical_json(b);
function invalid(): never {
  throw new KansoError(
    'INVALID_INPUT',
    'Wallet action differs from the reviewed operation',
  );
}
export async function assert_action_intent(
  s: OperationSnapshot,
  step: OperationStep,
  near: CoordinatorClient,
): Promise<void> {
  const a = step.action;
  if (!a) invalid();
  const p = s.plan,
    d = near.deployment,
    id = (name: string) => scoped_id(s.operation_id, name);
  const loan_id =
    p.kind === 'setup'
      ? p.offer.offer_id
      : p.kind === 'settlement'
        ? p.plan.loan_id
        : 'loan_id' in p
          ? p.loan_id
          : undefined;
  const planned_legs: BasketLeg[] =
    p.kind === 'setup'
      ? p.offer.legs
      : p.kind === 'topup' || p.kind === 'wallet_payment'
        ? [p.leg]
        : p.kind === 'replacement'
          ? [p.incoming]
          : [];
  if (a.family !== 'near') {
    if (!loan_id) invalid();
    const loan = await near.view('get_loan', { loan_id });
    const leg = planned_legs.find(
      (l) =>
        l.custody.family === 'remote' &&
        l.custody.chain_id === a.chain_id &&
        step.step_id === (p.kind === 'setup' ? 'lock_' + l.leg_id : 'incoming'),
    );
    if (!leg) invalid();
    const lock = loan.locks.find((l) => l.leg.leg_id === leg.leg_id);
    if (!lock || !same(lock.leg, leg)) invalid();
    const expected = await deposit_action(
      d,
      loan_id,
      leg,
      lock.agreement,
      lock.purpose.kind === 'payment' ? 1 : 0,
    );
    if (a.family === 'solana' && expected.family === 'solana') {
      const actual = Transaction.from(unbase64(a.transaction)),
        want = Transaction.from(unbase64(expected.transaction));
      if (!want.recentBlockhash) invalid();
      actual.recentBlockhash = want.recentBlockhash;
      if (
        actual.signatures.some((x) => x.signature !== null) ||
        !same(
          Array.from(actual.serializeMessage()),
          Array.from(want.serializeMessage()),
        )
      )
        invalid();
    } else if (!same(a, expected)) invalid();
    return;
  }
  assert_near_transaction(d, a);
  if (a.signer_id !== s.owner || a.calls.length !== 1) invalid();
  const c = a.calls[0]!;
  if (BigInt(c.gas) > 300000000000000n) invalid();
  let args: Record<string, unknown> | undefined,
    deposit = '1';
  if (a.receiver_id === d.near.settlement_token) {
    const intent =
      p.kind === 'pool_deposit'
        ? {
            kind: 'pool_deposit',
            pool_id: p.pool_id,
            operation_id: s.operation_id,
          }
        : p.kind === 'repayment'
          ? {
              kind: 'repayment',
              loan_id: p.loan_id,
              operation_id: s.operation_id,
            }
          : undefined;
    if (
      !intent ||
      c.method !== 'ft_transfer_call' ||
      !same(c.args, {
        receiver_id: d.near.coordinator,
        amount: 'amount_atomic' in p ? p.amount_atomic : '',
        msg: JSON.stringify(intent),
      }) ||
      c.deposit !== '1'
    )
      invalid();
    return;
  }
  switch (c.method) {
    case 'accept_offer':
      if (p.kind === 'setup') args = { offer: p.offer };
      break;
    case 'create_pool':
    case 'update_pool_policy':
      if (
        p.kind ===
          (c.method === 'create_pool' ? 'pool_create' : 'pool_policy') &&
        'policy' in p
      )
        args = { pool_id: p.pool_id, policy: p.policy };
      break;
    case 'request_withdrawal':
      if (p.kind === 'lp_withdrawal')
        args = {
          withdrawal_id: s.operation_id,
          pool_id: p.pool_id,
          shares: p.shares,
        };
      break;
    case 'claim_withdrawal':
    case 'cancel_withdrawal':
      if (
        p.kind ===
          (c.method === 'claim_withdrawal'
            ? 'withdrawal_claim'
            : 'withdrawal_cancel') &&
        'withdrawal_id' in p
      )
        args = {
          withdrawal_id: p.withdrawal_id,
          ...(c.method === 'claim_withdrawal'
            ? { transfer_id: id('claim') }
            : {}),
        };
      break;
    case 'claim_refund':
      if (p.kind === 'refund')
        args = { refund_id: p.refund_id, transfer_id: id('refund') };
      break;
    case 'storage_deposit':
      if (p.kind === 'storage_deposit') {
        args = {};
        deposit = p.amount_atomic;
      }
      break;
    case 'withdraw_storage':
      if (p.kind === 'storage_withdraw')
        args = { amount_atomic: p.amount_atomic, transfer_id: id('storage') };
      break;
    case 'recognize_loss':
      if (p.kind === 'loss_recognition')
        args = { loan_id: p.loan_id, expected_revision: p.expected_revision };
      break;
    case 'abort_setup':
      if (
        p.kind === 'setup_cancel' ||
        (p.kind === 'setup' && s.cancellation_requested)
      )
        args = { loan_id };
      break;
    case 'set_conditional_repayment':
      if (p.kind === 'conditional')
        args = {
          loan_id,
          expected_version: p.expected_version,
          terms: p.terms,
        };
      else if (p.kind === 'setup' && p.conditional_repayment)
        args = { loan_id, expected_version: 0, terms: p.conditional_repayment };
      break;
    case 'commit_topup':
      if (p.kind === 'topup' || p.kind === 'replacement')
        args = {
          operation_id: id('topup'),
          loan_id,
          leg: p.kind === 'topup' ? p.leg : p.incoming,
        };
      break;
    case 'lock_native_topup':
      if (p.kind === 'topup' || p.kind === 'replacement') {
        args = { operation_id: id('topup') };
        deposit = (p.kind === 'topup' ? p.leg : p.incoming).amount_atomic;
      }
      break;
    case 'create_wallet_payment':
      if (p.kind === 'wallet_payment')
        args = { loan_id, payment_id: p.payment_id, leg: p.leg };
      break;
    case 'commit_replacement':
      if (p.kind === 'replacement')
        args = {
          operation_id: id('replace'),
          loan_id,
          incoming_topup_id: id('topup'),
          outgoing_leg_id: p.outgoing_leg_id,
          outgoing_amount_atomic: p.outgoing_amount_atomic,
        };
      break;
    case 'finalize_replacement':
      if (p.kind === 'replacement') {
        const loan = await near.view('get_loan', { loan_id });
        args = {
          operation_id: id('replace'),
          transfer_id: id('replace_release'),
          expected_revision: loan.revision,
        };
      }
      break;
    case 'lock_native':
    case 'derive_bitcoin_deposit_key': {
      const leg = planned_legs.find((l) => l.leg_id === c.args.leg_id);
      if (!leg) break;
      if (c.method === 'lock_native' && leg.custody.family === 'near') {
        args = { loan_id, leg_id: leg.leg_id };
        deposit = leg.amount_atomic;
      }
      if (
        c.method === 'derive_bitcoin_deposit_key' &&
        leg.custody.family === 'remote' &&
        leg.custody.chain_id === 'bitcoin'
      )
        args = { loan_id, leg_id: leg.leg_id };
      break;
    }
    case 'fund_loan':
      if (p.kind === 'setup' && !s.cancellation_requested)
        args = { loan_id, transfer_id: id('fund') };
      break;
    case 'release_collateral':
    case 'withdraw_excess':
    case 'refund_native_wallet_payment': {
      if (!loan_id) break;
      const loan = await near.view('get_loan', { loan_id });
      const leg_id =
        p.kind === 'setup' && s.cancellation_requested
          ? String(c.args.leg_id)
          : 'leg_id' in p
            ? p.leg_id
            : undefined;
      if (!leg_id || !loan.locks.some((l) => l.leg.leg_id === leg_id)) break;
      const name = p.kind === 'setup' ? 'refund_' + leg_id : 'release';
      if (c.method === 'withdraw_excess' && p.kind === 'withdraw')
        args = {
          loan_id,
          leg_id,
          amount_atomic: p.amount_atomic,
          transfer_id: id(name),
          expected_revision: p.expected_revision,
        };
      if (
        c.method === 'release_collateral' &&
        (p.kind === 'release' ||
          (p.kind === 'setup' && s.cancellation_requested))
      )
        args = { loan_id, leg_id, transfer_id: id(name) };
      if (
        c.method === 'refund_native_wallet_payment' &&
        p.kind === 'payment_refund'
      )
        args = { loan_id, leg_id, transfer_id: id(name) };
      break;
    }
    case 'prepare_remote_release':
    case 'prepare_bitcoin_release': {
      if (!loan_id) break;
      const loan = await near.view('get_loan', { loan_id });
      const leg_id =
        p.kind === 'setup' && s.cancellation_requested
          ? String(c.args.leg_id)
          : 'leg_id' in p
            ? p.leg_id
            : undefined;
      const lock = loan.locks.find((l) => l.leg.leg_id === leg_id);
      if (
        !lock ||
        lock.leg.custody.family !== 'remote' ||
        !['withdraw', 'release', 'payment_refund', 'setup'].includes(p.kind)
      )
        break;
      const manifest = await near.view('get_chain_manifest', {
        chain_id: lock.leg.custody.chain_id,
        version: lock.leg.custody.manifest_version,
      });
      const operation_id = id(
          p.kind === 'setup' ? 'refund_' + leg_id : 'release',
        ),
        amount = p.kind === 'withdraw' ? p.amount_atomic : lock.locked_atomic;
      const expected_revision =
        p.kind === 'withdraw' ? p.expected_revision : loan.revision;
      if (c.method === 'prepare_bitcoin_release')
        args = {
          operation_id,
          loan_id,
          leg_id,
          amount_atomic:
            amount === lock.locked_atomic
              ? (
                  BigInt(amount) - BigInt(manifest.max_network_cost_atomic)
                ).toString()
              : amount,
          max_fee_atomic: manifest.max_network_cost_atomic,
          expected_revision,
        };
      else {
        const deadline = c.args.deadline;
        if (
          typeof deadline !== 'number' ||
          deadline < (await near.now()) ||
          deadline > (await near.now()) + 3600
        )
          invalid();
        args = {
          operation_id,
          loan_id,
          leg_id,
          amount_atomic: amount,
          expected_revision,
          deadline,
        };
      }
      break;
    }
    case 'prepare_remote_replacement':
    case 'prepare_bitcoin_replacement': {
      if (p.kind !== 'replacement') break;
      const loan = await near.view('get_loan', { loan_id });
      const lock = loan.locks.find((l) => l.leg.leg_id === p.outgoing_leg_id);
      if (!lock || lock.leg.custody.family !== 'remote') break;
      if (c.method === 'prepare_bitcoin_replacement') {
        const m = await near.view('get_chain_manifest', {
          chain_id: lock.leg.custody.chain_id,
          version: lock.leg.custody.manifest_version,
        });
        args = {
          operation_id: id('replace'),
          expected_revision: loan.revision,
          spend_id: id('replace_release'),
          max_fee_atomic: m.max_network_cost_atomic,
        };
      } else {
        const deadline = c.args.deadline;
        if (
          typeof deadline !== 'number' ||
          deadline < (await near.now()) ||
          deadline > (await near.now()) + 3600
        )
          invalid();
        args = {
          operation_id: id('replace'),
          expected_revision: loan.revision,
          remote_operation_id: id('replace_release'),
          deadline,
        };
      }
      break;
    }
    case 'request_remote_signature':
    case 'request_bitcoin_signature': {
      const operation_id =
        p.kind === 'settlement'
          ? id('delivery')
          : p.kind === 'replacement'
            ? id('replace_release')
            : p.kind === 'setup' && s.cancellation_requested
              ? id(
                  'refund_' +
                    String(step.step_id).replace(
                      /^refund_(.+)_(?:authorize|signature)$/,
                      '$1',
                    ),
                )
              : ['release', 'withdraw', 'payment_refund'].includes(p.kind)
                ? id('release')
                : undefined;
      if (
        !operation_id ||
        c.args.operation_id !== operation_id ||
        c.args.attempt_id !== 'initial'
      )
        break;
      const loan = await near.view('get_loan', { loan_id });
      const leg_id =
        p.kind === 'settlement'
          ? p.plan.leg_id
          : p.kind === 'replacement'
            ? p.outgoing_leg_id
            : p.kind === 'setup'
              ? String(step.step_id).replace(
                  /^refund_(.+)_(?:authorize|signature)$/,
                  '$1',
                )
              : 'leg_id' in p
                ? p.leg_id
                : undefined;
      const lock = loan.locks.find((l) => l.leg.leg_id === leg_id);
      if (!lock || lock.leg.custody.family !== 'remote') invalid();
      const amount =
        p.kind === 'settlement'
          ? p.plan.input_atomic
          : p.kind === 'replacement'
            ? p.outgoing_amount_atomic
            : p.kind === 'withdraw'
              ? p.amount_atomic
              : lock.locked_atomic;
      const recipient =
        p.kind === 'settlement'
          ? p.plan.remote_recipient
          : lock.leg.custody.release_recipient;
      const settlement_id =
        p.kind === 'settlement' ? p.plan.operation_id : null;
      if (c.method === 'request_bitcoin_signature') {
        const op = await near.view('get_bitcoin_spend', { operation_id });
        if (!op) break;
        const expected =
          p.kind === 'settlement'
            ? BigInt(amount) - BigInt(p.plan.max_source_fee_atomic)
            : p.kind === 'withdraw'
              ? BigInt(amount)
              : BigInt(amount) - BigInt(op.max_fee_atomic);
        if (
          op.owner !== s.owner ||
          op.loan_id !== loan_id ||
          op.leg_id !== leg_id ||
          op.settlement_id !== settlement_id ||
          BigInt(op.amount_atomic) !== expected ||
          !same(op.recipient_script, recipient) ||
          op.manifest.chain_id !== lock.leg.custody.chain_id ||
          op.manifest.version !== lock.leg.custody.manifest_version
        )
          invalid();
        args = {
          operation_id,
          attempt_id: 'initial',
          fee_atomic: op.max_fee_atomic,
          cancellation: false,
        };
      } else {
        const op = await near.view('get_remote_operation', { operation_id });
        if (
          !op ||
          op.owner !== s.owner ||
          op.loan_id !== loan_id ||
          op.leg_id !== leg_id ||
          op.settlement_id !== settlement_id ||
          op.command.amount_atomic !== amount ||
          op.command.kind !== (p.kind === 'settlement' ? 1 : 0) ||
          !same(op.command.recipient, recipient) ||
          op.manifest.chain_id !== lock.leg.custody.chain_id ||
          op.manifest.version !== lock.leg.custody.manifest_version
        )
          invalid();
        args = {
          operation_id,
          attempt_id: 'initial',
          context: c.args.context,
          invalidation: false,
        };
      }
      deposit = c.deposit;
      break;
    }
    case 'commit_settlement':
      if (p.kind === 'settlement')
        args = {
          operation_id: p.plan.operation_id,
          transfer_id: id('delivery'),
        };
      break;
    case 'apply_settlement':
      if (p.kind === 'settlement') {
        args = { operation_id: p.plan.operation_id };
        deposit = '0';
      }
      break;
  }
  if (!args || !same(c.args, args) || c.deposit !== deposit) invalid();
}
export function same_action(
  a: TransactionAction | null,
  b: TransactionAction | null,
) {
  return same(a, b);
}
