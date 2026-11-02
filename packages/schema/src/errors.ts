import { z } from 'zod';
export const error_code = z.enum([
  'INVALID_INPUT',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'WALLET_REQUIRED',
  'NETWORK_MISMATCH',
  'INSUFFICIENT_BALANCE',
  'OFFER_EXPIRED',
  'POOL_CAPACITY_CHANGED',
  'PRICE_STALE',
  'CAPABILITY_DISABLED',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'LOCK_NOT_VERIFIED',
  'HEALTH_TOO_LOW',
  'BUDGET_EXHAUSTED',
  'BROADCAST_UNKNOWN',
  'SETTLEMENT_RECONCILING',
  'RPC_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export const kanso_error = z.strictObject({
  code: error_code,
  message: z.string(),
  retryable: z.boolean(),
  operation_id: z.string().optional(),
  required_action: z
    .enum(['connect_wallet', 'switch_network', 'sign'])
    .optional(),
});
export type ErrorCode = z.infer<typeof error_code>;
export class KansoError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly operation_id?: string,
  ) {
    super(message);
    this.name = 'KansoError';
  }
}
