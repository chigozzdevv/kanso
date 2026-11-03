import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@bindings': fileURLToPath(
        new URL('./packages/bindings/src', import.meta.url),
      ),
      '@sdk': fileURLToPath(new URL('./packages/sdk/src', import.meta.url)),
      '@server': fileURLToPath(new URL('./server/src', import.meta.url)),
      '@kanso/bindings': fileURLToPath(
        new URL('./packages/bindings/src/index.ts', import.meta.url),
      ),
      '@kanso/sdk': fileURLToPath(
        new URL('./packages/sdk/src/index.ts', import.meta.url),
      ),
      '@kanso/server': fileURLToPath(
        new URL('./server/src/index.ts', import.meta.url),
      ),
      '@test': fileURLToPath(new URL('./test', import.meta.url)),
      '@testnet': fileURLToPath(
        new URL('./server/scripts/testnet', import.meta.url),
      ),
      '@schema': fileURLToPath(
        new URL('./packages/schema/src', import.meta.url),
      ),
      '@kanso/schema': fileURLToPath(
        new URL('./packages/schema/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 180000,
          hookTimeout: 240000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts', 'server/test/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'sandbox',
          include: ['test/sandbox/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
