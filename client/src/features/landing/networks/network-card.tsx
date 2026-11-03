import { NetworkIcon } from '@/components/ui/network-icon';
import type { SupportedNetwork } from '@/lib/networks';
import styles from '@/features/landing/networks/network-card.module.css';

export function NetworkCard({ network }: { network: SupportedNetwork }) {
  return (
    <li>
      <a
        className={styles.card}
        href={network.evidence_url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`View ${network.name} ${network.testnet} verification (opens in a new tab)`}
      >
        <span className={styles.logo}>
          <NetworkIcon network={network.id} size={48} />
        </span>
        <span className={styles.name}>{network.name}</span>
        <span className={styles.testnet}>{network.testnet}</span>
        {network.id === 'near' && (
          <span className={styles.settlement}>USDC settlement</span>
        )}
      </a>
    </li>
  );
}
