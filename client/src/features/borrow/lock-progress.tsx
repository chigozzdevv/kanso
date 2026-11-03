'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, LoaderCircle } from 'lucide-react';
import type { Operation } from '@kanso/sdk';
import type { OperationSnapshot } from '@kanso/schema';
import { errorMessage } from '@/lib/amounts';
import { deployment } from '@/lib/kanso';
import ui from '@/features/workspace/workspace.module.css';
import styles from '@/features/borrow/borrow.module.css';

export const checkpointKey = `kanso:operation:${deployment.deployment_id}`;

export function LockProgress({
  operation,
  onDone,
}: {
  operation: Operation;
  onDone?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<OperationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(
        checkpointKey,
        JSON.stringify(operation.checkpoint()),
      );
    } catch {
      /* Progress also remains in the API if browser storage is unavailable. */
    }
    return operation.subscribe(setSnapshot, (e) => setError(errorMessage(e)));
  }, [operation]);
  async function execute() {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await operation.resume());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await operation.cancel());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const terminal =
    snapshot && ['succeeded', 'failed', 'cancelled'].includes(snapshot.status);
  return (
    <section className={ui.card} aria-labelledby="progress-title">
      <h2 id="progress-title">
        {snapshot?.status === 'succeeded'
          ? snapshot.plan.kind === 'setup'
            ? 'Your loan is funded.'
            : 'Operation complete.'
          : 'Your progress'}
      </h2>
      <span className={styles.operationId}>{operation.operation_id}</span>
      {!snapshot && <p className={ui.skeleton}>Loading confirmed progress…</p>}
      <ol className={styles.progress}>
        {snapshot?.steps.map((step) => (
          <li key={step.step_id}>
            {step.state === 'confirmed' ? (
              <CheckCircle2 size={18} />
            ) : ['submitted', 'unknown'].includes(step.state) ? (
              <LoaderCircle size={18} />
            ) : (
              <Circle size={18} />
            )}
            <div>
              <strong>{step.label}</strong>
              <p>
                {step.state === 'unknown'
                  ? 'Reconciling — waiting for evidence'
                  : step.state}
                {step.transaction_id && ` · ${step.transaction_id}`}
              </p>
              {step.error && <p>{step.error}</p>}
            </div>
          </li>
        ))}
      </ol>
      {snapshot && !terminal && (
        <p className={`${ui.notice} ${ui.actions}`}>
          Submitted transactions still need confirmation and verification.
          Closing this page does not cancel the operation.
        </p>
      )}
      {(error || snapshot?.error) && (
        <p className={ui.error} role="alert">
          {error ?? snapshot?.error?.message}
        </p>
      )}
      <div className={ui.actions}>
        {snapshot?.status === 'succeeded' && snapshot.plan.kind === 'setup' && (
          <a
            className={ui.primary}
            href={`/app/?view=loans&loan_id=${encodeURIComponent(snapshot.plan.offer.offer_id)}`}
          >
            View loan
          </a>
        )}
        {snapshot?.status === 'requires_action' && (
          <button
            type="button"
            className={ui.primary}
            disabled={busy}
            onClick={() => void execute()}
          >
            {busy ? 'Confirm in wallet…' : 'Continue in wallet'}
          </button>
        )}
        {snapshot && !terminal && !snapshot.cancellation_requested && (
          <button
            type="button"
            className={ui.secondary}
            disabled={busy}
            onClick={() => void cancel()}
          >
            Cancel operation
          </button>
        )}
        {terminal && onDone && (
          <button type="button" className={ui.primary} onClick={onDone}>
            Done
          </button>
        )}
      </div>
    </section>
  );
}
