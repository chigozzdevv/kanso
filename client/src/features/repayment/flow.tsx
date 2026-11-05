'use client';

import { useState } from 'react';
import { flushSync } from 'react-dom';
import type { Loan, LoanSummary, RepaymentEstimateInput } from '@kanso/schema';
import { useKanso } from '@/components/layout/providers';
import { Dialog } from '@/components/ui/dialog';
import { RepaymentForm, assetLabel } from '@/features/repayment/form';
import type { PaymentMode } from '@/features/repayment/form';
import { PaymentReview } from '@/features/repayment/review';
import { checkedSettlement } from '@/features/repayment/state';
import type { RepaymentReview } from '@/features/repayment/state';
import { useRepaymentOperation } from '@/features/repayment/use-operation';
import { LockProgress } from '@/features/borrow/lock-progress';
import { parseAmount, inputAmount, errorMessage } from '@/lib/amounts';
import ui from '@/features/workspace/workspace.module.css';
import styles from '@/features/repayment/repayment.module.css';

export function RepaymentFlow({
  record,
  summary,
  onChanged,
}: {
  record: Loan;
  summary: LoanSummary;
  onChanged: () => Promise<void>;
}) {
  const { client, catalog, account, connect } = useKanso();
  const loanId = record.offer.offer_id;
  const payment = client.loan(loanId).repayment;
  const progress = useRepaymentOperation(client, loanId);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PaymentMode>('assets');
  const [source, setSource] = useState('usdc');
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<RepaymentReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assets = catalog?.assets ?? [];
  const held = record.locks.filter(
    (lock) =>
      lock.purpose.kind === 'payment' &&
      lock.purpose.payer === account &&
      BigInt(lock.locked_atomic) > 0n,
  );
  const canRepay =
    record.state === 'active' && BigInt(summary.debt_atomic) > 0n;

  async function authenticate(expected?: string) {
    const wallet = await connect('near');
    if (expected && wallet.address !== expected)
      throw new Error('Connect the account that reviewed this payment.');
    if (client.session.account_id !== wallet.address)
      await client.session.connect(wallet.address);
    return wallet.address;
  }
  async function sourceReview(owner: string, input: RepaymentEstimateInput) {
    const estimate = await payment.estimate(input);
    if ('asset_id' in input)
      return { owner, amount: input.amount_atomic, estimate };
    const quoted = await payment.review({
      mode: input.mode,
      leg_id: input.leg_id,
      input_atomic: estimate.input_atomic,
      max_execution_cost_atomic: estimate.execution_cost_atomic,
    });
    return {
      owner,
      amount: input.amount_atomic,
      estimate: checkedSettlement(estimate, quoted),
      review: quoted,
    };
  }
  async function prepareReview() {
    flushSync(() => setOpen(false));
    setBusy(true);
    setError(null);
    try {
      const atomic = parseAmount(amount, 6);
      const fresh = await client.loan(loanId).summary();
      if (BigInt(atomic) > BigInt(fresh.debt_atomic))
        throw new Error('Enter an amount up to the current debt.');
      const owner = await authenticate();
      if (mode === 'assets' && source === 'usdc')
        setReview({
          owner,
          amount: atomic,
          review: await payment.review({
            mode: 'direct',
            amount_atomic: atomic,
          }),
        });
      else if (mode === 'collateral') {
        const basketReview = await payment.review_basket(atomic);
        if (
          basketReview.plan.kind !== 'basket_repayment' ||
          basketReview.plan.loan_id !== loanId ||
          basketReview.plan.quote.amount_atomic !== atomic
        )
          throw new Error('The basket quote does not match this repayment.');
        setReview({
          owner,
          amount: atomic,
          basket: basketReview.plan.quote,
          review: basketReview,
        });
      } else {
        const input: RepaymentEstimateInput = source.startsWith('lock:')
          ? { mode: 'wallet', leg_id: source.slice(5), amount_atomic: atomic }
          : {
              mode: 'wallet',
              asset_id: source.slice(6),
              amount_atomic: atomic,
            };
        setReview(await sourceReview(owner, input));
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setOpen(true);
      setBusy(false);
    }
  }
  async function confirm() {
    if (!review) return;
    const value = review;
    flushSync(() => setOpen(false));
    setBusy(true);
    setError(null);
    try {
      const expiry = value.estimate?.expires_at ?? value.review!.expires_at;
      if (expiry * 1000 <= Date.now()) {
        setReview(null);
        throw new Error('This quote expired. Review your repayment again.');
      }
      const owner = await authenticate(value.owner);
      if (value.review) {
        await progress.prepare('repayment', owner, value.amount, (key) =>
          payment.execute({ review: value.review!, idempotency_key: key }),
        );
      } else {
        const estimate = value.estimate!;
        const asset = assets.find((a) => a.asset_id === estimate.asset_id);
        if (!asset?.enabled)
          throw new Error('This payment asset is currently unavailable.');
        const wallet = await connect(asset.family);
        if (BigInt(await wallet.balance(asset)) < BigInt(estimate.input_atomic))
          throw new Error(
            `Your ${asset.symbol} amount exceeds the available wallet balance.`,
          );
        const paymentId = crypto.randomUUID();
        await progress.prepare('wallet_payment', owner, value.amount, (key) =>
          payment.prepare_wallet_input({
            asset: {
              asset_id: asset.asset_id,
              amount_atomic: estimate.input_atomic,
              source_account: wallet.address,
              refund_account: wallet.address,
            },
            payment_id: paymentId,
            idempotency_key: key,
          }),
        );
      }
      setReview(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function resume() {
    setBusy(true);
    setError(null);
    try {
      await progress.resume(await authenticate(progress.saved?.owner));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function returnPayment(legId: string) {
    setBusy(true);
    setError(null);
    try {
      const owner = await authenticate();
      await progress.prepare('refund', owner, null, (key) =>
        payment.refund_wallet_input({ leg_id: legId, idempotency_key: key }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function completed() {
    if (!progress.operation) return;
    setBusy(true);
    setError(null);
    try {
      const snapshot = await progress.operation.snapshot();
      const saved = progress.saved;
      await onChanged();
      progress.clear();
      setReview(null);
      if (
        snapshot.status === 'succeeded' &&
        snapshot.plan.kind === 'wallet_payment'
      ) {
        const legId = snapshot.plan.leg.leg_id;
        setMode('assets');
        setSource(`lock:${legId}`);
        if (saved?.amount_atomic) {
          setAmount(inputAmount(saved.amount_atomic));
          try {
            setReview(
              await sourceReview(await authenticate(saved.owner), {
                mode: 'wallet',
                leg_id: legId,
                amount_atomic: saved.amount_atomic,
              }),
            );
          } catch (e) {
            setError(errorMessage(e));
          }
        }
        setOpen(true);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (progress.operation)
    return (
      <div>
        <LockProgress
          operation={progress.operation}
          onDone={() => {
            if (!busy) void completed();
          }}
        />
        {error && (
          <p className={ui.error} role="alert">
            {error}
          </p>
        )}
      </div>
    );
  if (!canRepay && !held.length && !progress.saved) return null;
  return (
    <section className={ui.card}>
      <div className={ui.cardHeading}>
        <h2>Repayment</h2>
        {canRepay && !progress.saved && (
          <button
            type="button"
            className={ui.primary}
            disabled={busy}
            onClick={() => {
              setReview(null);
              setError(null);
              setOpen(true);
            }}
          >
            {busy ? 'Preparing…' : 'Repay'}
          </button>
        )}
      </div>
      {progress.saved && (
        <div className={ui.actions}>
          <p className={ui.muted}>You have a payment to resume.</p>
          <button
            type="button"
            className={ui.secondary}
            disabled={busy}
            onClick={() => void resume()}
          >
            {busy ? 'Loading…' : 'Resume payment'}
          </button>
        </div>
      )}
      {held.length > 0 && (
        <div className={styles.paymentList}>
          {held.map((lock) => {
            const asset = assets.find((a) => a.asset_id === lock.leg.asset_id);
            const available =
              BigInt(lock.locked_atomic) - BigInt(lock.reserved_atomic);
            return (
              <div className={styles.payment} key={lock.leg.leg_id}>
                <div>
                  <strong>
                    {asset ? assetLabel(asset) : lock.leg.asset_id}
                  </strong>
                  <p className={ui.muted}>
                    {asset
                      ? `${inputAmount(available.toString(), asset.decimals)} ${asset.symbol}`
                      : `${available} atomic units`}{' '}
                    deposited
                    {!lock.accepted
                      ? ' · Awaiting verification'
                      : available === 0n
                        ? ' · In use'
                        : ''}
                  </p>
                </div>
                {lock.accepted && available > 0n && (
                  <div className={styles.buttons}>
                    {canRepay && (
                      <button
                        type="button"
                        className={ui.textButton}
                        disabled={busy || !!progress.saved}
                        onClick={() => {
                          setMode('assets');
                          setSource(`lock:${lock.leg.leg_id}`);
                          setReview(null);
                          setError(null);
                          setOpen(true);
                        }}
                      >
                        Use for repayment
                      </button>
                    )}
                    <button
                      type="button"
                      className={ui.textButton}
                      disabled={busy || !!progress.saved}
                      onClick={() => void returnPayment(lock.leg.leg_id)}
                    >
                      Return asset
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {error && !open && (
        <p className={ui.error} role="alert">
          {error}
        </p>
      )}
      {open && (
        <Dialog
          title={review ? 'Review repayment' : 'Repay your loan'}
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          {review ? (
            <PaymentReview
              amount={review.amount}
              estimate={review.estimate}
              basket={review.basket}
              expiresAt={
                review.estimate?.expires_at ?? review.review!.expires_at
              }
              fundingRequired={!review.review}
              assets={assets}
              busy={busy}
              onBack={() => {
                setReview(null);
                setError(null);
              }}
              onConfirm={() => void confirm()}
            />
          ) : (
            <RepaymentForm
              mode={mode}
              source={source}
              amount={amount}
              debt={summary.debt_atomic}
              assets={assets}
              sources={record.locks
                .filter(
                  (lock) =>
                    lock.accepted &&
                    BigInt(lock.locked_atomic) > BigInt(lock.reserved_atomic) &&
                    (lock.purpose.kind === 'collateral' ||
                      lock.purpose.payer === account),
                )
                .map((lock) => ({
                  legId: lock.leg.leg_id,
                  assetId: lock.leg.asset_id,
                  purpose: lock.purpose.kind,
                }))}
              borrower={account === record.offer.borrower}
              canDeposit={record.locks.length < 16}
              busy={busy}
              onMode={(value) => {
                setMode(value);
                setSource('usdc');
                setError(null);
              }}
              onSource={setSource}
              onAmount={setAmount}
              onReview={() => void prepareReview()}
            />
          )}
          {error && (
            <p className={ui.error} role="alert">
              {error}
            </p>
          )}
        </Dialog>
      )}
    </section>
  );
}
