import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { deployment } from '@kanso/schema';
export const environment = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  HOST: z.string().default('127.0.0.1'),
  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.url(),
  DEPLOYMENT_FILE: z.string().min(1),
  AUTH_DOMAIN: z.string().min(1),
  CLIENT_ORIGINS: z
    .string()
    .default(
      'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3054,http://127.0.0.1:3054',
    )
    .transform((value) =>
      value.split(',').map((origin) => z.url().parse(origin.trim())),
    ),
  TATUM_API_KEY: z.string().min(1).optional(),
  BASE_RPC_URL: z.url().optional(),
  BITCOIN_RPC_URL: z.url().optional(),
  RELAYER_ACCOUNT: z.string().optional(),
  RELAYER_PRIVATE_KEY: z.string().optional(),
  SOLVER_ACCOUNT: z.string().optional(),
  SOLVER_PRIVATE_KEY: z.string().optional(),
  SOLVER_RECIPIENTS: z
    .string()
    .default('{}')
    .transform((value) =>
      z
        .record(z.string(), z.string().regex(/^0x(?:[a-f0-9]{2})+$/i))
        .parse(JSON.parse(value)),
    ),
  SOLVER_FEE_BPS: z.coerce.number().int().min(0).max(10000).default(0),
  MPC_DEPOSIT_ATOMIC: z
    .string()
    .regex(/^[0-9]+$/)
    .default('1'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  WORKER_TICK_MS: z.coerce.number().int().min(500).max(60000).default(3000),
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error', 'silent'])
    .default('info'),
});
export type Environment = z.infer<typeof environment>;
export async function load_configuration(
  input: NodeJS.ProcessEnv = process.env,
) {
  const env = environment.parse(input);
  if (
    !!env.RELAYER_ACCOUNT !== !!env.RELAYER_PRIVATE_KEY ||
    !!env.SOLVER_ACCOUNT !== !!env.SOLVER_PRIVATE_KEY
  )
    throw new Error(
      'Configure each signing account together with its private key',
    );
  const d = deployment.parse(
    JSON.parse(await readFile(env.DEPLOYMENT_FILE, 'utf8')),
  );
  if (env.NODE_ENV === 'production' && d.network === 'sandbox')
    throw new Error('Sandbox deployment cannot run in production mode');
  if (BigInt(env.MPC_DEPOSIT_ATOMIC) > BigInt(d.near.max_mpc_deposit_atomic))
    throw new Error('MPC fee exceeds deployment wallet limit');
  return { env, deployment: d };
}
