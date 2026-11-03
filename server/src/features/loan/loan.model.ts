import { Schema } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import type { Loan, LoanSummary, Pool } from '@kanso/schema';
export interface LoanProjection {
  _id: string;
  deployment_id: string;
  loan_id: string;
  borrower: string;
  record: Loan;
  summary: LoanSummary;
}
export interface PoolProjection {
  _id: string;
  deployment_id: string;
  pool_id: string;
  record: Pool;
}
export function projection_models(c: Connection) {
  const loan = new Schema<LoanProjection>(
    {
      _id: String,
      deployment_id: String,
      loan_id: String,
      borrower: String,
      record: Schema.Types.Mixed,
      summary: Schema.Types.Mixed,
    },
    { versionKey: false },
  );
  loan.index({ deployment_id: 1, borrower: 1 });
  const pool = new Schema<PoolProjection>(
    {
      _id: String,
      deployment_id: String,
      pool_id: String,
      record: Schema.Types.Mixed,
    },
    { versionKey: false },
  );
  pool.index({ deployment_id: 1, pool_id: 1 }, { unique: true });
  return {
    loans:
      (c.models.LoanProjection as Model<LoanProjection>) ??
      c.model('LoanProjection', loan),
    pools:
      (c.models.PoolProjection as Model<PoolProjection>) ??
      c.model('PoolProjection', pool),
  };
}
