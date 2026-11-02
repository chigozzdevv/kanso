import { createPublicClient, http, encodeFunctionData } from 'viem';
import type { Address, Hex } from 'viem';
import { evm_vault_abi } from '@kanso/bindings';
import { KansoError } from '@kanso/schema';
import type {
  ChainConfiguration,
  BasketLeg,
  TransactionAction,
} from '@kanso/schema';
import { digest, to_hex } from '@sdk/transport/codec';
export async function evm_deposit(
  c: ChainConfiguration,
  leg: BasketLeg,
  agreement: number[],
  purpose: number,
): Promise<TransactionAction> {
  if (leg.custody.family !== 'remote')
    throw new Error('Remote custody required');
  const m = c.manifest;
  const rpc = createPublicClient({ transport: http(c.rpc_url) });
  if (String(await rpc.getChainId()) !== m.network_fingerprint)
    throw new KansoError('NETWORK_MISMATCH', 'EVM RPC network mismatch');
  const address = (b: number[]) => ('0x' + to_hex(b)) as Address;
  const hash = (b: Uint8Array | number[]) => ('0x' + to_hex(b)) as Hex;
  const data = encodeFunctionData({
    abi: evm_vault_abi,
    functionName: 'depositNative',
    args: [
      {
        lockId: hash(leg.custody.lock_id),
        agreement: hash(agreement),
        borrower: hash(digest(leg.owner)),
        legId: hash(digest(leg.leg_id)),
        refundRecipient: address(leg.custody.release_recipient),
        purpose,
      },
    ],
  });
  return {
    family: 'evm',
    chain_id: m.chain_id,
    signer_id: address(leg.custody.source_owner),
    to: address(m.vault),
    data,
    value: leg.amount_atomic,
  };
}
