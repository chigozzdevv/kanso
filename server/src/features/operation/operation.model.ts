import { Schema } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import type { OperationSnapshot } from '@kanso/schema';
export interface OperationDocument {
  _id: string;
  deployment_id: string;
  owner: string;
  idempotency_key: string;
  plan_hash: string;
  revision: number;
  snapshot: OperationSnapshot;
  lease_owner: string | null;
  lease_until: Date;
  next_run_at: Date;
}
const schema = new Schema<OperationDocument>(
  {
    _id: { type: String, required: true },
    deployment_id: { type: String, required: true },
    owner: { type: String, required: true },
    idempotency_key: { type: String, required: true },
    plan_hash: { type: String, required: true },
    revision: { type: Number, required: true },
    snapshot: { type: Schema.Types.Mixed, required: true },
    lease_owner: { type: String, default: null },
    lease_until: { type: Date, required: true },
    next_run_at: { type: Date, required: true },
  },
  { versionKey: false, strict: 'throw' },
);
schema.index(
  { deployment_id: 1, owner: 1, idempotency_key: 1 },
  { unique: true },
);
schema.index({ 'snapshot.status': 1, next_run_at: 1, lease_until: 1 });
export function operation_model(c: Connection): Model<OperationDocument> {
  return (
    (c.models.Operation as Model<OperationDocument>) ??
    c.model('Operation', schema)
  );
}
