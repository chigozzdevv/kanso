import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { KansoError } from '@kanso/schema';
import type {
  ChainConfiguration,
  BasketLeg,
  TransactionAction,
} from '@kanso/schema';
import { digest, to_hex } from '@sdk/transport/codec';
export async function sui_deposit(
  c: ChainConfiguration,
  leg: BasketLeg,
  agreement: number[],
  purpose: number,
): Promise<TransactionAction> {
  if (leg.custody.family !== 'remote')
    throw new Error('Remote custody required');
  const rpc = new SuiGrpcClient({ baseUrl: c.rpc_url, network: 'testnet' });
  if (
    (await rpc.core.getChainIdentifier()).chainIdentifier !==
    c.manifest.network_fingerprint
  )
    throw new KansoError('NETWORK_MISMATCH', 'Sui RPC network mismatch');
  const addr = (b: Uint8Array | number[]) => '0x' + to_hex(b);
  const tx = new Transaction();
  tx.setSender(addr(leg.custody.source_owner));
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(leg.amount_atomic)]);
  tx.moveCall({
    target: `${addr(c.manifest.vault.slice(0, 32))}::collateral_vault::deposit`,
    arguments: [
      tx.object(addr(c.manifest.vault.slice(32))),
      tx.pure.address(addr(leg.custody.lock_id)),
      tx.pure.address(addr(agreement)),
      tx.pure.address(addr(digest(leg.owner))),
      tx.pure.address(addr(digest(leg.leg_id))),
      tx.pure.address(addr(leg.custody.release_recipient)),
      tx.pure.u8(purpose),
      coin,
    ],
  });
  return {
    family: 'sui',
    chain_id: 'sui',
    signer_id: addr(leg.custody.source_owner),
    transaction: await tx.toJSON(),
  };
}
