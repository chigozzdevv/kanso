import { Schema } from 'mongoose';
import type { Connection, Model } from 'mongoose';
export interface BroadcastDocument {
  _id: string;
  chain_id: string;
  transaction_id: string;
  transaction: number[];
  signature: number[];
}
export function broadcast_model(c: Connection): Model<BroadcastDocument> {
  const schema = new Schema<BroadcastDocument>(
    {
      _id: String,
      chain_id: String,
      transaction_id: String,
      transaction: [Number],
      signature: [Number],
    },
    { versionKey: false, strict: 'throw' },
  );
  return (
    (c.models.Broadcast as Model<BroadcastDocument>) ??
    c.model('Broadcast', schema)
  );
}
