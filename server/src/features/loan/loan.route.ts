import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { identifier } from '@kanso/schema';
import type { Runtime } from '@server/shared/runtime';
export function loan_routes(app: FastifyInstance, r: Runtime) {
  app.get('/v1/loans', async (request) => {
    const owner = await r.auth.authenticate(request.headers.authorization);
    const pool_ids = (await r.catalog.pools()).map((pool) => pool.pool_id);
    const rows = await r.indexer.projections.loans
      .find({
        deployment_id: r.options.deployment.deployment_id,
        borrower: owner,
        'record.offer.pool_id': { $in: pool_ids },
      })
      .lean();
    const operations = await r.repo.model
      .find({
        deployment_id: r.options.deployment.deployment_id,
        owner,
        'snapshot.plan.kind': 'setup',
        'snapshot.plan.offer.pool_id': { $in: pool_ids },
      })
      .lean();
    const ids = new Set([
      ...rows.map((x) => x.loan_id),
      ...operations.flatMap((x) =>
        x.snapshot.plan.kind === 'setup'
          ? [x.snapshot.plan.offer.offer_id]
          : [],
      ),
    ]);
    const loans = await Promise.all(
      [...ids].map((loan_id) =>
        r.coordinator.maybe_view('get_loan', { loan_id }),
      ),
    );
    return loans.filter(
      (l) => l?.offer.borrower === owner && pool_ids.includes(l.offer.pool_id),
    );
  });
  app.get('/v1/loans/:id', async (request) =>
    r.coordinator.view('loan_summary', {
      loan_id: z.object({ id: identifier }).parse(request.params).id,
    }),
  );
  app.get('/v1/loans/:id/activity', async (request) => {
    const loan_id = z.object({ id: identifier }).parse(request.params).id;
    const { cursor } = z
      .object({ cursor: z.string().optional() })
      .parse(request.query);
    return r.indexer.activity(loan_id, cursor);
  });
}
