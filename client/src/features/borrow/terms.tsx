import { ArrowRight, ChevronDown } from 'lucide-react';
import { TokenIcon } from '@/components/ui/token-icon';
import { Select } from '@/components/ui/select';
import { useKanso } from '@/components/layout/providers';
import ui from '@/features/workspace/workspace.module.css';
import styles from '@/features/borrow/borrow.module.css';

export function LoanTerms({
  principal,
  duration,
  onPrincipal,
  onDuration,
  onReview,
  busy,
  ready,
}: {
  principal: string;
  duration: string;
  onPrincipal: (value: string) => void;
  onDuration: (value: string) => void;
  onReview: () => void;
  busy: boolean;
  ready: boolean;
}) {
  const { account, catalog } = useKanso();
  const maxDuration = Math.max(
    0,
    ...(catalog?.pools.map((pool) => pool.pool.policy.max_duration_seconds) ??
      []),
  );
  const durations = [
    { seconds: 3600, label: '1 hour' },
    { seconds: 86400, label: '1 day' },
    { seconds: 604800, label: '7 days' },
    { seconds: 1209600, label: '14 days' },
    { seconds: 2592000, label: '30 days' },
  ].filter((option) => option.seconds <= maxDuration);
  return (
    <aside className={ui.card} aria-labelledby="loan-terms-title">
      <h2 id="loan-terms-title">Your loan</h2>
      <div className={ui.fieldGroup}>
        <label htmlFor="principal" className={ui.label}>
          Borrow amount
        </label>
        <div className={styles.principal}>
          <input
            id="principal"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={principal}
            disabled={!catalog || busy}
            onChange={(e) => onPrincipal(e.target.value)}
          />
          <span>
            <TokenIcon symbol="USDC" size={24} />
            USDC
          </span>
        </div>
      </div>
      <div className={ui.fieldGroup}>
        <label htmlFor="duration" className={ui.label}>
          Loan duration
        </label>
        <div className={styles.select}>
          <Select
            id="duration"
            className={ui.field}
            value={duration}
            disabled={!catalog || busy}
            onChange={(e) => onDuration(e.target.value)}
          >
            {durations.map((option) => (
              <option key={option.seconds} value={option.seconds}>
                {option.label}
              </option>
            ))}
          </Select>
          <ChevronDown size={15} />
        </div>
      </div>
      <button
        type="button"
        className={`${ui.primary} ${ui.full} ${styles.review}`}
        disabled={busy || !ready}
        onClick={onReview}
      >
        {busy
          ? 'Preparing offers…'
          : account
            ? 'Review offers'
            : 'Connect wallet to continue'}
        {!busy && <ArrowRight size={17} />}
      </button>
    </aside>
  );
}
