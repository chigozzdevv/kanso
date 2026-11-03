import { ArrowDown, Check, LockKeyhole, LockKeyholeOpen } from 'lucide-react';
import { BasketIcon } from '@/components/ui/basket-icon';
import { TokenIcon } from '@/components/ui/token-icon';
import styles from '@/features/landing/how-it-works/step-preview.module.css';

const assets = [
  { symbol: 'BTC', chain: 'Bitcoin' },
  { symbol: 'SOL', chain: 'Solana' },
  { symbol: 'NEAR', chain: 'NEAR' },
] as const;

export function StepPreview({
  stage,
}: {
  stage: 'basket' | 'borrow' | 'release';
}) {
  return (
    <div className={styles.scene} aria-hidden="true">
      {stage === 'basket' && (
        <div className={styles.card}>
          <div className={styles.heading}>
            <span>Your basket</span>
            <BasketIcon width={26} height={26} />
          </div>
          <div className={styles.assets}>
            {assets.map((asset) => (
              <div key={asset.symbol} className={styles.asset}>
                <TokenIcon symbol={asset.symbol} size={38} />
                <span className={styles.assetName}>
                  <strong>{asset.symbol}</strong>
                  <span>{asset.chain}</span>
                </span>
                <span className={styles.selected}>
                  <Check size={15} strokeWidth={2.2} />
                </span>
              </div>
            ))}
          </div>
          <span className={styles.more}>+ other eligible assets</span>
        </div>
      )}
      {stage === 'borrow' && (
        <div className={`${styles.card} ${styles.loan}`}>
          <div className={styles.locked}>
            <LockKeyhole size={18} />
            <span>Collateral on its native chains</span>
          </div>
          <ArrowDown className={styles.direction} size={24} />
          <TokenIcon symbol="USDC" size={76} />
          <strong className={styles.currency}>USDC</strong>
          <span className={styles.network}>On NEAR</span>
          <span className={styles.badge}>One loan, backed by your basket</span>
        </div>
      )}
      {stage === 'release' && (
        <div className={`${styles.card} ${styles.release}`}>
          <span className={styles.complete}>
            <Check size={32} strokeWidth={2} />
          </span>
          <strong className={styles.repaid}>Loan repaid</strong>
          <div className={styles.unlocked}>
            <span className={styles.releaseLabel}>
              <LockKeyholeOpen size={17} />
              Ready to release
            </span>
            <div className={styles.returnedAssets}>
              {assets.map((asset) => (
                <div key={asset.symbol}>
                  <TokenIcon symbol={asset.symbol} size={34} />
                  <span>{asset.symbol}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
