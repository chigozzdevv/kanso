import { Schema } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import { KansoError } from '@kanso/schema';
export interface EffectDocument {
  _id: string;
  intent_hash: string;
  signer_id: string;
  transaction_id: string;
  raw_transaction: string;
  nonce: string;
  state: 'prepared' | 'confirmed' | 'failed';
  result: unknown;
}
const schema = new Schema<EffectDocument>(
  {
    _id: String,
    intent_hash: String,
    signer_id: String,
    transaction_id: String,
    raw_transaction: String,
    nonce: String,
    state: String,
    result: Schema.Types.Mixed,
  },
  { versionKey: false, strict: 'throw' },
);
schema.index({ signer_id: 1, state: 1 });
const leaseSchema = new Schema(
  { _id: String, owner: String, until: Date },
  { versionKey: false },
);
export class RemoteActionRepo {
  readonly model: Model<EffectDocument>;
  readonly leases;
  constructor(c: Connection) {
    this.model =
      (c.models.Effect as Model<EffectDocument>) ?? c.model('Effect', schema);
    this.leases = c.models.SignerLease ?? c.model('SignerLease', leaseSchema);
  }
  async lease(signer: string, owner: string) {
    try {
      await this.leases.updateOne(
        { _id: signer, until: { $lt: new Date() } },
        { $set: { owner, until: new Date(Date.now() + 60000) } },
        { upsert: true },
      );
      return true;
    } catch (e) {
      if (
        typeof e === 'object' &&
        e !== null &&
        'code' in e &&
        e.code === 11000
      )
        return false;
      throw e;
    }
  }
  async release(signer: string, owner: string) {
    await this.leases.updateOne(
      { _id: signer, owner },
      { $set: { until: new Date(0) } },
    );
  }
  async get(id: string, intent: string) {
    const row = await this.model.findById(id).lean();
    if (row && row.intent_hash !== intent)
      throw new KansoError(
        'IDEMPOTENCY_CONFLICT',
        'Effect identity belongs to another transaction intent',
      );
    return row;
  }
}
