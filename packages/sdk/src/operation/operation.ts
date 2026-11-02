import { operation_snapshot, KansoError } from '@kanso/schema';
import type { OperationSnapshot, OperationCheckpoint } from '@kanso/schema';
import type { HttpTransport } from '@sdk/transport/http';
import type { CoordinatorClient } from '@sdk/adapters/near/near.adapter';
import { assert_action_intent, same_action } from '@sdk/operation/intent';
import type { Wallets } from '@sdk/wallet/resolver';
import { checkpoint } from '@sdk/operation/checkpoint';
import { delay, plan_hash } from '@sdk/transport/codec';
export class Operation {
  private current: OperationSnapshot;
  constructor(
    initial: OperationSnapshot,
    private readonly http: HttpTransport,
    private readonly wallets: Wallets,
    private readonly near: CoordinatorClient,
  ) {
    this.current = operation_snapshot.parse(initial);
    this.validate(this.current);
  }
  private validate(s: OperationSnapshot): void {
    if (s.plan_hash !== plan_hash(s.plan))
      throw new KansoError(
        'INVALID_INPUT',
        'Operation plan hash does not match its contents',
      );
    if (
      this.current &&
      (s.operation_id !== this.current.operation_id ||
        s.owner !== this.current.owner ||
        s.deployment_id !== this.current.deployment_id ||
        s.plan_hash !== this.current.plan_hash)
    )
      throw new KansoError(
        'IDEMPOTENCY_CONFLICT',
        'Operation identity changed',
      );
  }
  get operation_id(): string {
    return this.current.operation_id;
  }
  async snapshot(): Promise<OperationSnapshot> {
    const s = operation_snapshot.parse(
      await this.http.request('GET', `/v1/operations/${this.operation_id}`),
    );
    this.validate(s);
    this.current = s;
    return s;
  }
  checkpoint(): OperationCheckpoint {
    return checkpoint(this.current);
  }
  async execute(
    options: { max_steps?: number } = {},
  ): Promise<OperationSnapshot> {
    for (let count = 0; count < (options.max_steps ?? 64); count++) {
      const state = await this.snapshot();
      if (state.status !== 'requires_action') return state;
      const step = state.steps.find((s) => s.state === 'pending' && s.action);
      if (!step?.action) return state;
      await assert_action_intent(state, step, this.near);
      const submit = await this.wallets.prepare(step.action);
      const begun = operation_snapshot.parse(
        await this.http.request(
          'POST',
          `/v1/operations/${this.operation_id}/steps/${step.step_id}/begin`,
          { expected_revision: state.revision },
        ),
      );
      this.validate(begun);
      if (
        !same_action(
          begun.steps.find((x) => x.step_id === step.step_id)?.action ?? null,
          step.action,
        )
      )
        throw new KansoError(
          'IDEMPOTENCY_CONFLICT',
          'Wallet action changed while committing the step',
        );
      this.current = begun;
      try {
        const result = await submit();
        await this.http.request(
          'POST',
          `/v1/operations/${this.operation_id}/steps/${step.step_id}/submit`,
          result,
        );
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : undefined;
        if (code === 4001 || code === 'USER_REJECTED') {
          await this.http.request(
            'POST',
            `/v1/operations/${this.operation_id}/steps/${step.step_id}/reject`,
            {},
          );
        }
        throw error;
      }
    }
    return this.snapshot();
  }
  async record_transaction(input: {
    step_id: string;
    transaction_id: string;
  }): Promise<OperationSnapshot> {
    const s = operation_snapshot.parse(
      await this.http.request(
        'POST',
        `/v1/operations/${this.operation_id}/steps/${input.step_id}/submit`,
        { transaction_id: input.transaction_id },
      ),
    );
    this.validate(s);
    this.current = s;
    return s;
  }
  async resume(): Promise<OperationSnapshot> {
    const s = operation_snapshot.parse(
      await this.http.request(
        'POST',
        `/v1/operations/${this.operation_id}/resume`,
        {},
      ),
    );
    this.validate(s);
    this.current = s;
    return this.execute();
  }
  async cancel(): Promise<OperationSnapshot> {
    const s = operation_snapshot.parse(
      await this.http.request(
        'POST',
        `/v1/operations/${this.operation_id}/cancel`,
        {},
      ),
    );
    this.validate(s);
    this.current = s;
    return s;
  }
  async wait(
    options: {
      until?: OperationSnapshot['status'];
      timeout_ms?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<OperationSnapshot> {
    const end = Date.now() + (options.timeout_ms ?? 120000);
    for (;;) {
      const s = await this.snapshot();
      if (
        s.status === (options.until ?? 'succeeded') ||
        ['failed', 'cancelled'].includes(s.status) ||
        Date.now() >= end
      )
        return s;
      await delay(
        Math.min(s.next_poll_after_ms, Math.max(0, end - Date.now())),
        options.signal,
      );
    }
  }
  subscribe(
    listener: (snapshot: OperationSnapshot) => void,
    on_error?: (error: unknown) => void,
  ): () => void {
    const controller = new AbortController();
    void (async () => {
      try {
        while (!controller.signal.aborted) {
          const s = await this.snapshot();
          listener(s);
          if (['succeeded', 'failed', 'cancelled'].includes(s.status)) return;
          await delay(s.next_poll_after_ms, controller.signal);
        }
      } catch (error) {
        if (!controller.signal.aborted) on_error?.(error);
      }
    })();
    return () => controller.abort();
  }
}
