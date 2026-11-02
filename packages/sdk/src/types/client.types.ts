import type { ConditionalTerms } from '@kanso/schema';
export interface AssetInput {
  asset_id: string;
  amount_atomic: string;
  source_account?: string;
  refund_account?: string;
}
export interface BorrowInput {
  basket: AssetInput[];
  borrower?: string;
  loan_terms: {
    principal_atomic: string;
    duration_seconds: number;
    payout_account: string;
  };
  conditional_repayment?: ConditionalTerms | { enabled: false };
}
