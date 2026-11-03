import { randomUUID } from 'node:crypto';
import type { Connection } from 'mongoose';
import { borrowing_request, request_record, KansoError } from '@kanso/schema';
import type { Deployment, BorrowingRequest } from '@kanso/schema';
import { scoped_id, source_address } from '@kanso/sdk';
import { executable_chain } from '@kanso/bindings';
import type { CatalogService } from '@server/features/catalog/catalog.service';
import type { AuthService } from '@server/features/auth/auth.service';
import { request_models } from '@server/features/request/request.model';
export class RequestService {
  readonly models;
  constructor(
    db: Connection,
    readonly d: Deployment,
    private readonly auth: AuthService,
    private readonly catalog: CatalogService,
  ) {
    this.models = request_models(db);
  }
  async initialize() {
    await Promise.all([this.models.requests.init(), this.models.offers.init()]);
  }
  async validate(owner: string, input: BorrowingRequest) {
    const enabled = input.basket.some((l) => l.custody.family === 'remote')
      ? await this.catalog.assets()
      : [];
    for (const leg of input.basket) {
      if (leg.owner !== owner)
        throw new KansoError(
          'FORBIDDEN',
          'Basket owner differs from authenticated borrower',
        );
      if (leg.custody.family === 'remote') {
        if (!enabled.some((a) => a.asset_id === leg.asset_id && a.enabled))
          throw new KansoError(
            'CAPABILITY_DISABLED',
            'Remote origination is not enabled by the current deployment and server capabilities',
          );
        const c = executable_chain(this.d, leg.custody.chain_id);
        if (
          c.manifest.version !== leg.custody.manifest_version ||
          c.manifest.asset_id !== leg.asset_id
        )
          throw new KansoError(
            'CAPABILITY_DISABLED',
            'Collateral manifest version changed',
          );
        const address = source_address(
          c.manifest.family,
          leg.custody.source_owner,
        );
        if (!(await this.auth.linked(owner, c.manifest.chain_id, address)))
          throw new KansoError(
            'FORBIDDEN',
            'Prove ownership of the source wallet before requesting an offer',
          );
      } else if (leg.asset_id !== 'near')
        throw new KansoError(
          'INVALID_INPUT',
          'Native NEAR custody requires NEAR',
        );
    }
  }
  async create(owner: string, body: unknown) {
    const input = borrowing_request.parse(body);
    await this.validate(owner, input);
    const id = scoped_id(this.d.deployment_id, owner, randomUUID());
    const record = request_record.parse({
      request_id: id,
      owner,
      input,
      created_at: Math.floor(Date.now() / 1000),
    });
    await this.models.requests.create({ _id: id, record });
    return record;
  }
  async get(owner: string, id: string) {
    const row = await this.models.requests.findById(id).lean();
    if (!row) throw new KansoError('NOT_FOUND', 'Request not found');
    if (row.record.owner !== owner)
      throw new KansoError('FORBIDDEN', 'Request belongs to another account');
    return request_record.parse(row.record);
  }
}
