'use client';

import { useState } from 'react';
import { flushSync } from 'react-dom';
import { Check, LogOut, Wallet } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { useKanso } from '@/components/layout/providers';
import { familyNames } from '@/lib/wallets/types';
import { isWalletRejection } from '@/lib/wallets';
import { shortAddress, errorMessage } from '@/lib/amounts';
import styles from '@/features/workspace/workspace.module.css';

export function WalletButton() {
  const { account, connections, connecting, connect, disconnect } = useKanso();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function onConnect() {
    if (error) flushSync(() => setError(null));
    try {
      await connect();
    } catch (e) {
      if (!isWalletRejection(e)) setError(errorMessage(e));
    }
  }
  return (
    <>
      <button
        type="button"
        className={styles.walletButton}
        disabled={connecting}
        onClick={() => (account ? setOpen(true) : void onConnect())}
      >
        <Wallet size={16} />
        {connecting
          ? 'Connecting…'
          : account
            ? shortAddress(account)
            : 'Connect wallet'}
      </button>
      {error && (
        <Dialog title="Wallet connection" onClose={() => setError(null)}>
          <p className={styles.error} role="alert">
            {error}
          </p>
          <button
            type="button"
            className={`${styles.primary} ${styles.actions}`}
            onClick={() => void onConnect()}
          >
            Try again
          </button>
        </Dialog>
      )}
      {open && (
        <Dialog title="Your wallets" onClose={() => setOpen(false)}>
          <div className={styles.walletOptions}>
            {connections.map((connection) => (
              <div key={connection.family} className={styles.notice}>
                <div className={styles.cardHeading}>
                  <strong>{familyNames[connection.family]}</strong>
                  <Check size={16} />
                </div>
                <p style={{ overflowWrap: 'anywhere', marginTop: 8 }}>
                  {connection.address}
                </p>
              </div>
            ))}
          </div>
          <button
            type="button"
            className={`${styles.secondary} ${styles.actions}`}
            onClick={() => {
              setOpen(false);
              void disconnect();
            }}
          >
            <LogOut size={16} />
            Disconnect wallets
          </button>
        </Dialog>
      )}
    </>
  );
}
