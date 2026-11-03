'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Menu, X } from 'lucide-react';
import { Wordmark } from '@/components/layout/wordmark';
import styles from '@/components/layout/layout.module.css';

const links = [
  { href: '#why-kanso', label: 'Why Kanso' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#networks', label: 'Chains' },
];

export function Navbar() {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  return (
    <header className={styles.header}>
      <nav className={`container ${styles.nav}`} aria-label="Main navigation">
        <Wordmark />
        <div className={styles.desktopLinks}>
          {links.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </div>
        <a href="/app/" className={`button ${styles.navCta}`}>
          Borrow USDC
        </a>
        <button
          ref={toggle}
          className={styles.menuToggle}
          type="button"
          aria-label={open ? 'Close navigation' : 'Open navigation'}
          aria-expanded={open}
          aria-controls="mobile-navigation"
          onClick={() => setOpen(!open)}
        >
          {open ? <X size={23} /> : <Menu size={23} />}
        </button>
        <div
          id="mobile-navigation"
          className={styles.mobileLinks}
          hidden={!open}
        >
          {links.map((link) => (
            <a key={link.href} href={link.href} onClick={() => setOpen(false)}>
              {link.label}
              <ArrowUpRight size={18} aria-hidden="true" />
            </a>
          ))}
          <a href="#questions" onClick={() => setOpen(false)}>
            A few questions
            <ArrowUpRight size={18} aria-hidden="true" />
          </a>
          <a href="/app/" onClick={() => setOpen(false)}>
            Borrow USDC
            <ArrowUpRight size={18} aria-hidden="true" />
          </a>
        </div>
      </nav>
    </header>
  );
}
