import type { ReactNode } from 'react';
import styles from '@/features/landing/illustrations/artwork.module.css';

export function Artwork({ children }: { children: ReactNode }) {
  return (
    <svg
      className={styles.artwork}
      viewBox="0 0 420 220"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}
