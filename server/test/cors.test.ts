import { afterEach, describe, expect, it } from 'vitest';
import { build_app } from '@server/app';
import type { Runtime } from '@server/shared/runtime';

const apps: Awaited<ReturnType<typeof build_app>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('browser API access', () => {
  it('permits authenticated preflight requests only for configured client origins', async () => {
    const app = await build_app({} as Runtime, {
      logger: false,
      client_origins: ['http://127.0.0.1:3054'],
    });
    apps.push(app);
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/challenge',
      headers: {
        origin: 'http://127.0.0.1:3054',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'http://127.0.0.1:3054',
    );
    expect(allowed.headers['access-control-allow-headers']).toBe(
      'Content-Type, Authorization',
    );
    const blocked = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'https://unconfigured.example' },
    });
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
    expect(blocked.json()).toEqual({ status: 'ok' });
  });
  it('does not enable cross-origin access by default', async () => {
    const app = await build_app({} as Runtime, { logger: false });
    apps.push(app);
    const result = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'http://127.0.0.1:3054' },
    });
    expect(result.headers['access-control-allow-origin']).toBeUndefined();
  });
});
