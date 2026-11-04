import type { Asset } from '@kanso/schema';
import { Select } from '@/components/ui/select';
import { inputAmount } from '@/lib/amounts';
import { networks } from '@/lib/networks';
import ui from '@/features/workspace/workspace.module.css';
import styles from '@/features/repayment/repayment.module.css';

export type PaymentMode = 'direct' | 'wallet' | 'collateral';
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
  const choices = sources.filter(
    (source) =>
      source.purpose === (mode === 'collateral' ? 'collateral' : 'payment'),
  );
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        onReview();
      }}
    >
      <div>
        <label className={ui.label} htmlFor="repay-method">
          Pay with
        </label>
        <Select
          id="repay-method"
          className={ui.field}
          value={mode}
          disabled={busy}
          onChange={(e) => onMode(e.target.value as PaymentMode)}
        >
          <option value="direct">USDC on NEAR</option>
          <option value="wallet">Wallet asset</option>
          {borrower && (
            <option value="collateral">Collateral from your basket</option>
          )}
        </Select>
      </div>
      {mode !== 'direct' && (
        <div>
          <label className={ui.label} htmlFor="repay-source">
            {mode === 'collateral' ? 'Collateral' : 'Asset'}
          </label>
          <Select
            id="repay-source"
            className={ui.field}
            value={source}
            disabled={busy}
            onChange={(e) => onSource(e.target.value)}
            required
          >
            <option value="">Choose an asset</option>
            {choices.map((source) => {
              const asset = assets.find((a) => a.asset_id === source.assetId);
              return (
                <option key={source.legId} value={`lock:${source.legId}`}>
                  {asset ? assetLabel(asset) : source.assetId}
                  {mode === 'wallet' ? ' · Already deposited' : ''}
                </option>
              );
            })}
            {mode === 'wallet' &&
              canDeposit &&
              assets
                .filter((a) => a.enabled)
                .map((asset) => (
                  <option
                    key={asset.asset_id}
                    value={`asset:${asset.asset_id}`}
                  >
                    {assetLabel(asset)}
                  </option>
                ))}
          </Select>
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
          onChange={(e) => onAmount(e.target.value)}
          disabled={busy}
          required
        />
      </div>
      <button
        className={`${ui.primary} ${ui.full}`}
        type="submit"
        disabled={busy || !amount || (mode !== 'direct' && !source)}
      >
        {busy ? 'Preparing…' : 'Review repayment'}
      </button>
      {mode !== 'direct' && (
        <p className={ui.muted}>
          Cross-chain repayments use Kanso’s testnet solver, with NEAR Intents
          planned for mainnet.
        </p>
      )}
    </form>
  );
}
