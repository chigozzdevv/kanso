import { Schema } from 'mongoose';
import type { Connection, Model } from 'mongoose';
export interface OutboxDocument {
  operation_id: string;
  owner: string;
  deployment_id: string;
  revision: number;
  created_at: Date;
  published: boolean;
}
const schema = new Schema<OutboxDocument>(
  {
    operation_id: { type: String, required: true },
    owner: { type: String, required: true },
    deployment_id: { type: String, required: true },
    revision: { type: Number, required: true },
    created_at: { type: Date, required: true },
    published: { type: Boolean, default: false },
  },
  { versionKey: false, strict: 'throw' },
);
schema.index({ operation_id: 1, revision: 1 }, { unique: true });
schema.index({ published: 1, created_at: 1 });
export function outbox_model(c: Connection): Model<OutboxDocument> {
  return (
    (c.models.Outbox as Model<OutboxDocument>) ?? c.model('Outbox', schema)
  );
}
