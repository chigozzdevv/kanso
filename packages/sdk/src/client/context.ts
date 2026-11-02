import { operation_snapshot, KansoError } from '@kanso/schema';
import type { OperationPlan } from '@kanso/schema';
import { parse_deployment } from '@kanso/bindings';
import type { KansoConfig } from '@sdk/client/config';
import { CoordinatorClient } from '@sdk/adapters/near/near.adapter';
import { HttpTransport } from '@sdk/transport/http';
import { Wallets } from '@sdk/wallet/resolver';
import { Session } from '@sdk/wallet/session';
import { Operation } from '@sdk/operation/operation';
import { canonical_json } from '@sdk/transport/codec';
export class Context {
  readonly deployment;
  readonly coordinator;
  readonly http;
  readonly wallets;
  readonly session;
  constructor(config: KansoConfig) {
    this.deployment = parse_deployment(config.deployment);
    this.coordinator = new CoordinatorClient(this.deployment, config.fetch);
    this.http = new HttpTransport(config.api_url, config.fetch);
    this.wallets = new Wallets(this.deployment, config.wallets);
    this.session = new Session(
      this.http,
      this.wallets,
      this.deployment.deployment_id,
      config.auth_domain ??
        (config.api_url ? new URL(config.api_url).hostname : undefined),
    );
  }
  operation(snapshot: unknown, expected?: OperationPlan): Operation {
    const s = operation_snapshot.parse(snapshot);
    if (expected && canonical_json(s.plan) !== canonical_json(expected))
      throw new KansoError(
        'IDEMPOTENCY_CONFLICT',
        'Prepared operation differs from the reviewed intent',
      );
    if (
      s.deployment_id !== this.deployment.deployment_id ||
      s.network !== this.deployment.network
    )
      throw new Error('Operation belongs to another deployment');
    return new Operation(s, this.http, this.wallets, this.coordinator);
  }
  async prepare(
    plan: OperationPlan,
    idempotency_key: string,
  ): Promise<Operation> {
    const snapshot = operation_snapshot.parse(
      await this.http.request('POST', '/v1/operations/prepare', {
        plan,
        idempotency_key,
      }),
    );
    if (canonical_json(snapshot.plan) !== canonical_json(plan))
      throw new KansoError(
        'IDEMPOTENCY_CONFLICT',
        'Prepared operation differs from the reviewed intent',
      );
    return this.operation(snapshot);
  }
}
