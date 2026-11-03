import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  identifier,
  positive_amount,
  atomic_amount,
  operation_plan,
  conditional_terms,
} from '@kanso/schema';
import type { Runtime } from '@server/shared/runtime';
const review = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('direct'), amount_atomic: positive_amount }),
  z.strictObject({
    mode: z.literal('collateral'),
    leg_id: identifier,
    input_atomic: positive_amount,
    max_execution_cost_atomic: atomic_amount,
  }),
  z.strictObject({
    mode: z.literal('wallet'),
    leg_id: identifier,
    input_atomic: positive_amount,
    max_execution_cost_atomic: atomic_amount,
  }),
]);
export function repayment_routes(app: FastifyInstance, r: Runtime) {
  const id = (p: unknown) => z.object({ id: identifier }).parse(p).id;
  for (const method of ['review', 'quote'])
    app.post(`/v1/loans/:id/repayment/${method}`, async (request) =>
      r.repayment.review(
        await r.auth.authenticate(request.headers.authorization),
        id(request.params),
        review.parse(request.body),
      ),
    );
  app.post('/v1/loans/:id/repayment/prepare', async (request) => {
    const body = z
      .strictObject({
        review: z.strictObject({
          plan: operation_plan,
          plan_hash: z.string(),
          expires_at: z.number().int().optional(),
        }),
        idempotency_key: z.string(),
        plan: operation_plan.optional(),
      })
      .parse(request.body);
    return r.repayment.prepare(
      await r.auth.authenticate(request.headers.authorization),
      id(request.params),
      body,
    );
  });
  app.get('/v1/loans/:id/conditional-repayment', async (request) =>
    r.coordinator.view('get_conditional_repayment', {
      loan_id: id(request.params),
    }),
  );
  app.post('/v1/loans/:id/conditional-repayment/review', async (request) => {
    const owner = await r.auth.authenticate(request.headers.authorization),
      loan_id = id(request.params),
      terms = z
        .strictObject({ terms: conditional_terms })
        .parse(request.body).terms;
    const loan = await r.coordinator.view('get_loan', { loan_id });
    if (loan.offer.borrower !== owner) throw new Error('Borrower required');
    const current = await r.coordinator.view('get_conditional_repayment', {
      loan_id,
    });
    return {
      terms,
      expected_version: current?.version ?? 0,
      consumed: current,
    };
  });
}
