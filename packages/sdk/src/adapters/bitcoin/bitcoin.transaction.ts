import { address, networks } from 'bitcoinjs-lib';
import type { BasketLeg, Deployment, TransactionAction } from '@kanso/schema';
import { CoordinatorClient } from '@sdk/adapters/near/near.adapter';
import { to_hex } from '@sdk/transport/codec';
export async function bitcoin_deposit(
  d: Deployment,
  loan_id: string,
  leg: BasketLeg,
): Promise<TransactionAction> {
  if (leg.custody.family !== 'remote')
    throw new Error('Remote custody required');
  const script = Uint8Array.from(
    await new CoordinatorClient(d).view('bitcoin_deposit_script', {
      loan_id,
      leg_id: leg.leg_id,
    }),
  );
  const destination = address.fromOutputScript(script, networks.testnet);
  return {
    family: 'bitcoin',
    chain_id: 'bitcoin',
    signer_id: address.fromOutputScript(
      Uint8Array.from(leg.custody.source_owner),
      networks.testnet,
    ),
    address: destination,
    amount_atomic: leg.amount_atomic,
    script: '0x' + to_hex(script),
  };
}
