import { KansoError } from '@kanso/schema';
import type { Deployment, TransactionAction, ChainFamily } from '@kanso/schema';
import { canonical_account } from '@sdk/basket/basket';
import { configured_chain } from '@kanso/bindings';
import type { AnyWallet, WalletResolver } from '@sdk/types/wallet.types';
import { assert_near_transaction } from '@sdk/adapters/near/near.transaction';
export class Wallets {
  constructor(
    private readonly d: Deployment,
    private readonly resolve: WalletResolver | undefined,
  ) {}
  async get(
    family: ChainFamily,
    chain_id: string,
    address?: string,
  ): Promise<AnyWallet> {
    const w = await this.resolve?.({
      family,
      chain_id,
      ...(address ? { address } : {}),
    });
    if (!w || w.family !== family)
      throw new KansoError('WALLET_REQUIRED', `Connect a ${family} wallet`);
    const accounts = await w.accounts();
    if (
      !accounts.some(
        (a) =>
          a.chain_id === chain_id &&
          (!address ||
            canonical_account(family, a.address) ===
              canonical_account(family, address)),
      )
    )
      throw new KansoError(
        'WALLET_REQUIRED',
        'The committed account is unavailable',
      );
    return w;
  }
  async prepare(
    action: TransactionAction,
  ): Promise<() => Promise<{ transaction_id: string }>> {
    const w = await this.get(action.family, action.chain_id, action.signer_id);
    const network = await w.network(action.chain_id);
    const expected =
      action.family === 'near'
        ? this.d.network
        : configured_chain(this.d, action.chain_id).manifest
            .network_fingerprint;
    if (network !== expected)
      throw new KansoError(
        'NETWORK_MISMATCH',
        `Switch ${action.chain_id} to its committed network`,
      );
    if (action.family === 'near') assert_near_transaction(this.d, action);
    return async () => {
      let result: { transaction_id: string } | undefined;
      switch (w.family) {
        case 'near':
          if (action.family === 'near')
            result = await w.send_transaction(action);
          break;
        case 'evm':
          if (action.family === 'evm')
            result = await w.send_transaction(action);
          break;
        case 'solana':
          if (action.family === 'solana')
            result = await w.send_transaction(action);
          break;
        case 'sui':
          if (action.family === 'sui')
            result = await w.send_transaction(action);
          break;
        case 'starknet':
          if (action.family === 'starknet')
            result = await w.send_transaction(action);
          break;
        case 'bitcoin':
          if (action.family === 'bitcoin')
            result = await w.send_transaction(action);
          break;
      }
      if (!result)
        throw new KansoError('WALLET_REQUIRED', 'Wallet family mismatch');
      if (!result.transaction_id)
        throw new KansoError(
          'BROADCAST_UNKNOWN',
          'Wallet did not return a transaction ID',
          true,
        );
      return result;
    };
  }
  async send(action: TransactionAction): Promise<{ transaction_id: string }> {
    return (await this.prepare(action))();
  }
}
