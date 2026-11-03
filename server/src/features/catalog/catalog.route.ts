import type { FastifyInstance } from 'fastify';
import type { CatalogService } from '@server/features/catalog/catalog.service';
export function catalog_routes(app: FastifyInstance, c: CatalogService) {
  app.get('/v1/catalog/chains', async () => c.chains());
  app.get('/v1/catalog/assets', async () => c.assets());
  app.get('/v1/catalog/capabilities', async () => c.capabilities());
}
