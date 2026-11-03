import Link from 'next/link';
import { KansoMark } from '@/components/ui/kanso-mark';
import styles from '@/components/layout/layout.module.css';

export function Wordmark() {
  return (
    <Link href="/" className={styles.wordmark} aria-label="Kanso home">
      <KansoMark width="20" height="20" />
      <span>kanso</span>
    </Link>
  );
}
