import type { NextConfig } from 'next';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

const rootEnvironment = resolve(process.cwd(), '../.env');
if (existsSync(rootEnvironment)) loadEnvFile(rootEnvironment);

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  poweredByHeader: false,
  reactStrictMode: true,
  agentRules: false,
  env: {
    NEXT_PUBLIC_KANSO_API_URL:
      process.env.NEXT_PUBLIC_KANSO_API_URL ?? 'http://127.0.0.1:3001',
    NEXT_PUBLIC_KANSO_AUTH_DOMAIN:
      process.env.NEXT_PUBLIC_KANSO_AUTH_DOMAIN ?? 'localhost',
  },
};

export default config;
