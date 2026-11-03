'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ChevronDown } from 'lucide-react';
import { Wordmark } from '@/components/layout/wordmark';
import { WalletButton } from '@/components/layout/wallet-button';
import { Select } from '@/components/ui/select';
import { useKanso } from '@/components/layout/providers';
import { BorrowFlow } from '@/features/borrow/flow';
import { LoanList } from '@/features/loans/list';
import { PoolList } from '@/features/pools/list';
import styles from '@/features/workspace/workspace.module.css';

const views = [
  { id: 'borrow', label: 'Borrow' },
  { id: 'loans', label: 'My loans' },
  { id: 'pools', label: 'Pools' },
];

export function Workspace() {
  const query = useSearchParams();
  const view = views.find((v) => v.id === query.get('view')) ?? views[0]!;
  const { catalogError, refresh, loading } = useKanso();
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.navigation}>
          <Wordmark />
          <div className={styles.navigationLinks}>
            <div className={styles.network}>
              <Select aria-label="Network" defaultValue="testnet">
                <option value="testnet">Testnet</option>
              </Select>
              <ChevronDown size={14} aria-hidden="true" />
            </div>
            <nav className={styles.tabs} aria-label="App navigation">
              {views.map((item) => (
                <Link
                  key={item.id}
                  href={
                    item.id === 'borrow' ? '/app/' : `/app/?view=${item.id}`
                  }
                  aria-current={view.id === item.id ? 'page' : undefined}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <WalletButton />
        </div>
      </header>
      <main id="main" className={styles.main}>
        <h1 className="sr-only">{view.label}</h1>
        {catalogError && (
          <div
            className={`${styles.error} ${styles.catalogError}`}
            role="alert"
          >
            The live catalog is unavailable. {catalogError}{' '}
            <button
              type="button"
              className={styles.textButton}
              disabled={loading}
              onClick={() => void refresh()}
            >
              Try again
            </button>
          </div>
        )}
        {view.id === 'borrow' ? (
          <BorrowFlow />
        ) : view.id === 'loans' ? (
          <LoanList />
        ) : (
          <PoolList />
        )}
      </main>
    </div>
  );
}
