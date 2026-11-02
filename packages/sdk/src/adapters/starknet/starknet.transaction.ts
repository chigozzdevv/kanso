import { RpcProvider } from 'starknet';
import { KansoError } from '@kanso/schema';
import type {
  ChainConfiguration,
  BasketLeg,
  TransactionAction,
} from '@kanso/schema';
import { digest, to_hex } from '@sdk/transport/codec';
export async function starknet_deposit(
  c: ChainConfiguration,
  leg: BasketLeg,
  agreement: number[],
  purpose: number,
): Promise<TransactionAction> {
  if (leg.custody.family !== 'remote')
    throw new Error('Remote custody required');
  const rpc = new RpcProvider({ nodeUrl: c.rpc_url });
  if (BigInt(await rpc.getChainId()) !== BigInt('0x534e5f5345504f4c4941'))
    throw new KansoError('NETWORK_MISMATCH', 'Starknet RPC network mismatch');
  const address = (b: Uint8Array | number[]) => '0x' + to_hex(b);
  const felt = (b: Uint8Array | number[]) => {
    const value = Uint8Array.from(b);
    value[0] = value[0]! & 3;
    return address(value);
  };
  const vault = address(c.manifest.vault),
    amount = BigInt(leg.amount_atomic);
  return {
    family: 'starknet',
    chain_id: 'starknet',
    signer_id: address(leg.custody.source_owner),
    calls: [
      {
        contract_address: address(c.manifest.asset_address),
        entrypoint: 'approve',
        calldata: [
          vault,
          (amount & ((1n << 128n) - 1n)).toString(),
          (amount >> 128n).toString(),
        ],
      },
      {
        contract_address: vault,
        entrypoint: 'deposit',
        calldata: [
          felt(leg.custody.lock_id),
          felt(agreement),
          felt(digest(leg.owner)),
          felt(digest(leg.leg_id)),
          address(leg.custody.release_recipient),
          String(purpose),
          amount.toString(),
        ],
      },
    ],
  };
}
