'use client';

import { useEffect, useState } from 'react';
import { Coins, Trash2 } from 'lucide-react';
import type { Asset } from '@kanso/schema';
import { TokenIcon, isTokenSymbol } from '@/components/ui/token-icon';
import { useKanso } from '@/components/layout/providers';
import { networks } from '@/lib/networks';
import { formatAmount, errorMessage, shortAddress } from '@/lib/amounts';
import ui from '@/features/workspace/workspace.module.css';
import styles from '@/features/basket/basket.module.css';

export type BasketEntry = { asset: Asset; amount: string };

export function AssetIdentity({ asset }: { asset: Asset }) {
  const network = networks.find((n) => n.id === asset.chain_id);
  return (
    <span className={styles.identity}>
      {isTokenSymbol(asset.symbol) ? (
        <TokenIcon symbol={asset.symbol} size={36} />
      ) : (
        <Coins size={36} aria-hidden="true" />
      )}
      <span>
        <strong>{asset.symbol}</strong>
        <small>
          {network?.name ?? asset.chain_id} ·{' '}
          {network?.testnet ?? asset.network_fingerprint}
        </small>
      </span>
    </span>
  );
}

export function Holding({
  entry,
  onChange,
  onRemove,
}: {
  entry: BasketEntry;
  onChange: (amount: string) => void;
  onRemove: () => void;
}) {
  const { connections, connect } = useKanso();
  const wallet = connections.find((w) => w.family === entry.asset.family);
  const [balance, setBalance] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [balanceAttempt, setBalanceAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    setBalance(null);
    setBalanceError(null);
    if (!wallet) return;
    async function refreshBalance() {
      if (pending || !wallet) return;
      pending = true;
      try {
        const value = await wallet.balance(entry.asset);
        if (!cancelled) {
          setBalance(value);
          setBalanceError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setBalance(null);
          setBalanceError(errorMessage(error));
        }
      } finally {
        pending = false;
      }
    }
    const refresh = () => void refreshBalance();
    refresh();
    const interval = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [wallet, entry.asset, balanceAttempt]);
  async function connectSource() {
    setError(null);
    try {
      await connect(entry.asset.family);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <li className={styles.holding}>
      <AssetIdentity asset={entry.asset} />
      <div className={styles.amountRow}>
        <input
          aria-label={`${entry.asset.symbol} collateral amount on ${entry.asset.chain_id}`}
          value={entry.amount}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          onChange={(e) => onChange(e.target.value)}
        />
        <span>{entry.asset.symbol}</span>
      </div>
      <button
        type="button"
        className={styles.remove}
        onClick={onRemove}
        aria-label={`Remove ${entry.asset.symbol} on ${entry.asset.chain_id}`}
      >
        <Trash2 size={16} />
      </button>
      <div className={styles.holdingBottom}>
        {wallet ? (
          <span title={wallet.address}>{shortAddress(wallet.address)}</span>
        ) : (
          <button
            type="button"
            className={ui.textButton}
            aria-label={`Connect ${entry.asset.chain_id} wallet`}
            onClick={() => void connectSource()}
          >
            Connect wallet
          </button>
        )}
        {wallet && balanceError ? (
          <button
            type="button"
            className={ui.textButton}
            title={balanceError}
            aria-label={`Retry ${entry.asset.symbol} balance on ${entry.asset.chain_id}`}
            onClick={() => setBalanceAttempt((attempt) => attempt + 1)}
          >
            Balance unavailable · Retry
          </button>
        ) : (
          <span>
            {wallet
              ? balance === null
                ? 'Checking balance…'
                : `Available ${formatAmount(balance, entry.asset.decimals, Math.min(entry.asset.decimals, 6))}`
              : 'Connect to see balance'}
          </span>
        )}
      </div>
      {error && (
        <p className={`${ui.error} ${styles.holdingError}`} role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
