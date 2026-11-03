import { ZodError } from 'zod';
import type { FastifyInstance } from 'fastify';
import { KansoError } from '@kanso/schema';
export function error_handler(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        code: 'INVALID_INPUT',
        message: error.issues
          .map((x) => x.path.join('.') + ': ' + x.message)
          .join('; '),
        retryable: false,
      });
    if (error instanceof KansoError) {
      const statuses: Partial<Record<string, number>> = {
        UNAUTHORIZED: 401,
        FORBIDDEN: 403,
        NOT_FOUND: 404,
        REVISION_CONFLICT: 409,
        IDEMPOTENCY_CONFLICT: 409,
        RPC_UNAVAILABLE: 503,
      };
      const status = statuses[error.code] ?? 400;
      return reply.code(status).send({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.operation_id ? { operation_id: error.operation_id } : {}),
      });
    }
    if (
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply.code(error.statusCode).send({
        code: 'INVALID_INPUT',
        message: error instanceof Error ? error.message : 'Invalid request',
        retryable: error.statusCode === 429,
      });
    request.log.error({ err: error }, 'Request failed');
    return reply.code(500).send({
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed',
      retryable: false,
    });
  });
}
