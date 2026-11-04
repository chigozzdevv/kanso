'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, RotateCcw } from 'lucide-react';
import type { RepaymentEstimate } from '@kanso/schema';
import { Wordmark } from '@/components/layout/wordmark';
import { Dialog } from '@/components/ui/dialog';
import { RepaymentForm } from '@/features/repayment/form';
import type { PaymentMode } from '@/features/repayment/form';
import { PaymentReview } from '@/features/repayment/review';
import { AssetIdentity } from '@/features/basket/holding';
import {
  previewAssets,
  previewSources,
  previewBalances,
  previewEstimate,
} from '@/features/repayment/preview-data';
import { parseAmount, formatAmount, errorMessage } from '@/lib/amounts';
import ui from '@/features/workspace/workspace.module.css';
import styles from '@/features/repayment/preview.module.css';

type Review = {
  amount: string;
  estimate?: RepaymentEstimate;
  expiresAt: number;
};

export function RepaymentPreview() {
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<PaymentMode>('wallet');
  const [source, setSource] = useState('asset:solana');
  const [amount, setAmount] = useState('100');
  const [review, setReview] = useState<Review | null>(null);
  const [stage, setStage] = useState<
    'review' | 'deposit' | 'final' | 'complete'
  >('review');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStage('review');
    setReview(null);
    setError(null);
    setOpen(true);
  }
  function prepare() {
    setError(null);
    try {
      const atomic = parseAmount(amount, 6);
      if (BigInt(atomic) > 1000000000n)
        throw new Error('Enter an amount up to the current debt.');
      const asset = previewAssets.find(
        (asset) =>
          source === `asset:${asset.asset_id}` ||
          source === `lock:preview_${asset.asset_id}`,
      );
      if (mode !== 'direct' && !asset) throw new Error('Choose an asset.');
      setReview({
        amount: atomic,
        ...(mode !== 'direct'
          ? { estimate: previewEstimate(asset!, atomic, mode) }
          : {}),
        expiresAt: Math.floor(Date.now() / 1000) + 120,
      });
      setStage('review');
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className={ui.shell}>
      <header className={ui.header}>
        <div className={ui.navigation}>
          <Wordmark />
          <span className={styles.label}>UI preview · Sample data</span>
          <Link className={ui.secondary} href="/app/?view=loans">
            Back to app
          </Link>
        </div>
      </header>
      <main id="main" className={`${ui.main} ${ui.grid}`}>
        <section className={ui.card}>
          <div className={ui.cardHeading}>
            <h1 className={styles.title}>Your loan</h1>
            <span className={ui.testnet}>active</span>
          </div>
          <dl className={ui.metrics}>
            <div>
              <dt>Total debt</dt>
              <dd>1,000.00 USDC</dd>
            </div>
            <div>
              <dt>Basket health</dt>
              <dd>1.80×</dd>
            </div>
            <div>
              <dt>Maturity</dt>
              <dd>30 days</dd>
            </div>
          </dl>
        </section>
        <section className={ui.card}>
          <h2>Collateral</h2>
          <div className={styles.collateral}>
            {previewAssets.map((asset, index) => (
              <div className={styles.holding} key={asset.asset_id}>
                <AssetIdentity asset={asset} />
                <span>
                  {previewBalances[index]} {asset.symbol}
                </span>
              </div>
            ))}
          </div>
        </section>
        <section className={ui.card}>
          <div className={ui.cardHeading}>
            <h2>Repayment</h2>
            <button type="button" className={ui.primary} onClick={reset}>
              Repay
            </button>
          </div>
        </section>
      </main>
      {open && (
        <Dialog
          title={
            stage === 'complete'
              ? 'Repayment complete'
              : stage === 'deposit'
                ? 'Payment confirmed'
                : review
                  ? 'Review repayment'
                  : 'Repay your loan'
          }
          onClose={() => setOpen(false)}
        >
          <p className={ui.muted}>Preview only · No transactions are sent.</p>
          {stage === 'complete' || stage === 'deposit' ? (
            <div className={styles.result}>
              <CheckCircle2 size={42} aria-hidden="true" />
              <p>
                {stage === 'deposit'
                  ? 'Your payment asset has been deposited.'
                  : `${formatAmount(review!.amount)} USDC repaid.`}
              </p>
              <button
                type="button"
                className={ui.primary}
                onClick={() =>
                  stage === 'deposit' ? setStage('final') : reset()
                }
              >
                {stage === 'deposit' ? (
                  'Review final quote'
                ) : (
                  <>
                    <RotateCcw size={16} /> Try another method
                  </>
                )}
              </button>
            </div>
          ) : review ? (
            <PaymentReview
              amount={review.amount}
              estimate={review.estimate}
              expiresAt={review.expiresAt}
              fundingRequired={mode === 'wallet' && stage !== 'final'}
              assets={previewAssets}
              busy={false}
              onBack={() => {
                setReview(null);
                setStage('review');
              }}
              onConfirm={() =>
                setStage(
                  mode === 'wallet' && stage !== 'final'
                    ? 'deposit'
                    : 'complete',
                )
              }
            />
          ) : (
            <RepaymentForm
              mode={mode}
              source={source}
              amount={amount}
              debt="1000000000"
              assets={previewAssets}
              sources={previewSources}
              borrower
              canDeposit
              busy={false}
              onMode={(value) => {
                setMode(value);
                setSource(
                  value === 'collateral'
                    ? 'lock:preview_solana'
                    : 'asset:solana',
                );
                setError(null);
              }}
              onSource={setSource}
              onAmount={setAmount}
              onReview={prepare}
            />
          )}
          {error && (
            <p className={ui.error} role="alert">
              {error}
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}
