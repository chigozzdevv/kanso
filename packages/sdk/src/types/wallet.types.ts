import type {
  AuthChallenge,
  OwnershipProof,
  TransactionAction,
  ChainFamily,
} from '@kanso/schema';
export interface WalletAccount {
  address: string;
  chain_id: string;
}
export interface WalletPort<F extends ChainFamily = ChainFamily> {
  readonly family: F;
  accounts(): Promise<WalletAccount[]>;
  network(chain_id: string): Promise<string>;
  prove_ownership(
    challenge: AuthChallenge,
  ): Promise<Omit<OwnershipProof, 'challenge_id'>>;
  send_transaction(
    action: Extract<TransactionAction, { family: F }>,
  ): Promise<{ transaction_id: string }>;
}
export type AnyWallet = { [F in ChainFamily]: WalletPort<F> }[ChainFamily];
export type WalletResolver = (request: {
  family: ChainFamily;
  chain_id: string;
  address?: string;
}) => Promise<AnyWallet | undefined>;
