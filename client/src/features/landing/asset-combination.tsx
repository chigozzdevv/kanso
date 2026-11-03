'use client';

import { Fragment, useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
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
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      if (!paused && !motion.matches && !document.hidden) {
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
  }, [paused]);

  return (
    <span className={styles.combination}>
      <span className="sr-only">
        NEAR, BTC, SOL, ETH and other eligible assets
      </span>
      <span className={styles.assetList} aria-hidden="true" key={index}>
        {combinations[index]!.map((symbol, position) => (
          <Fragment key={symbol}>
            {position > 0 && <span className={styles.plus}>+</span>}
            <span className={styles.asset}>
              <TokenIcon symbol={symbol} size={28} />
              <span>{symbol}</span>
            </span>
          </Fragment>
        ))}
      </span>
      <span className={styles.more} aria-hidden="true">
        + …
      </span>
      <button
        className={styles.animationToggle}
        type="button"
        aria-label={paused ? 'Play asset animation' : 'Pause asset animation'}
        aria-pressed={paused}
        onClick={() => setPaused(!paused)}
      >
        {paused ? <Play size={12} fill="currentColor" /> : <Pause size={12} />}
      </button>
    </span>
  );
}
