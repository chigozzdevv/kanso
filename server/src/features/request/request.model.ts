import { Schema } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import type { RequestRecord, Offer } from '@kanso/schema';
export interface RequestDocument {
  _id: string;
  record: RequestRecord;
}
export interface OfferDocument {
  _id: string;
  request_id: string;
  owner: string;
  offer: Offer;
}
export function request_models(c: Connection) {
  const r = new Schema<RequestDocument>(
    { _id: String, record: Schema.Types.Mixed },
    { versionKey: false },
  );
  r.index({ 'record.owner': 1, 'record.created_at': 1 });
  const o = new Schema<OfferDocument>(
    {
      _id: String,
      request_id: String,
      owner: String,
      offer: Schema.Types.Mixed,
    },
    { versionKey: false },
  );
  o.index({ request_id: 1 });
  return {
    requests:
      (c.models.Request as Model<RequestDocument>) ?? c.model('Request', r),
    offers: (c.models.Offer as Model<OfferDocument>) ?? c.model('Offer', o),
  };
}
