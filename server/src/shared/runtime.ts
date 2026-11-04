import type { Connection } from 'mongoose';
import type { Deployment } from '@kanso/schema';
import { CoordinatorClient } from '@kanso/sdk';
import { AuthService } from '@server/features/auth/auth.service';
import { CatalogService } from '@server/features/catalog/catalog.service';
import { RequestService } from '@server/features/request/request.service';
import { OfferService } from '@server/features/offer/offer.service';
import { RiskService } from '@server/features/risk/risk.service';
import { RemoteService } from '@server/features/collateral/collateral.service';
import { SolverService } from '@server/features/solver/solver.service';
import { RepaymentService } from '@server/features/repayment/repayment.service';
import { OperationRepo } from '@server/features/operation/operation.repo';
import { OperationPlanner } from '@server/features/operation/operation.planner';
import { OperationService } from '@server/features/operation/operation.service';
import { NearSigner } from '@server/shared/near/coordinator.client';
import { Indexer } from '@server/shared/indexing/indexer';
import { RemoteActionRepo } from '@server/features/operation/remote-action.repo';
import { RpcProvider } from '@server/shared/near/rpc.provider';
import type { RpcSettings } from '@server/shared/near/rpc.provider';
export interface RuntimeOptions {
  db: Connection;
  deployment: Deployment;
  auth_domain: string;
  relayer?: { account_id: string; private_key: string };
  solver?: {
    account_id: string;
    private_key: string;
    recipients?: Record<string, string>;
    fee_bps?: number;
  };
  mpc_deposit_atomic?: string;
  rpc?: RpcSettings;
}
export async function create_runtime(o: RuntimeOptions) {
  const rpc = new RpcProvider(o.rpc);
  await rpc.verify(o.deployment);
  const coordinator = new CoordinatorClient(o.deployment);
  await coordinator.verify_deployment();
  const effects = new RemoteActionRepo(o.db);
  const relayer = o.relayer
    ? await NearSigner.create(
        o.deployment,
        o.relayer.account_id,
        o.relayer.private_key,
        effects,
      )
    : undefined;
  const solverSigner = o.solver
    ? await NearSigner.create(
        o.deployment,
        o.solver.account_id,
        o.solver.private_key,
        effects,
      )
    : undefined;
  const auth = new AuthService(o.db, o.deployment, o.auth_domain),
    catalog = new CatalogService(o.deployment, coordinator, o.db, {
      relayer: !!relayer,
      solver: !!solverSigner,
      recipients: o.solver?.recipients ?? {},
    }),
    risk = new RiskService(o.deployment, coordinator),
    requests = new RequestService(o.db, o.deployment, auth, catalog),
    offers = new OfferService(requests, catalog, risk),
    remote = new RemoteService(
      o.deployment,
      coordinator,
      relayer,
      o.mpc_deposit_atomic ?? '1',
      o.db,
      rpc,
    ),
    solver = new SolverService(
      o.deployment,
      coordinator,
      solverSigner,
      risk,
      o.solver?.recipients,
      o.solver?.fee_bps,
    ),
    repo = new OperationRepo(o.db),
    planner = new OperationPlanner(o.deployment, coordinator, remote, solver),
    operations = new OperationService(
      repo,
      planner,
      o.deployment,
      coordinator,
      requests,
    ),
    repayment = new RepaymentService(coordinator, solver, operations, catalog);
  await Promise.all([
    auth.initialize(),
    requests.initialize(),
    repo.initialize(),
    effects.model.init(),
  ]);
  const indexer = new Indexer(o.db, { options: o, coordinator, repo });
  await indexer.initialize();
  return {
    indexer,
    options: o,
    coordinator,
    relayer,
    auth,
    catalog,
    risk,
    requests,
    offers,
    remote,
    solver,
    repo,
    operations,
    repayment,
  };
}
export type Runtime = Awaited<ReturnType<typeof create_runtime>>;
