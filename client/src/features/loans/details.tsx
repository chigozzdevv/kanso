'use client';

import { useEffect, useState } from 'react';
import type { Loan, LoanSummary, OperationPlan } from '@kanso/schema';
import type { Operation } from '@kanso/sdk';
import { useKanso } from '@/components/layout/providers';
import { Dialog } from '@/components/ui/dialog';
import { LockProgress } from '@/features/borrow/lock-progress';
import { AssetIdentity } from '@/features/basket/holding';
import { parseAmount, formatAmount, errorMessage } from '@/lib/amounts';
import ui from '@/features/workspace/workspace.module.css';

export function LoanDetails({ loanId }: { loanId: string }) {
  const { client, connect, account, catalog } = useKanso();
  const [data, setData] = useState<{
    record: Loan;
    summary: LoanSummary;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<{
    plan: OperationPlan;
    plan_hash: string;
    expires_at: number;
  } | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    const loan = client.loan(loanId);
    setData({ record: await loan.record(), summary: await loan.summary() });
  }
  useEffect(() => {
    let cancelled = false;
    const loan = client.loan(loanId);
    void loan
      .record()
      .then((record) => {
        if (!cancelled)
          void loan
            .summary()
            .then((summary) => {
              if (!cancelled) setData({ record, summary });
            })
            .catch((e) => {
              if (!cancelled) setError(errorMessage(e));
            });
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    const unsubscribe = loan.subscribe(
      (summary) =>
        setData((current) => (current ? { ...current, summary } : current)),
      (e) => setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, loanId]);

  async function authenticate() {
    const wallet = await connect('near');
    if (client.session.account_id !== wallet.address)
      await client.session.connect(wallet.address);
  }
  async function prepareRepayment() {
    setBusy(true);
    setError(null);
    try {
      const atomic = parseAmount(amount, 6);
      await authenticate();
      setReview(
        await client
          .loan(loanId)
          .repayment.review({ mode: 'direct', amount_atomic: atomic }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function confirmRepayment() {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      if (review.expires_at * 1000 <= Date.now())
        throw new Error('This review expired. Review your repayment again.');
      setOperation(
        await client
          .loan(loanId)
          .repay({ review, idempotency_key: crypto.randomUUID() }),
      );
      setReview(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function release(legId: string) {
    setBusy(true);
    setError(null);
    try {
      await authenticate();
      setOperation(
        await client.loan(loanId).collateral.release({
          leg_id: legId,
          idempotency_key: crypto.randomUUID(),
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (operation)
    return (
      <LockProgress
        operation={operation}
        onDone={() => {
          setOperation(null);
          void load().catch((e) => setError(errorMessage(e)));
        }}
      />
    );
  if (!data)
    return (
      <section className={ui.card}>
        {error ? (
          <p className={ui.error} role="alert">
            {error}
          </p>
        ) : (
          <p className={ui.skeleton}>Loading loan…</p>
        )}
      </section>
    );
  const { record, summary } = data;
  return (
    <div className={ui.grid}>
      <section className={ui.card}>
        <div className={ui.cardHeading}>
          <h2>Your loan</h2>
          <span className={ui.testnet}>
            {summary.debt_state.replaceAll('_', ' ')}
          </span>
        </div>
        <p
          className={ui.muted}
          style={{ marginTop: 12, overflowWrap: 'anywhere' }}
        >
          {loanId}
        </p>
        <dl className={ui.metrics}>
          <div>
            <dt>Total debt</dt>
            <dd>{formatAmount(summary.debt_atomic)} USDC</dd>
          </div>
          <div>
            <dt>Basket health</dt>
            <dd>
              {summary.health_ppm === null
                ? '—'
                : `${formatAmount(summary.health_ppm, 6, 2)}×`}
            </dd>
          </div>
          <div>
            <dt>Maturity</dt>
            <dd style={{ fontSize: 16 }}>
              {summary.matures_at
                ? new Date(summary.matures_at * 1000).toLocaleDateString()
                : 'Not funded'}
            </dd>
          </div>
        </dl>
        {summary.price_status !== 'valid' && (
          <p className={ui.notice}>
            Prices are {summary.price_status}. Borrowing capacity and health may
            be unavailable.
          </p>
        )}
      </section>
      <section className={ui.card}>
        <h2>Collateral</h2>
        <div className={ui.walletOptions}>
          {record.locks
            .filter((lock) => lock.purpose.kind === 'collateral')
            .map((lock) => {
              const asset = catalog?.assets.find(
                (a) => a.asset_id === lock.leg.asset_id,
              );
              return (
                <div className={ui.notice} key={lock.leg.leg_id}>
                  <div className={ui.cardHeading}>
                    {asset ? (
                      <AssetIdentity asset={asset} />
                    ) : (
                      <strong>{lock.leg.asset_id}</strong>
                    )}
                    <span>
                      {asset
                        ? formatAmount(lock.locked_atomic, asset.decimals, 6)
                        : lock.locked_atomic}
                    </span>
                  </div>
                  {['repaid', 'cancelled'].includes(summary.debt_state) &&
                    lock.locked_atomic !== '0' &&
                    account === record.offer.borrower && (
                      <button
                        type="button"
                        className={ui.textButton}
                        disabled={busy}
                        onClick={() => void release(lock.leg.leg_id)}
                      >
                        Release collateral
                      </button>
                    )}
                </div>
              );
            })}
        </div>
      </section>
      {!['repaid', 'cancelled', 'pending_funding', 'written_off'].includes(
        summary.debt_state,
      ) && (
        <section className={ui.card}>
          <h2>Repay USDC</h2>
          <form
            className={ui.actions}
            onSubmit={(e) => {
              e.preventDefault();
              void prepareRepayment();
            }}
          >
            <input
              className={ui.field}
              style={{ flex: 1, minWidth: 150 }}
              inputMode="decimal"
              aria-label="Repayment amount in USDC"
              placeholder="0.00 USDC"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
            <button type="submit" className={ui.primary} disabled={busy}>
              {busy ? 'Preparing…' : 'Review repayment'}
            </button>
          </form>
        </section>
      )}
      {error && (
        <p className={ui.error} role="alert">
          {error}
        </p>
      )}
      {review && (
        <Dialog
          title="Review repayment"
          onClose={() => !busy && setReview(null)}
        >
          <p className={ui.muted}>
            Repay{' '}
            {review.plan.kind === 'repayment'
              ? formatAmount(review.plan.amount_atomic)
              : ''}{' '}
            USDC on NEAR.
          </p>
          <button
            type="button"
            className={`${ui.primary} ${ui.actions}`}
            disabled={busy}
            onClick={() => void confirmRepayment()}
          >
            {busy ? 'Preparing…' : 'Confirm repayment'}
          </button>
        </Dialog>
      )}
    </div>
  );
}
