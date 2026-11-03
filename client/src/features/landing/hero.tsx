import { BasketIcon } from '@/components/ui/basket-icon';
import { ArrowLink } from '@/components/ui/arrow-link';
import { TokenIcon } from '@/components/ui/token-icon';
import { AssetCombination } from '@/features/landing/asset-combination';
import styles from '@/features/landing/hero.module.css';

export function Hero() {
  return (
    <section
      className={`container ${styles.hero}`}
      aria-labelledby="hero-title"
    >
      <h1
        id="hero-title"
        className={styles.title}
        aria-label="Merge NEAR, BTC, SOL, ETH and other eligible assets into one collateral basket and borrow USDC."
      >
        <span className={styles.heroLine}>
          Merge <AssetCombination />
        </span>{' '}
        <span className={styles.heroLine}>
          into one collateral{' '}
          <span className={styles.basket}>
            <BasketIcon />
            <span className="sr-only">basket</span>
          </span>
        </span>{' '}
        <span className={styles.heroLine}>
          and borrow{' '}
          <span className={styles.usdc}>
            <TokenIcon symbol="USDC" size={56} />
            USDC.
          </span>
        </span>
      </h1>
      <div className={styles.actions}>
        <ArrowLink href="/app/" className={styles.tryButton}>
          Try Kanso
        </ArrowLink>
      </div>
    </section>
  );
}
