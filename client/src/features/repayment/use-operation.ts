'use client';

import { useEffect, useState } from 'react';
import { scoped_id } from '@kanso/sdk';
import type { Kanso, Operation } from '@kanso/sdk';
import type { RepaymentCheckpoint } from '@/features/repayment/state';
import { repaymentCheckpoint } from '@/features/repayment/state';

export function useRepaymentOperation(client: Kanso, loanId: string) {
  const key = `kanso:repayment:${client.deployment.deployment_id}:${loanId}`;
  const [saved, setSaved] = useState<RepaymentCheckpoint | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  useEffect(() => {
    setOperation(null);
    try {
      const parsed = repaymentCheckpoint.safeParse(
        JSON.parse(localStorage.getItem(key) ?? 'null'),
      );
      setSaved(parsed.success ? parsed.data : null);
    } catch {
      setSaved(null);
    }
  }, [key]);

  function remember(value: RepaymentCheckpoint | null) {
    setSaved(value);
    try {
      if (value) localStorage.setItem(key, JSON.stringify(value));
      else localStorage.removeItem(key);
    } catch {
      /* The operation also remains recoverable from the API. */
    }
  }
  async function prepare(
    phase: RepaymentCheckpoint['phase'],
    owner: string,
    amount: string | null,
    create: (idempotencyKey: string) => Promise<Operation>,
  ) {
    if (saved)
      throw new Error('Resume your previous payment before starting another.');
    const idempotencyKey = crypto.randomUUID();
    remember({
      operation_id: scoped_id(
        client.deployment.deployment_id,
        owner,
        idempotencyKey,
      ),
      owner,
      phase,
      amount_atomic: amount,
    });
    const result = await create(idempotencyKey);
    setOperation(result);
  }
  async function resume(owner: string) {
    if (!saved) return;
    if (saved.owner !== owner)
      throw new Error('Connect the account that started this payment.');
    try {
      const result = await client.operation(saved.operation_id);
      const snapshot = await result.snapshot();
      const plan = snapshot.plan;
      const valid =
        saved.phase === 'repayment'
          ? (plan.kind === 'repayment' && plan.loan_id === loanId) ||
            (plan.kind === 'settlement' && plan.plan.loan_id === loanId)
          : saved.phase === 'wallet_payment'
            ? plan.kind === 'wallet_payment' && plan.loan_id === loanId
            : plan.kind === 'payment_refund' && plan.loan_id === loanId;
      if (!valid || snapshot.owner !== owner)
        throw new Error('Saved payment does not match this loan and account.');
      setOperation(result);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'NOT_FOUND'
      ) {
        remember(null);
        throw new Error(
          'The payment was not prepared. You can review it again.',
          { cause: error },
        );
      }
      throw error;
    }
  }
  function clear() {
    remember(null);
    setOperation(null);
  }
  return { saved, operation, prepare, resume, clear };
}
