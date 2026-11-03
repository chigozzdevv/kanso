import { ArrowLink } from '@/components/ui/arrow-link';
import styles from '@/features/landing/closing.module.css';

export function Closing() {
  return (
    <section
      id="get-started"
      className={`container ${styles.section}`}
      aria-labelledby="closing-title"
    >
      <h2 id="closing-title">Borrow against what you already hold.</h2>
      <ArrowLink href="/app/" className={styles.cta}>
        Build your basket
      </ArrowLink>
    </section>
  );
}
