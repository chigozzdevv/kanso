import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC';
import { Artwork } from '@/features/landing/illustrations/artwork';
import styles from '@/features/landing/illustrations/artwork.module.css';

export function LiquidityPool() {
  return (
    <Artwork>
      <rect
        x="85"
        y="42"
        width="258"
        height="153"
        rx="24"
        fill="#173c2b"
        transform="rotate(9 214 118)"
      />
      <rect
        x="73"
        y="49"
        width="270"
        height="158"
        rx="24"
        fill="#e79c9e"
        transform="rotate(-6 208 128)"
      />
      <g className={styles.shadow}>
        <rect
          className={styles.paper}
          x="54"
          y="64"
          width="312"
          height="151"
          rx="24"
        />
        <text className={styles.label} x="82" y="101">
          Pool liquidity
        </text>
        <TokenUSDC x="74" y="115" size={66} variant="branded" />
        <text className={styles.value} x="148" y="158">
          USDC
        </text>
        <circle cx="324" cy="149" r="19" fill="#d2fae4" />
        <path className={styles.stroke} d="M324 158v-18m-7 7 7-7 7 7" />
      </g>
    </Artwork>
  );
}
