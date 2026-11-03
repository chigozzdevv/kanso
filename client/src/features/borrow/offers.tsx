import type { Offer, PoolPolicy } from '@kanso/schema';
import { estimate_offer_costs } from '@kanso/sdk';
import { formatAmount } from '@/lib/amounts';
import ui from '@/features/workspace/workspace.module.css';
import styles from '@/features/borrow/borrow.module.css';

export function Offers({
  offers,
  policies,
  onAccept,
  busy,
}: {
  offers: Offer[];
  policies: Record<string, PoolPolicy>;
  onAccept: (offer: Offer) => void;
  busy: boolean;
}) {
  return (
    <div className={styles.offers}>
      {offers.map((offer) => {
        const costs = estimate_offer_costs(offer);
        const policy = policies[offer.pool_id];
        return (
          <article className={styles.offer} key={offer.offer_id}>
            <div className={styles.offerHeader}>
              <h3>{offer.pool_id}</h3>
              <span>
                {offer.duration_seconds / 86400 >= 1
                  ? `${offer.duration_seconds / 86400} days`
                  : `${offer.duration_seconds / 3600} hours`}
              </span>
            </div>
            <dl className={styles.offerTerms}>
              <div>
                <dt>You receive</dt>
                <dd>{formatAmount(offer.principal_atomic)} USDC</dd>
              </div>
              <div>
                <dt>APR</dt>
                <dd>{offer.apr_bps / 100}%</dd>
              </div>
              <div>
                <dt>Origination fee</dt>
                <dd>{formatAmount(offer.origination_fee_atomic, 6, 6)} USDC</dd>
              </div>
            </dl>
            <dl className={styles.costs}>
              <div>
                <dt>Estimated full-term interest</dt>
                <dd>{formatAmount(costs.interest_atomic, 6, 6)} USDC</dd>
              </div>
              <div>
                <dt>Total if held to maturity</dt>
                <dd>{formatAmount(costs.total_repayment_atomic, 6, 6)} USDC</dd>
              </div>
            </dl>
            {policy && (
              <p className={styles.risk}>
                Pool LTV cap {policy.ltv_bps / 100}% · Liquidation threshold{' '}
                {policy.liquidation_threshold_bps / 100}%
              </p>
            )}
            <div className={styles.offerFooter}>
              <p>
                The estimate assumes full principal stays borrowed for the term.
                Your collateral can be liquidated if basket health falls below
                its required threshold.
              </p>
              <button
                type="button"
                className={ui.primary}
                disabled={
                  busy ||
                  !policy ||
                  policy.version !== offer.policy_version ||
                  offer.expires_at * 1000 <= Date.now()
                }
                onClick={() => onAccept(offer)}
              >
                {busy ? 'Confirm in wallet…' : 'Accept offer'}
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
