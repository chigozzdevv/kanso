'use client';

import { Fragment, useEffect, useState } from 'react';
import { TokenIcon } from '@/components/ui/token-icon';
import type { TokenSymbol } from '@/components/ui/token-icon';
import styles from '@/features/landing/hero.module.css';

const combinations: readonly (readonly TokenSymbol[])[] = [
  ['NEAR', 'BTC', 'SOL', 'ETH'],
  ['BTC', 'SUI', 'AVAX', 'NEAR'],
  ['ETH', 'BNB', 'POL', 'SOL'],
  ['NEAR', 'HYPE', 'STRK', 'SUI'],
];

export function AssetCombination() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      if (!motion.matches && !document.hidden) {
        timer = setInterval(
          () => setIndex((current) => (current + 1) % combinations.length),
          4200,
        );
      }
    };
    sync();
    motion.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      clearInterval(timer);
      motion.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  const symbols = combinations[index]!;

  return (
    <span className={styles.combination}>
      <span className="sr-only">
        NEAR, BTC, SOL, ETH and other eligible assets
      </span>
      <span className={styles.assetList} aria-hidden="true" key={index}>
        {symbols.map((symbol, position) => (
          <Fragment key={symbol}>
            {position > 0 && <span className={styles.plus}>+</span>}
            {position === symbols.length - 1 && (
              <>
                <span className={styles.more}>…</span>
                <span className={styles.plus}>+</span>
              </>
            )}
            <span className={styles.asset}>
              <TokenIcon symbol={symbol} size={28} />
              <span>{symbol}</span>
            </span>
          </Fragment>
        ))}
      </span>
    </span>
  );
}
