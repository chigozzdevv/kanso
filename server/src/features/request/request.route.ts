import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { identifier, borrowing_request } from '@kanso/schema';
import type { Runtime } from '@server/shared/runtime';
export function request_routes(app: FastifyInstance, r: Runtime) {
  app.post('/v1/requests', async (request) =>
    r.requests.create(
      await r.auth.authenticate(request.headers.authorization),
      request.body,
    ),
  );
  app.get('/v1/requests/:id', async (request) =>
    r.requests.get(
      await r.auth.authenticate(request.headers.authorization),
      z.object({ id: identifier }).parse(request.params).id,
    ),
  );
  app.get('/v1/requests/:id/offers', async (request) =>
    r.offers.offers(
      await r.auth.authenticate(request.headers.authorization),
      z.object({ id: identifier }).parse(request.params).id,
    ),
  );
  app.post('/v1/baskets/review', async (request) => {
    const owner = await r.auth.authenticate(request.headers.authorization),
      input = borrowing_request.parse(request.body);
    await r.requests.validate(owner, input);
    const prices = await r.risk.prices(input.basket);
    return {
      basket: input.basket,
      prices: Object.fromEntries(
        [...prices].map(([k, v]) => [k, v.toString()]),
      ),
      conditional_repayment: input.conditional_repayment,
    };
  });
  app.post('/v1/offers/:id/accept/prepare', async (request) => {
    const owner = await r.auth.authenticate(request.headers.authorization),
      id = z.object({ id: identifier }).parse(request.params).id,
      key = z
        .strictObject({ idempotency_key: z.string().min(1).max(128) })
        .parse(request.body).idempotency_key;
    const { offer, request: original } = await r.offers.get(owner, id);
    return r.operations.prepare(
      owner,
      {
        kind: 'setup',
        offer,
        conditional_repayment: original.input.conditional_repayment,
      },
      key,
    );
  });
}
