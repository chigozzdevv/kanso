import { Artwork } from '@/features/landing/illustrations/artwork';
import styles from '@/features/landing/illustrations/artwork.module.css';

export function FlexibleBasket() {
  return (
    <Artwork>
      <g transform="rotate(-7 210 137)">
        <path className={styles.handle} d="M155 101V87a55 55 0 0 1 110 0v14" />
        <path
          className={`${styles.paper} ${styles.shadow}`}
          d="M100 104h220l-23 92a19 19 0 0 1-18 14H141a19 19 0 0 1-18-14z"
        />
        <rect x="91" y="96" width="238" height="20" rx="10" fill="#173c2b" />
        <path
          stroke="#dba36e"
          strokeWidth="11"
          d="m153 137 8 47m49-47v47m57-47-8 47"
        />
      </g>
      <circle className={styles.paper} cx="325" cy="57" r="23" />
      <path className={styles.stroke} d="M325 47v20m-10-10h20" />
    </Artwork>
  );
}
