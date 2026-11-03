import { BasketOverview } from '@/features/landing/illustrations/basket-overview';
import { FlexibleBasket } from '@/features/landing/illustrations/flexible-basket';
import { LiquidityPool } from '@/features/landing/illustrations/liquidity-pool';
import { NativeChains } from '@/features/landing/illustrations/native-chains';
import styles from '@/features/landing/benefits.module.css';

export function Benefits() {
  return (
    <section
      id="why-kanso"
      className={`container ${styles.section}`}
      aria-labelledby="benefits-title"
    >
      <div className={styles.heading}>
        <h2 id="benefits-title">More room for your next move.</h2>
      </div>
      <div className={styles.grid}>
        <article className={`${styles.card} ${styles.native}`}>
          <h3>
            At home
            <br />
            on every chain.
          </h3>
          <p>Your collateral stays on its native chain.</p>
          <div className={styles.illustration}>
            <NativeChains />
          </div>
        </article>
        <article className={`${styles.card} ${styles.balance}`}>
          <h3>
            Keep the whole
            <br />
            picture in view.
          </h3>
          <p>Keep your debt and combined basket health in view.</p>
          <div className={styles.illustration}>
            <BasketOverview />
          </div>
        </article>
        <article className={`${styles.card} ${styles.flexible}`}>
          <h3>
            A basket that
            <br />
            moves with you.
          </h3>
          <p>Top up, replace assets or withdraw safe excess.</p>
          <div className={styles.illustration}>
            <FlexibleBasket />
          </div>
        </article>
        <article className={`${styles.card} ${styles.liquidity}`}>
          <h3>
            Be on the other
            <br />
            side of possibility.
          </h3>
          <p>Supply pool liquidity and share in loan interest.</p>
          <div className={styles.illustration}>
            <LiquidityPool />
          </div>
        </article>
      </div>
    </section>
  );
}
