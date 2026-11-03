import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { operation_plan, identifier, revision } from '@kanso/schema';
import type { Runtime } from '@server/shared/runtime';
export function operation_routes(app: FastifyInstance, r: Runtime) {
  const params = z.object({ id: identifier });
  const step_params = params.extend({ step_id: identifier });
  const owner = (authorization: string | undefined) =>
    r.auth.authenticate(authorization);
  app.post('/v1/operations/prepare', async (request) => {
    const input = z
      .strictObject({
        plan: operation_plan,
        idempotency_key: z.string().min(1).max(128),
      })
      .parse(request.body);
    return r.operations.prepare(
      await owner(request.headers.authorization),
      input.plan,
      input.idempotency_key,
    );
  });
  app.get('/v1/operations/:id', async (request) =>
    r.operations.owned(
      await owner(request.headers.authorization),
      params.parse(request.params).id,
    ),
  );
  app.post('/v1/operations/:id/resume', async (request) => {
    const id = params.parse(request.params).id;
    await r.operations.owned(await owner(request.headers.authorization), id);
    return r.operations.reconcile(id);
  });
  app.get('/v1/operations/:id/events', async (request) => {
    const id = params.parse(request.params).id;
    await r.operations.owned(await owner(request.headers.authorization), id);
    const q = z.object({ cursor: z.string().optional() }).parse(request.query);
    return r.repo.events(id, q.cursor);
  });
  app.post('/v1/operations/:id/cancel', async (request) =>
    r.operations.cancel(
      await owner(request.headers.authorization),
      params.parse(request.params).id,
    ),
  );
  app.post('/v1/operations/:id/steps/:step_id/begin', async (request) => {
    const p = step_params.parse(request.params),
      b = z.strictObject({ expected_revision: revision }).parse(request.body);
    return r.operations.begin(
      await owner(request.headers.authorization),
      p.id,
      p.step_id,
      b.expected_revision,
    );
  });
  app.post('/v1/operations/:id/steps/:step_id/submit', async (request) => {
    const p = step_params.parse(request.params),
      b = z
        .strictObject({ transaction_id: z.string().min(1).max(256) })
        .parse(request.body);
    return r.operations.submit(
      await owner(request.headers.authorization),
      p.id,
      p.step_id,
      b.transaction_id,
    );
  });
  app.post('/v1/operations/:id/steps/:step_id/reject', async (request) => {
    const p = step_params.parse(request.params);
    return r.operations.rejected(
      await owner(request.headers.authorization),
      p.id,
      p.step_id,
    );
  });
}
