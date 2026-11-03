import { bitcoin_deposit } from '@kanso/sdk';
import { KansoError, identifier, atomic_amount } from '@kanso/schema';
import type { BitcoinRecovery, ChainManifest, Loan } from '@kanso/schema';
import { BitcoinLightClient } from '@server/shared/near/bitcoin-light-client';
import { RpcProvider } from '@server/shared/near/rpc.provider';
import type { Release } from '@testnet/deployment';
import { near_view, near_send, near_signer, call } from '@testnet/deploy-near';
import { live_plan } from '@testnet/live-setup';
import { send_source } from '@testnet/live-wallets';
import { submit_bitcoin_proof } from '@testnet/live-loans';
import { execute_outgoing } from '@testnet/live-outgoing';

export async function verify_bitcoin_recovery(
  release: Release,
  loan_id = 'live_bitcoin_repay_v1',
  amount = '5000',
) {
  identifier.parse(loan_id);
  atomic_amount.parse(amount);
  const { deployment: d } = await live_plan(release);
  const loan = await near_view<Loan>(d.near.coordinator, 'get_loan', {
    loan_id,
  });
  const leg = loan.locks.find(
    (l) =>
      l.leg.custody.family === 'remote' && l.leg.custody.chain_id === 'bitcoin',
  )?.leg;
  if (!leg || leg.custody.family !== 'remote')
    throw new Error('Bitcoin custody leg required');
  const borrower = await near_signer(release, 'borrower');
  if (borrower.accountId !== leg.owner)
    throw new Error('Recovery test requires the source owner');
  const configured = d.chains.find((c) => c.manifest.chain_id === 'bitcoin');
  if (!configured) throw new Error('Bitcoin deployment is missing');
  const manifest = await near_view<ChainManifest>(
    d.near.coordinator,
    'get_chain_manifest',
    { chain_id: 'bitcoin', version: leg.custody.manifest_version },
  );
  const c = { ...configured, manifest };
  const max_fee = BigInt(manifest.max_network_cost_atomic);
  if (BigInt(amount) < max_fee + 294n)
    throw new Error('Recovery deposit is below the refund and fee limit');
  const recovery_id = identifier.parse(`recovery_${loan_id}`);
  const operation_id = identifier.parse(`refund_${recovery_id}`);
  const deposit_id = `deposit-${recovery_id}`;
  const recovery = await near_view<BitcoinRecovery | null>(
    d.near.coordinator,
    'get_bitcoin_recovery',
    { recovery_id },
  );
  if (recovery?.completed) {
    console.log(`${recovery_id}: Bitcoin refund already confirmed`);
    return;
  }
  const transaction_id = await send_source(
    release,
    deposit_id,
    await bitcoin_deposit(d, loan_id, { ...leg, amount_atomic: amount }),
  );
  if (!recovery) {
    let observation;
    try {
      observation = await new BitcoinLightClient(
        d,
        new RpcProvider(process.env),
      ).observe(c, transaction_id);
    } catch (error) {
      if (
        !(error instanceof KansoError) ||
        ![
          'CAPABILITY_DISABLED',
          'SETTLEMENT_RECONCILING',
          'RPC_UNAVAILABLE',
        ].includes(error.code)
      )
        throw error;
      console.log(
        `${recovery_id}: inclusion verification pending: ${error.message}`,
      );
      return;
    }
    const { Transaction } = await import('bitcoinjs-lib');
    const tx = Transaction.fromBuffer(
      Uint8Array.from(observation.raw_transaction),
    );
    const script = await near_view<number[]>(
      d.near.coordinator,
      'bitcoin_deposit_script',
      { loan_id, leg_id: leg.leg_id },
    );
    const vout = tx.outs.findIndex(
      (o) =>
        o.value === BigInt(amount) &&
        Buffer.from(o.script).equals(Buffer.from(script)),
    );
    if (vout < 0)
      throw new Error('Recovery output is absent from the source transaction');
    await submit_bitcoin_proof(
      release,
      `register-${recovery_id}`,
      'register_bitcoin_recovery',
      { recovery_id, loan_id, leg_id: leg.leg_id, ...observation, vout },
      'borrower',
    );
  }
  await near_send(
    release,
    `prepare-${operation_id}`,
    borrower,
    d.near.coordinator,
    [
      call('prepare_bitcoin_recovery', {
        recovery_id,
        operation_id,
        max_fee_atomic: max_fee.toString(),
      }),
    ],
  );
  if (!(await execute_outgoing(release, c, operation_id, 'borrower'))) return;
  const after = await near_view<Loan>(d.near.coordinator, 'get_loan', {
    loan_id,
  });
  if (
    after.revision !== loan.revision ||
    after.principal_outstanding_atomic !== loan.principal_outstanding_atomic ||
    JSON.stringify(after.locks) !== JSON.stringify(loan.locks)
  )
    throw new Error('Recovery changed loan collateral or principal');
  if (
    !(
      await near_view<BitcoinRecovery>(
        d.near.coordinator,
        'get_bitcoin_recovery',
        { recovery_id },
      )
    ).completed
  )
    throw new Error('Bitcoin recovery did not complete');
  console.log(
    `${recovery_id}: extra output refunded through MPC and SPV; pledged collateral and principal are unchanged`,
  );
}
