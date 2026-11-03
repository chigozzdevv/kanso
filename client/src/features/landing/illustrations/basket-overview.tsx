import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC';
import { Artwork } from '@/features/landing/illustrations/artwork';
import styles from '@/features/landing/illustrations/artwork.module.css';

export function BasketOverview() {
  return (
    <Artwork>
      <rect
        className={`${styles.dark} ${styles.shadow}`}
        x="44"
        y="39"
        width="332"
        height="178"
        rx="24"
      />
      <text className={`${styles.label} ${styles.lightLabel}`} x="72" y="76">
        Your loan
      </text>
      <TokenUSDC x="68" y="90" size={48} variant="branded" />
      <text className={`${styles.value} ${styles.lightValue}`} x="120" y="123">
        USDC
      </text>
      <path stroke="#ffffff1f" d="M72 154h276" />
      <text className={`${styles.label} ${styles.lightLabel}`} x="72" y="184">
        Basket health
      </text>
      <path
        stroke="#72e2a5"
        strokeWidth="3"
        d="M255 181h18l9-9 13 18 13-18 9 9h28"
      />
    </Artwork>
  );
}
