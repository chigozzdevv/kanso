import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import type { Runtime } from '@server/shared/runtime';
import { error_handler } from '@server/shared/http/error-handler';
import { auth_routes } from '@server/features/auth/auth.route';
import { catalog_routes } from '@server/features/catalog/catalog.route';
import { operation_routes } from '@server/features/operation/operation.route';
import { request_routes } from '@server/features/request/request.route';
import { loan_routes } from '@server/features/loan/loan.route';
import { pool_routes } from '@server/features/pool/pool.route';
import { repayment_routes } from '@server/features/repayment/repayment.route';
import { collateral_routes } from '@server/features/collateral/collateral.route';
export async function build_app(
  runtime: Runtime,
  options: {
    logger?: boolean;
    rate_limit?: number;
    client_origins?: string[];
  } = {},
) {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 1048576,
    requestTimeout: 30000,
  });
  error_handler(app);
  await app.register(cors, {
    origin: options.client_origins ?? [],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    max: options.rate_limit ?? 120,
    timeWindow: 60000,
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    await runtime.options.db.db!.admin().ping();
    await runtime.coordinator.verify_deployment();
    return {
      status: 'ready',
      deployment_id: runtime.options.deployment.deployment_id,
      solver: !!runtime.solver.signer,
      relayer: !!runtime.relayer,
    };
  });
  auth_routes(app, runtime.auth);
  catalog_routes(app, runtime.catalog);
  operation_routes(app, runtime);
  request_routes(app, runtime);
  loan_routes(app, runtime);
  pool_routes(app, runtime);
  repayment_routes(app, runtime);
  collateral_routes(app, runtime);
  return app;
}
