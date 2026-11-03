import { ArrowUpRight } from 'lucide-react';
import { Wordmark } from '@/components/layout/wordmark';
import { coordinator_url } from '@/lib/networks';
import styles from '@/components/layout/layout.module.css';

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={`container ${styles.footerTop}`}>
        <Wordmark />
        <span className={styles.copyright}>
          © {new Date().getFullYear()} Kanso
        </span>
        <nav aria-label="Footer navigation">
          <a href="#networks">Supported chains</a>
          <a href="#questions">Questions</a>
          <a href={coordinator_url} target="_blank" rel="noopener noreferrer">
            Contracts
            <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        </nav>
      </div>
    </footer>
  );
}
