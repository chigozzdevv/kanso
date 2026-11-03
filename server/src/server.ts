import 'dotenv/config';
import { load_configuration } from '@server/shared/config/env';
import { connect_database } from '@server/shared/database/database.client';
import { create_runtime } from '@server/shared/runtime';
import { build_app } from '@server/app';
const { env, deployment } = await load_configuration();
const db = await connect_database(env.MONGODB_URI);
const runtime = await create_runtime({
  db,
  deployment,
  auth_domain: env.AUTH_DOMAIN,
  rpc: {
    TATUM_API_KEY: env.TATUM_API_KEY,
    BASE_RPC_URL: env.BASE_RPC_URL,
    BITCOIN_RPC_URL: env.BITCOIN_RPC_URL,
  },
  ...(env.RELAYER_ACCOUNT && env.RELAYER_PRIVATE_KEY
    ? {
        relayer: {
          account_id: env.RELAYER_ACCOUNT,
          private_key: env.RELAYER_PRIVATE_KEY,
        },
      }
    : {}),
  ...(env.SOLVER_ACCOUNT && env.SOLVER_PRIVATE_KEY
    ? {
        solver: {
          account_id: env.SOLVER_ACCOUNT,
          private_key: env.SOLVER_PRIVATE_KEY,
          recipients: env.SOLVER_RECIPIENTS,
          fee_bps: env.SOLVER_FEE_BPS,
        },
      }
    : {}),
  mpc_deposit_atomic: env.MPC_DEPOSIT_ATOMIC,
});
const app = await build_app(runtime, { client_origins: env.CLIENT_ORIGINS });
await app.listen({ port: env.PORT, host: env.HOST });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  await db.close();
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
