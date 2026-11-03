import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { identifier } from '@kanso/schema';
import { Dialog } from '@/components/ui/dialog';
import ui from '@/features/workspace/workspace.module.css';
import styles from '@/features/loans/loans.module.css';

export function LoanLookup({
  onSelect,
  onClose,
}: {
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [loanId, setLoanId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <Dialog title="Find a loan" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = identifier.safeParse(loanId.trim());
          if (!parsed.success) {
            setError('Enter a valid loan ID.');
            return;
          }
          onSelect(parsed.data);
        }}
      >
        <label htmlFor="loan-id" className={ui.label}>
          Loan ID
        </label>
        <input
          id="loan-id"
          ref={input}
          className={ui.field}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!error}
          aria-describedby={error ? 'loan-id-error' : undefined}
          value={loanId}
          onChange={(event) => {
            setLoanId(event.target.value);
            setError(null);
          }}
          placeholder="Enter an onchain loan ID"
          required
        />
        {error && (
          <p id="loan-id-error" className={ui.error} role="alert">
            {error}
          </p>
        )}
        <button
          className={`${ui.primary} ${ui.full} ${styles.lookupSubmit}`}
          type="submit"
          disabled={!loanId.trim()}
        >
          View loan
          <ArrowRight size={16} />
        </button>
      </form>
    </Dialog>
  );
}
