import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '.keys/**',
      '**/target/**',
      '**/node_modules/**',
      'client/.next/**',
      'client/out/**',
      'client/next-env.d.ts',
      '**/lib/forge-std/**',
      'contracts/evm/out/**',
      'contracts/evm/cache/**',
      'contracts/sui/build/**',
      'contracts/starknet/.snfoundry_cache/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-imports': ['error', { patterns: ['./*', '../*'] }],
    },
  },
);
