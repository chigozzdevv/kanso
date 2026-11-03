'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Plus, RotateCcw } from 'lucide-react';
import type { Offer, PoolPolicy } from '@kanso/schema';
import { KansoError } from '@kanso/schema';
import { scoped_id } from '@kanso/sdk';
import type { Kanso, Operation } from '@kanso/sdk';
import { BasketIcon } from '@/components/ui/basket-icon';
import { useKanso } from '@/components/layout/providers';
import { BasketPicker } from '@/features/basket/picker';
import { Holding } from '@/features/basket/holding';
import { useBasket } from '@/features/basket/state';
import { LoanTerms } from '@/features/borrow/terms';
import { Offers } from '@/features/borrow/offers';
import { LockProgress, checkpointKey } from '@/features/borrow/lock-progress';
import { deployment } from '@/lib/kanso';
import { parseAmount, errorMessage } from '@/lib/amounts';
import ui from '@/features/workspace/workspace.module.css';
import basketStyles from '@/features/basket/basket.module.css';

export function BorrowFlow() {
  const { client, catalog, loading, connect, connections, account } =
    useKanso();
  const { entries, setEntries } = useBasket(catalog?.assets);
  const [picker, setPicker] = useState(false);
  const [principal, setPrincipal] = useState('');
  const [duration, setDuration] = useState('604800');
  const [busy, setBusy] = useState(false);
  const [policies, setPolicies] = useState<Record<string, PoolPolicy>>({});
  const [error, setError] = useState<string | null>(null);
  const [offers, setOffers] = useState<Awaited<
    ReturnType<ReturnType<Kanso['request']>['offers']>
  > | null>(null);
  const request = useRef<ReturnType<Kanso['request']> | null>(null);
  const acceptance = useRef<{ offerId: string; key: string } | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [previous, setPrevious] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(checkpointKey) ?? 'null');
      if (
        saved?.deployment_id === deployment.deployment_id &&
        typeof saved.operation_id === 'string'
      )
        setPrevious(saved.operation_id);
    } catch {
      setPrevious(null);
    }
  }, []);

  async function review() {
    setBusy(true);
    setError(null);
    try {
      const basket = entries.map((entry) => {
        const source = connections.find((w) => w.family === entry.asset.family);
        return {
          asset_id: entry.asset.asset_id,
          amount_atomic: parseAmount(entry.amount, entry.asset.decimals),
          ...(source ? { source_account: source.address } : {}),
        };
      });
      const amount = parseAmount(
        principal,
        deployment.near.settlement_decimals,
      );
      const seconds = Number(duration);
      if (!Number.isSafeInteger(seconds) || seconds <= 0)
        throw new Error('Choose a valid loan duration.');
      const wallet = await connect('near');
      for (const entry of entries) {
        const source = await connect(entry.asset.family);
        const available = await source.balance(entry.asset);
        if (
          BigInt(parseAmount(entry.amount, entry.asset.decimals)) >
          BigInt(available)
        )
          throw new Error(
            `Your ${entry.asset.symbol} amount exceeds the available wallet balance.`,
          );
      }
      const current = client.request({
        borrower: wallet.address,
        basket,
        loan_terms: {
          principal_atomic: amount,
          duration_seconds: seconds,
          payout_account: wallet.address,
        },
        conditional_repayment: { enabled: false },
      });
      request.current = current;
      const response = await current.offers();
      const reviewedPolicies = await Promise.all(
        response.offers.map(async (offer) => {
          const policy = await client.pool(offer.pool_id).policy();
          if (policy.version !== offer.policy_version)
            throw new Error('Pool terms changed. Request fresh offers.');
          return [offer.pool_id, policy] as const;
        }),
      );
      setPolicies(Object.fromEntries(reviewedPolicies));
      setOffers(response);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function accept(offer: Offer) {
    if (!request.current || !account) return;
    setBusy(true);
    setError(null);
    try {
      if (offer.expires_at <= Math.floor(Date.now() / 1000))
        throw new Error(
          'This offer expired. Refresh your offers before accepting.',
        );
      if (acceptance.current?.offerId !== offer.offer_id)
        acceptance.current = {
          offerId: offer.offer_id,
          key: crypto.randomUUID(),
        };
      const key = acceptance.current.key;
      const operationId = scoped_id(deployment.deployment_id, account, key);
      try {
        localStorage.setItem(
          checkpointKey,
          JSON.stringify({
            deployment_id: deployment.deployment_id,
            operation_id: operationId,
            owner: account,
          }),
        );
      } catch {
        // The same idempotency key still resolves the operation through the API.
      }
      setPrevious(operationId);
      setOperation(
        await request.current.accept({
          offer_id: offer.offer_id,
          idempotency_key: key,
        }),
      );
    } catch (e) {
      if (e instanceof KansoError && e.operation_id) {
        try {
          setOperation(await client.operation(e.operation_id));
        } catch {
          setError(errorMessage(e));
        }
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    if (!previous) return;
    setBusy(true);
    setError(null);
    try {
      const wallet = await connect('near');
      await client.session.connect(wallet.address);
      const op = await client.operation(previous);
      if (op.checkpoint().owner !== wallet.address)
        throw new Error('Connect the account that started this operation.');
      setOperation(op);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (operation)
    return (
      <LockProgress
        operation={operation}
        onDone={() => {
          setOperation(null);
          setOffers(null);
        }}
      />
    );

  return (
    <>
      {previous && (
        <div style={{ marginBottom: 16 }}>
          <button
            type="button"
            className={ui.textButton}
            disabled={busy}
            onClick={() => void resume()}
          >
            <RotateCcw size={13} />
            Resume previous operation
          </button>
        </div>
      )}
      {offers ? (
        <section className={ui.card}>
          <div className={ui.cardHeading}>
            <h2>Choose your offer</h2>
            <button
              type="button"
              className={ui.textButton}
              disabled={busy}
              onClick={() => {
                setOffers(null);
                setError(null);
              }}
            >
              <ArrowLeft size={14} />
              Edit basket
            </button>
          </div>
          <Offers
            offers={offers.offers}
            policies={policies}
            onAccept={(offer) => void accept(offer)}
            busy={busy}
          />
          {!offers.offers.length && (
            <p className={`${ui.notice} ${ui.actions}`}>
              No pool could fund these terms. Adjust your basket, amount or
              duration.
            </p>
          )}
          {offers.rejections.map((rejection) => (
            <p
              key={rejection.pool_id}
              className={ui.notice}
              style={{ marginTop: 12 }}
            >
              {rejection.pool_id}: {rejection.reason}
            </p>
          ))}
        </section>
      ) : (
        <div className={ui.borrowGrid}>
          <section className={ui.card} aria-labelledby="basket-title">
            <div className={ui.cardHeading}>
              <h2 id="basket-title">
                Collateral basket{entries.length > 0 && ` · ${entries.length}`}
              </h2>
              <button
                type="button"
                className={ui.textButton}
                disabled={!catalog || busy}
                onClick={() => setPicker(true)}
              >
                <Plus size={15} />
                Add assets
              </button>
            </div>
            {loading ? (
              <p className={ui.skeleton}>Loading eligible assets…</p>
            ) : entries.length ? (
              <ul
                className={basketStyles.holdings}
                aria-label="Selected collateral"
                tabIndex={0}
              >
                {entries.map((entry) => (
                  <Holding
                    key={entry.asset.asset_id}
                    entry={entry}
                    onChange={(amount) =>
                      setEntries((current) =>
                        current.map((e) =>
                          e.asset.asset_id === entry.asset.asset_id
                            ? { ...e, amount }
                            : e,
                        ),
                      )
                    }
                    onRemove={() =>
                      setEntries((current) =>
                        current.filter(
                          (e) => e.asset.asset_id !== entry.asset.asset_id,
                        ),
                      )
                    }
                  />
                ))}
              </ul>
            ) : (
              <div className={ui.empty}>
                <span className={ui.emptyIcon}>
                  <BasketIcon width={34} height={34} />
                </span>
                <h3>Start with what you hold.</h3>
                <button
                  type="button"
                  className={ui.secondary}
                  disabled={!catalog}
                  onClick={() => setPicker(true)}
                >
                  <Plus size={16} />
                  Choose assets
                </button>
              </div>
            )}
          </section>
          <LoanTerms
            principal={principal}
            duration={duration}
            onPrincipal={setPrincipal}
            onDuration={setDuration}
            onReview={() => void review()}
            busy={busy}
            ready={
              !!catalog &&
              entries.length > 0 &&
              entries.every((entry) => entry.amount.trim()) &&
              !!principal.trim()
            }
          />
        </div>
      )}
      {error && (
        <p className={ui.error} role="alert">
          {error}
        </p>
      )}
      {picker && catalog && (
        <BasketPicker
          assets={catalog.assets}
          selected={entries.map((entry) => entry.asset.asset_id)}
          onApply={(assets) =>
            setEntries(
              assets.map(
                (asset) =>
                  entries.find(
                    (entry) => entry.asset.asset_id === asset.asset_id,
                  ) ?? { asset, amount: '' },
              ),
            )
          }
          onClose={() => setPicker(false)}
        />
      )}
    </>
  );
}
