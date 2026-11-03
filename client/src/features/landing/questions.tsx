import { Plus } from 'lucide-react';
import styles from '@/features/landing/questions.module.css';

const questions = [
  {
    title: 'Do I need to move everything to one chain?',
    answer:
      'No. Your chosen assets are locked on their original chains. Kanso combines them into one collateral basket, with the loan and its accounting on NEAR.',
  },
  {
    title: 'What happens when I repay?',
    answer:
      'Once your debt is paid and pending settlements are complete, you can release your remaining collateral back to your wallets.',
  },
  {
    title: 'Can my collateral be liquidated?',
    answer:
      'Yes. If your combined collateral becomes insufficient, or your loan goes into default, collateral can be sold to cover the amount owed. You review the borrowing terms before committing.',
  },
  {
    title: 'Is this using real money?',
    answer:
      'No. Kanso currently uses testnet assets and Circle’s testnet USDC. These tokens have no monetary value.',
  },
];

export function Questions() {
  return (
    <section
      id="questions"
      className={`container ${styles.section}`}
      aria-labelledby="questions-title"
    >
      <div className={styles.heading}>
        <h2 id="questions-title" className="section-heading">
          A few things <br />
          you might ask.
        </h2>
      </div>
      <div className={styles.questions}>
        {questions.map((question) => (
          <details key={question.title} name="kanso-questions">
            <summary>
              {question.title}
              <Plus size={17} aria-hidden="true" />
            </summary>
            <p>{question.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
