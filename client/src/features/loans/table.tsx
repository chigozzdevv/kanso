import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { Loan } from '@kanso/schema';
import { formatAmount, shortAddress } from '@/lib/amounts';
import styles from '@/features/loans/loans.module.css';

const stateLabels: Record<Loan['state'], string> = {
  pending_funding: 'Pending funding',
  active: 'Active',
  repaid: 'Repaid',
  cancelled: 'Cancelled',
  written_off: 'Written off',
};

export function LoanTable({ loans }: { loans: Loan[] }) {
  return (
    <table className={styles.table}>
      <caption className="sr-only">Your loans</caption>
      <thead>
        <tr>
          <th scope="col">Loan</th>
          <th scope="col">Borrowed</th>
          <th scope="col">Status</th>
          <th scope="col">Maturity</th>
          <th scope="col">
            <span className="sr-only">View loan</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {loans.map((loan) => (
          <tr key={loan.loan_id}>
            <td>
              <Link
                className={styles.loanLink}
                href={`/app/?view=loans&loan_id=${encodeURIComponent(loan.loan_id)}`}
                aria-label={`View loan ${loan.loan_id}`}
              >
                {shortAddress(loan.loan_id)}
              </Link>
              <span className={styles.poolName}>{loan.offer.pool_id}</span>
            </td>
            <td className={styles.borrowed}>
              <span className={styles.cellLabel}>Borrowed</span>
              {formatAmount(loan.offer.principal_atomic)} USDC
            </td>
            <td>
              <span className={styles.status} data-state={loan.state}>
                {stateLabels[loan.state]}
              </span>
            </td>
            <td className={styles.maturity}>
              <span className={styles.cellLabel}>Maturity</span>
              {loan.matures_at ? (
                <time dateTime={new Date(loan.matures_at * 1000).toISOString()}>
                  {new Date(loan.matures_at * 1000).toLocaleDateString(
                    'en-US',
                    { month: 'short', day: 'numeric', year: 'numeric' },
                  )}
                </time>
              ) : (
                '—'
              )}
            </td>
            <td className={styles.rowArrow}>
              <ArrowRight size={16} aria-hidden="true" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
