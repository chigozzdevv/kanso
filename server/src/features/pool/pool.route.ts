import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { identifier, pool_policy } from '@kanso/schema';
import type { Runtime } from '@server/shared/runtime';
export function pool_routes(app: FastifyInstance, r: Runtime) {
  app.get('/v1/pools', async () => r.catalog.pools());
  app.get('/v1/pools/:id', async (request) => {
    const pool_id = z.object({ id: identifier }).parse(request.params).id;
    const [pool, nav, available] = await Promise.all([
      r.coordinator.view('get_pool', { pool_id }),
      r.coordinator.view('pool_nav', { pool_id }),
      r.coordinator.view('pool_available_cash', { pool_id }),
    ]);
    return { pool, nav_atomic: nav, available_cash_atomic: available };
  });
  app.post('/v1/pools/review', async (request) => {
    const input = z
      .strictObject({ pool_id: identifier, policy: pool_policy })
      .parse(request.body);
    return {
      plan: { kind: 'pool_create', ...input },
      manager: await r.auth.authenticate(request.headers.authorization),
    };
  });
  app.get('/v1/pools/:id/activity', async (request) => {
    const pool_id = z.object({ id: identifier }).parse(request.params).id;
    const { cursor } = z
      .object({ cursor: z.string().optional() })
      .parse(request.query);
    return r.indexer.activity(pool_id, cursor);
  });
}
