'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  LoaderCircle,
  RefreshCw,
  Search,
  Wallet,
} from 'lucide-react';
import { identifier } from '@kanso/schema';
import type { Loan } from '@kanso/schema';
import { useKanso } from '@/components/layout/providers';
import { LoanDetails } from '@/features/loans/details';
import { LoanLookup } from '@/features/loans/lookup';
import { LoanTable } from '@/features/loans/table';
import { errorMessage } from '@/lib/amounts';
import { isWalletRejection } from '@/lib/wallets';
import ui from '@/features/workspace/workspace.module.css';
import styles from '@/features/loans/loans.module.css';

export function LoanList() {
  const { client, connect, account } = useKanso();
  const [result, setResult] = useState<{
    account: string;
    loans: Loan[];
  } | null>(null);
  const loans = account && result?.account === account ? result.loans : null;
  const [lookup, setLookup] = useState(false);
  const router = useRouter();
  const params = useSearchParams();
  const selectedId = identifier.safeParse(params.get('loan_id'));
  const selected = selectedId.success ? selectedId.data : null;
  function setSelected(id: string | null) {
    router.replace(
      id
        ? `/app/?view=loans&loan_id=${encodeURIComponent(id)}`
        : '/app/?view=loans',
    );
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function loadMine() {
    setBusy(true);
    setError(null);
    try {
      const wallet = await connect('near');
      if (client.session.account_id !== wallet.address)
        await client.session.connect(wallet.address);
      setResult({ account: wallet.address, loans: await client.loans.list() });
    } catch (e) {
      if (!isWalletRejection(e)) setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (selected)
    return (
      <>
        <button
          type="button"
          className={`${ui.textButton} ${styles.back}`}
          onClick={() => setSelected(null)}
        >
          <ArrowLeft size={14} />
          My loans
        </button>
        <LoanDetails key={selected} loanId={selected} />
      </>
    );
  return (
    <>
      <section
        className={`${ui.card} ${styles.panel}`}
        aria-labelledby="my-loans-title"
        aria-busy={busy}
      >
        <div className={styles.heading}>
          <h2 id="my-loans-title">My loans</h2>
          <div className={styles.tools}>
            <button
              type="button"
              className={styles.lookupButton}
              onClick={() => setLookup(true)}
            >
              <Search size={15} />
              Find a loan
            </button>
            {loans !== null && (
              <button
                type="button"
                className={styles.refresh}
                aria-label="Refresh loans"
                disabled={busy}
                onClick={() => void loadMine()}
              >
                <RefreshCw
                  size={15}
                  className={busy ? styles.spinning : undefined}
                />
              </button>
            )}
          </div>
        </div>
        {loans === null ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>
              {busy ? (
                <LoaderCircle size={25} className={styles.spinning} />
              ) : (
                <Wallet size={25} />
              )}
            </span>
            <h3>
              {busy
                ? 'Loading your loans…'
                : account
                  ? 'View your loans'
                  : 'Connect to view your loans'}
            </h3>
            <button
              type="button"
              className={ui.primary}
              disabled={busy}
              onClick={() => void loadMine()}
            >
              {busy ? 'Loading…' : account ? 'View my loans' : 'Connect wallet'}
              {!busy && <ArrowRight size={16} />}
            </button>
          </div>
        ) : loans.length ? (
          <LoanTable loans={loans} />
        ) : (
          <div className={styles.empty}>
            <h3>No loans yet.</h3>
            <Link href="/app/" className={ui.primary}>
              Borrow USDC
              <ArrowRight size={16} />
            </Link>
          </div>
        )}
        {error && (
          <p className={`${ui.error} ${styles.loadError}`} role="alert">
            {error}
          </p>
        )}
      </section>
      {lookup && (
        <LoanLookup
          onClose={() => setLookup(false)}
          onSelect={(id) => {
            setLookup(false);
            setSelected(id);
          }}
        />
      )}
    </>
  );
}
