import { assert_public_change } from '@kanso/bindings';
import { transaction_action } from '@kanso/schema';
import type { Deployment, NearAction } from '@kanso/schema';
export function coordinator_transaction(
  d: Deployment,
  owner: string,
  method: string,
  args: Record<string, unknown>,
  deposit = '1',
): NearAction {
  assert_public_change(method);
  return transaction_action.parse({
    family: 'near',
    chain_id: 'near',
    signer_id: owner,
    receiver_id: d.near.coordinator,
    calls: [{ method, args, deposit, gas: '300000000000000' }],
  }) as NearAction;
}
export function token_transaction(
  d: Deployment,
  owner: string,
  amount: string,
  intent: Record<string, string>,
): NearAction {
  return transaction_action.parse({
    family: 'near',
    chain_id: 'near',
    signer_id: owner,
    receiver_id: d.near.settlement_token,
    calls: [
      {
        method: 'ft_transfer_call',
        args: {
          receiver_id: d.near.coordinator,
          amount,
          msg: JSON.stringify(intent),
        },
        deposit: '1',
        gas: '300000000000000',
      },
    ],
  }) as NearAction;
}
export function assert_near_transaction(d: Deployment, a: NearAction): void {
  for (const c of a.calls) {
    if (a.receiver_id === d.near.coordinator) {
      assert_public_change(c.method);
      if (
        [
          'request_remote_signature',
          'request_bitcoin_signature',
          'request_read_attestation',
        ].includes(c.method)
      ) {
        if (BigInt(c.deposit) > BigInt(d.near.max_mpc_deposit_atomic))
          throw new Error('MPC deposit exceeds deployment limit');
        continue;
      }
      if (
        c.method === 'lock_native' ||
        c.method === 'lock_native_topup' ||
        c.method === 'storage_deposit'
      )
        continue;
      if (c.deposit !== '1' && c.deposit !== '0')
        throw new Error('Unexpected coordinator deposit');
    } else if (a.receiver_id === d.near.settlement_token) {
      if (
        c.method !== 'ft_transfer_call' ||
        c.args.receiver_id !== d.near.coordinator ||
        c.deposit !== '1'
      )
        throw new Error('Invalid settlement-token action');
    } else throw new Error('Unrecognized NEAR receiver');
  }
}
