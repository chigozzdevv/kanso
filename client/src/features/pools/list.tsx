'use client';

import { useState } from 'react';
import { flushSync } from 'react-dom';
import type { Operation } from '@kanso/sdk';
import { useKanso } from '@/components/layout/providers';
import type { PoolSummary } from '@/components/layout/providers';
import { Dialog } from '@/components/ui/dialog';
import { TokenIcon } from '@/components/ui/token-icon';
import { LockProgress } from '@/features/borrow/lock-progress';
import { parseAmount, formatAmount, errorMessage } from '@/lib/amounts';
import ui from '@/features/workspace/workspace.module.css';
import styles from '@/features/pools/pools.module.css';

export function PoolList() {
  const { catalog, client, connect, loading, refresh } = useKanso();
  const [selected, setSelected] = useState<PoolSummary | null>(null);
  const [amount, setAmount] = useState('');
  const [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function deposit() {
    if (!selected) return;
    const pool = selected;
    flushSync(() => setSelected(null));
    setBusy(true);
    setError(null);
    try {
      const atomic = parseAmount(amount, 6);
      const wallet = await connect('near');
      if (client.session.account_id !== wallet.address)
        await client.session.connect(wallet.address);
      setOperation(
        await client.pool(pool.pool.pool_id).deposit({
          amount_atomic: atomic,
          idempotency_key: crypto.randomUUID(),
        }),
      );
      setSelected(null);
    } catch (e) {
      setSelected(pool);
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
          void refresh();
        }}
      />
    );
  return (
    <div className={ui.grid}>
      {loading && (
        <section className={ui.card}>
          <p className={ui.skeleton}>Loading pool liquidity…</p>
        </section>
      )}
      {catalog?.pools.map((summary) => (
        <section
          className={`${ui.card} ${styles.pool}`}
          key={summary.pool.pool_id}
          aria-labelledby={`pool-${summary.pool.pool_id}`}
        >
          <div className={styles.identity}>
            <TokenIcon symbol="USDC" size={36} />
            <div>
              <h2 id={`pool-${summary.pool.pool_id}`}>
                {summary.pool.pool_id === 'usdc'
                  ? 'USDC pool'
                  : summary.pool.pool_id}
              </h2>
              <p className={ui.muted}>USDC on NEAR</p>
            </div>
          </div>
          <dl className={styles.metrics}>
            <div>
              <dt>Pool value</dt>
              <dd>
                {formatAmount(summary.nav_atomic)}
                <span className={styles.unit}>USDC</span>
              </dd>
            </div>
            <div>
              <dt>Available liquidity</dt>
              <dd>
                {formatAmount(summary.available_cash_atomic)}
                <span className={styles.unit}>USDC</span>
              </dd>
            </div>
            <div>
              <dt>Borrow APR</dt>
              <dd>{summary.pool.policy.apr_bps / 100}%</dd>
            </div>
          </dl>
          <button
            type="button"
            className={`${ui.primary} ${styles.supply}`}
            onClick={() => {
              setSelected(summary);
              setError(null);
              setAmount('');
            }}
          >
            Supply liquidity
          </button>
        </section>
      ))}
      {catalog && !catalog.pools.length && (
        <section className={ui.card}>
          <p className={ui.notice}>No lending pools are currently available.</p>
        </section>
      )}
      {selected && (
        <Dialog title="Supply USDC" onClose={() => !busy && setSelected(null)}>
          <p className={ui.muted}>
            Supply USDC and receive pool shares on NEAR.
          </p>
          <label
            htmlFor="supply-amount"
            className={`${ui.label} ${ui.fieldGroup}`}
          >
            Amount in USDC
          </label>
          <input
            id="supply-amount"
            className={ui.field}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
          <button
            type="button"
            className={`${ui.primary} ${ui.actions} ${ui.full}`}
            disabled={busy || !amount}
            onClick={() => void deposit()}
          >
            {busy ? 'Preparing…' : 'Review in wallet'}
          </button>
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
