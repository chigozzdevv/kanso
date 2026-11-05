import type { Asset } from '@kanso/schema';
import { ChevronDown, CircleAlert } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { TokenIcon, isTokenSymbol } from '@/components/ui/token-icon';
import { inputAmount } from '@/lib/amounts';
import { networks } from '@/lib/networks';
import ui from '@/features/workspace/workspace.module.css';
import styles from '@/features/repayment/repayment.module.css';

export type PaymentMode = 'assets' | 'collateral';
export type RepaymentSource = {
  legId: string;
  assetId: string;
  purpose: 'collateral' | 'payment';
};
export function assetLabel(asset: Asset) {
  return `${asset.symbol} · ${networks.find((n) => n.id === asset.chain_id)?.name ?? asset.chain_id}`;
}
export function RepaymentForm({
  mode,
  source,
  amount,
  debt,
  assets,
  sources,
  borrower,
  canDeposit,
  busy,
  onMode,
  onSource,
  onAmount,
  onReview,
}: {
  mode: PaymentMode;
  source: string;
  amount: string;
  debt: string;
  assets: Asset[];
  sources: RepaymentSource[];
  borrower: boolean;
  canDeposit: boolean;
  busy: boolean;
  onMode: (mode: PaymentMode) => void;
  onSource: (source: string) => void;
  onAmount: (amount: string) => void;
  onReview: () => void;
}) {
  const deposited = sources.filter((item) => item.purpose === 'payment');
  const basket = assets.filter((asset) =>
    sources.some(
      (item) =>
        item.purpose === 'collateral' && item.assetId === asset.asset_id,
    ),
  );
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        onReview();
      }}
    >
      <div
        className={styles.methods}
        role="group"
        aria-label="Repayment source"
      >
        <button
          type="button"
          aria-pressed={mode === 'assets'}
          disabled={busy}
          onClick={() => onMode('assets')}
        >
          Assets
        </button>
        {borrower && (
          <button
            type="button"
            aria-pressed={mode === 'collateral'}
            disabled={busy}
            onClick={() => onMode('collateral')}
          >
            Collateral
          </button>
        )}
      </div>
      {mode === 'assets' ? (
        <div>
          <label className={ui.label} htmlFor="repay-source">
            Asset
          </label>
          <div className={styles.select}>
            <Select
              id="repay-source"
              className={ui.field}
              value={source}
              disabled={busy}
              onChange={(event) => onSource(event.target.value)}
              required
            >
              <option value="usdc">USDC · NEAR</option>
              {deposited.map((item) => {
                const asset = assets.find((a) => a.asset_id === item.assetId);
                return (
                  <option key={item.legId} value={`lock:${item.legId}`}>
                    {asset ? assetLabel(asset) : item.assetId} · Deposited
                  </option>
                );
              })}
              {canDeposit &&
                assets
                  .filter((asset) => asset.enabled)
                  .map((asset) => (
                    <option
                      key={asset.asset_id}
                      value={`asset:${asset.asset_id}`}
                    >
                      {assetLabel(asset)}
                    </option>
                  ))}
            </Select>
            <ChevronDown size={16} aria-hidden="true" />
          </div>
        </div>
      ) : (
        <div>
          <span className={ui.label}>Collateral basket</span>
          <div className={styles.basket} aria-label="Collateral basket">
            {basket.map((asset) => (
              <span key={asset.asset_id}>
                {isTokenSymbol(asset.symbol) && (
                  <TokenIcon symbol={asset.symbol} size={22} />
                )}{' '}
                {asset.symbol}
              </span>
            ))}
            {!basket.length && <span>No collateral available</span>}
          </div>
        </div>
      )}
      <div>
        <div className={styles.amountHeading}>
          <label className={ui.label} htmlFor="repay-amount">
            Repay amount · USDC
          </label>
          <button
            type="button"
            className={ui.textButton}
            disabled={busy}
            onClick={() => onAmount(inputAmount(debt))}
          >
            Max
          </button>
        </div>
        <input
          id="repay-amount"
          className={ui.field}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={amount}
          onChange={(event) => onAmount(event.target.value)}
          disabled={busy}
          required
        />
      </div>
      <button
        className={`${ui.primary} ${ui.full}`}
        type="submit"
        disabled={busy || !amount || (mode === 'collateral' && !basket.length)}
      >
        {busy ? 'Preparing…' : 'Review repayment'}
      </button>
      {(mode === 'collateral' || source !== 'usdc') && (
        <p className={styles.solverNote}>
          <CircleAlert size={14} aria-hidden="true" />
          <em>
            Cross-chain repayments use Kanso’s testnet solver, with NEAR Intents
            planned for mainnet.
          </em>
        </p>
      )}
    </form>
  );
}
