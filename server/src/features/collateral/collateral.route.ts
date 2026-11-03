import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  identifier,
  positive_amount,
  basket_leg,
  revision,
  KansoError,
} from '@kanso/schema';
import type { Runtime } from '@server/shared/runtime';
export function collateral_routes(app: FastifyInstance, r: Runtime) {
  app.post('/v1/loans/:id/collateral/withdraw/review', async (request) => {
    const owner = await r.auth.authenticate(request.headers.authorization),
      loan_id = z.object({ id: identifier }).parse(request.params).id,
      input = z
        .strictObject({
          leg_id: identifier,
          amount_atomic: positive_amount,
          expected_revision: revision,
        })
        .parse(request.body);
    const loan = await r.coordinator.view('get_loan', { loan_id });
    if (loan.offer.borrower !== owner)
      throw new KansoError('FORBIDDEN', 'Borrower required');
    if (loan.revision !== input.expected_revision)
      throw new KansoError('REVISION_CONFLICT', 'Basket changed');
    return {
      plan: { kind: 'withdraw', loan_id, ...input },
      risk: await r.coordinator.view('basket_risk', { loan_id }),
    };
  });
  app.post('/v1/loans/:id/collateral/replace/review', async (request) => {
    const owner = await r.auth.authenticate(request.headers.authorization),
      loan_id = z.object({ id: identifier }).parse(request.params).id,
      input = z
        .strictObject({
          incoming: basket_leg,
          outgoing_leg_id: identifier,
          outgoing_amount_atomic: positive_amount,
        })
        .parse(request.body);
    const loan = await r.coordinator.view('get_loan', { loan_id });
    if (loan.offer.borrower !== owner)
      throw new KansoError('FORBIDDEN', 'Borrower required');
    return {
      plan: {
        kind: 'replacement',
        loan_id,
        ...input,
        expected_revision: loan.revision,
      },
      risk: await r.coordinator.view('basket_risk', { loan_id }),
    };
  });
}
