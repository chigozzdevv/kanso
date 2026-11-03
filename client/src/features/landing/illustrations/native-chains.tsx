import NetworkBitcoin from '@web3icons/react/icons/networks/NetworkBitcoin';
import NetworkNearProtocol from '@web3icons/react/icons/networks/NetworkNearProtocol';
import NetworkSolana from '@web3icons/react/icons/networks/NetworkSolana';
import { Artwork } from '@/features/landing/illustrations/artwork';
import styles from '@/features/landing/illustrations/artwork.module.css';

const networks = [
  { Icon: NetworkBitcoin, name: 'Bitcoin', x: 36, y: 78, rotation: -9 },
  { Icon: NetworkSolana, name: 'Solana', x: 270, y: 78, rotation: 9 },
  { Icon: NetworkNearProtocol, name: 'NEAR', x: 153, y: 43, rotation: 0 },
];

export function NativeChains() {
  return (
    <Artwork>
      {networks.map(({ Icon, name, x, y, rotation }) => (
        <g
          key={name}
          transform={`translate(${x} ${y}) rotate(${rotation} 57 67)`}
        >
          <rect
            className={`${styles.paper} ${styles.shadow}`}
            width="114"
            height="134"
            rx="23"
          />
          <Icon x="31" y="24" size={52} variant="branded" />
          <text className={styles.networkName} x="57" y="106">
            {name}
          </text>
        </g>
      ))}
    </Artwork>
  );
}
