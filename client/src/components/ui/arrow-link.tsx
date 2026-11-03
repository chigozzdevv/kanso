import type { ComponentPropsWithoutRef } from 'react';
import styles from '@/components/ui/arrow-link.module.css';

export function ArrowLink({
  href,
  className = '',
  children,
  ...props
}: ComponentPropsWithoutRef<'a'> & { href: string }) {
  return (
    <a {...props} href={href} className={`button ${styles.link} ${className}`}>
      {children}
      <svg
        className={styles.arrow}
        viewBox="0 0 26 22"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path className={styles.shaft} pathLength="1" d="M3 11h20" />
        <path className={styles.head} d="m17 5 6 6-6 6" />
      </svg>
    </a>
  );
}
