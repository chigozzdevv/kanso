import bs58 from 'bs58';
import { address, networks } from 'bitcoinjs-lib';
import { executable_chain } from '@kanso/bindings';
import type {
  BasketLeg,
  ChainFamily,
  Deployment,
  TransactionAction,
} from '@kanso/schema';
import { coordinator_transaction } from '@sdk/adapters/near/near.transaction';
import { evm_deposit } from '@sdk/adapters/evm/evm.transaction';
import { solana_deposit } from '@sdk/adapters/solana/solana.transaction';
import { sui_deposit } from '@sdk/adapters/sui/sui.transaction';
import { starknet_deposit } from '@sdk/adapters/starknet/starknet.transaction';
import { bitcoin_deposit } from '@sdk/adapters/bitcoin/bitcoin.transaction';
import { to_hex } from '@sdk/transport/codec';
export function source_address(family: ChainFamily, bytes: number[]): string {
  if (family === 'bitcoin')
    return address.fromOutputScript(Uint8Array.from(bytes), networks.testnet);
  return family === 'solana'
    ? bs58.encode(Uint8Array.from(bytes))
    : '0x' + to_hex(bytes);
}
export async function deposit_action(
  d: Deployment,
  loan_id: string,
  leg: BasketLeg,
  agreement: number[],
  purpose = 0,
): Promise<TransactionAction> {
  if (leg.custody.family === 'near')
    return coordinator_transaction(
      d,
      leg.owner,
      'lock_native',
      { loan_id, leg_id: leg.leg_id },
      leg.amount_atomic,
    );
  const m = executable_chain(d, leg.custody.chain_id);
  if (m.manifest.version !== leg.custody.manifest_version)
    throw new Error(
      'Collateral manifest changed; reconcile or abort the existing setup',
    );
  switch (m.manifest.family) {
    case 'evm':
      return evm_deposit(m, leg, agreement, purpose);
    case 'solana':
      return solana_deposit(m, leg, agreement, purpose);
    case 'sui':
      return sui_deposit(m, leg, agreement, purpose);
    case 'starknet':
      return starknet_deposit(m, leg, agreement, purpose);
    case 'bitcoin':
      return bitcoin_deposit(d, loan_id, leg);
  }
}
