import type {
  Asset,
  RepaymentEstimate,
  BasketRepaymentQuote,
} from '@kanso/schema';
import { assetLabel } from '@/features/repayment/form';
import { inputAmount } from '@/lib/amounts';
import ui from '@/features/workspace/workspace.module.css';
import styles from '@/features/repayment/repayment.module.css';

export function PaymentReview({
  amount,
  estimate,
  basket,
  expiresAt,
  fundingRequired,
  assets,
  busy,
  onBack,
  onConfirm,
}: {
  amount: string;
  estimate?: RepaymentEstimate | undefined;
  basket?: BasketRepaymentQuote | undefined;
  expiresAt: number;
  fundingRequired: boolean;
  assets: Asset[];
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const asset = assets.find((a) => a.asset_id === estimate?.asset_id);
  return (
    <div className={`${styles.form} ${styles.reviewForm}`}>
      <dl className={styles.review}>
        <div>
          <dt>Pay with</dt>
          <dd>
            {basket
              ? 'Collateral basket'
              : estimate
                ? asset
                  ? assetLabel(asset)
                  : estimate.asset_id
                : 'USDC · NEAR'}
          </dd>
        </div>
        {basket ? (
          <div>
            <dt>Basket value</dt>
            <dd>{inputAmount(basket.basket_value_atomic)} USDC</dd>
          </div>
        ) : (
          <div>
            <dt>You pay</dt>
            <dd>
              {estimate
                ? `${inputAmount(estimate.input_atomic, estimate.decimals)} ${asset?.symbol ?? estimate.asset_id}`
                : `${inputAmount(amount)} USDC`}
            </dd>
          </div>
        )}
        <div>
          <dt>Repay amount</dt>
          <dd>{inputAmount(amount)} USDC</dd>
        </div>
        {estimate && (
          <>
            <div>
              <dt>Execution fee</dt>
              <dd>{inputAmount(estimate.execution_cost_atomic)} USDC</dd>
            </div>
            {estimate.max_source_fee_atomic !== '0' && (
              <div>
                <dt>Network fee allowance</dt>
                <dd>
                  {inputAmount(
                    estimate.max_source_fee_atomic,
                    estimate.decimals,
                  )}{' '}
                  {asset?.symbol ?? estimate.asset_id}
                </dd>
              </div>
            )}
          </>
        )}
      </dl>
      {basket && (
        <>
          <div className={styles.sales}>
            <p className={ui.label}>Assets to sell</p>
            {basket.allocations.map((allocation) => {
              const asset = assets.find(
                (a) => a.asset_id === allocation.asset_id,
              );
              return (
                <div key={allocation.leg_id}>
                  <span>{asset ? assetLabel(asset) : allocation.asset_id}</span>
                  <strong>
                    {inputAmount(allocation.input_atomic, allocation.decimals)}{' '}
                    {asset?.symbol ?? allocation.asset_id}
                  </strong>
                </div>
              );
            })}
          </div>
          <dl className={styles.review}>
            <div>
              <dt>Execution fee</dt>
              <dd>{inputAmount(basket.execution_cost_atomic)} USDC</dd>
            </div>
          </dl>
          <p className={ui.muted}>
            Unused collateral stays in your basket. Surplus above your debt is
            refunded.
          </p>
        </>
      )}
      {estimate && fundingRequired && (
        <p className={ui.notice}>
          First, deposit the payment asset. You’ll review the final quote after
          it is confirmed.
        </p>
      )}
      {estimate && BigInt(estimate.net_output_atomic) > BigInt(amount) && (
        <p className={ui.muted}>
          Conversion supplies {inputAmount(estimate.net_output_atomic)} USDC.
          Any amount above your outstanding debt is returned to you on NEAR.
        </p>
      )}
      <p className={ui.muted}>
        Quote valid until{' '}
        {new Date(expiresAt * 1000).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}
        .
      </p>
      <div className={`${styles.buttons} ${styles.reviewActions}`}>
        <button
          type="button"
          className={ui.secondary}
          disabled={busy}
          onClick={onBack}
        >
          Back
        </button>
        <button
          type="button"
          className={ui.primary}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy
            ? 'Preparing…'
            : estimate && fundingRequired
              ? 'Deposit payment asset'
              : 'Confirm repayment'}
        </button>
      </div>
    </div>
  );
}
