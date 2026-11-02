import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@sdk': fileURLToPath(new URL('./packages/sdk/src', import.meta.url)),
      '@kanso/sdk': fileURLToPath(
        new URL('./packages/sdk/src/index.ts', import.meta.url),
      ),
      '@bindings': fileURLToPath(
        new URL('./packages/bindings/src', import.meta.url),
      ),
      '@kanso/bindings': fileURLToPath(
        new URL('./packages/bindings/src/index.ts', import.meta.url),
      ),
      '@test': fileURLToPath(new URL('./test', import.meta.url)),
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
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
    ],
  },
});
