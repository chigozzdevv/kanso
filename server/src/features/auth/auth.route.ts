import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { chain_family, ownership_proof } from '@kanso/schema';
import type { AuthService } from '@server/features/auth/auth.service';
export function auth_routes(app: FastifyInstance, auth: AuthService) {
  app.post('/v1/auth/challenge', async (request) => {
    const input = z
      .strictObject({
        family: chain_family,
        chain_id: z.string(),
        address: z.string().min(1).max(256),
        purpose: z.enum(['login', 'link_wallet']),
      })
      .parse(request.body);
    const owner =
      input.purpose === 'link_wallet'
        ? await auth.authenticate(request.headers.authorization)
        : undefined;
    return auth.challenge(input, owner);
  });
  app.post('/v1/auth/verify', async (request) =>
    auth.verify(ownership_proof.parse(request.body)),
  );
  app.post('/v1/accounts/link', async (request) =>
    auth.verify(
      ownership_proof.parse(request.body),
      await auth.authenticate(request.headers.authorization),
    ),
  );
}
