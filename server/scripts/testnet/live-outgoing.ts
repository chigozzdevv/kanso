import bs58 from 'bs58';
import { transactions } from 'near-api-js';
import { keccak256 } from 'viem';
import { Transaction as SolanaTransaction } from '@solana/web3.js';
import { Transaction as SuiTransaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction as BitcoinTransaction } from 'bitcoinjs-lib';
import type {
  BitcoinSpend,
  ChainConfiguration,
  RemoteOperation,
} from '@kanso/schema';
import { KansoError } from '@kanso/schema';
import { transaction_context } from '@server/shared/near/chain-signatures.client';
import { BitcoinLightClient } from '@server/shared/near/bitcoin-light-client';
import { RpcProvider } from '@server/shared/near/rpc.provider';
import { ReadMpcClient } from '@server/shared/near/read-mpc.client';
import { digest } from '@testnet/deployment';
import type { Release } from '@testnet/deployment';
import { near_send, near_signer, near_view, call } from '@testnet/deploy-near';
import { live_plan } from '@testnet/live-setup';
import { attest_live, submit_bitcoin_proof } from '@testnet/live-loans';
import { rpc } from '@testnet/network';

export async function execute_outgoing(
  release: Release,
  c: ChainConfiguration,
  operation_id: string,
  role: 'borrower' | 'solver',
) {
  const { deployment: d } = await live_plan(release);
  const bitcoin = c.manifest.family === 'bitcoin';
  const method = bitcoin ? 'get_bitcoin_spend' : 'get_remote_operation';
  let op = await near_view<RemoteOperation | BitcoinSpend>(
    d.near.coordinator,
    method,
    { operation_id },
  );
  if (op.state === 'delivered') return true;
  const signer = await near_signer(release, role);
  if (op.owner !== signer.accountId)
    throw new Error('Source execution signer does not own this operation');
  const attempts = 'attempts' in op ? op.attempts : op.signing_attempts;
  if (!attempts.some((a) => a.signature)) {
    const attempt_id = 'initial';
    const context_id = `context-${operation_id}`;
    let context = release.journal.contracts[context_id];
    if (!bitcoin && !context) {
      try {
        context = await transaction_context(c, op as RemoteOperation);
      } catch (error) {
        if (!(error instanceof KansoError && error.retryable)) throw error;
        console.log(
          `${operation_id}: source context is pending: ${error.message}`,
        );
        release.journal.contracts[`pending-${operation_id}`] = {
          message: error.message,
          checked_at: new Date().toISOString(),
        };
        await release.save();
        return false;
      }
      release.journal.contracts[context_id] = context;
      await release.save();
    }
    await near_send(
      release,
      `sign-${operation_id}`,
      signer,
      d.near.coordinator,
      [
        transactions.functionCall(
          bitcoin ? 'request_bitcoin_signature' : 'request_remote_signature',
          {
            operation_id,
            attempt_id,
            ...(bitcoin
              ? {
                  fee_atomic: (op as BitcoinSpend).max_fee_atomic,
                  cancellation: false,
                }
              : { context, invalidation: false }),
          },
          300_000_000_000_000n,
          1n,
        ),
      ],
    );
    op = await near_view(d.near.coordinator, method, { operation_id });
  }
  const signed = ('attempts' in op ? op.attempts : op.signing_attempts).find(
    (a) =>
      a.signature && !('cancellation' in a ? a.cancellation : a.invalidation),
  );
  if (!signed)
    throw new Error(`MPC signature has not reconciled: ${operation_id}`);
  const packet = bitcoin
    ? {
        transaction: await near_view<number[]>(
          d.near.coordinator,
          'signed_bitcoin_transaction',
          { operation_id, attempt_id: signed.attempt_id },
        ),
        signature: [],
      }
    : await near_view<{ transaction: number[]; signature: number[] }>(
        d.near.coordinator,
        'remote_broadcast_transaction',
        { operation_id, attempt_id: signed.attempt_id },
      );
  const raw = Buffer.from(packet.transaction),
    hex = raw.toString('hex');
  let transaction_id: string;
  if (bitcoin) transaction_id = BitcoinTransaction.fromBuffer(raw).getId();
  else if (c.manifest.family === 'evm') transaction_id = keccak256(`0x${hex}`);
  else if (c.manifest.family === 'solana')
    transaction_id = bs58.encode(SolanaTransaction.from(raw).signature!);
  else if (c.manifest.family === 'sui')
    transaction_id = await SuiTransaction.from(raw).getDigest();
  else
    transaction_id =
      '0x' +
      Buffer.from(
        'payload' in signed ? signed.payload : signed.digest,
      ).toString('hex');
  const id = `outgoing-${operation_id}`;
  const intent = digest(JSON.stringify(packet));
  let effect = release.journal.effects[id];
  if (effect && effect.intent !== intent)
    throw new Error('Signed source packet changed');
  if (!effect) {
    effect = {
      intent,
      transaction_id,
      raw_transaction: raw.toString('base64'),
      state: 'prepared',
      request: { signature: packet.signature, operation_id },
    };
    release.journal.effects[id] = effect;
    await release.save();
  }
  try {
    if (bitcoin)
      await new RpcProvider(process.env)
        .client(c)
        .call('sendrawtransaction', [hex]);
    else if (c.manifest.family === 'evm')
      await rpc(c.rpc_url, 'eth_sendRawTransaction', ['0x' + hex]);
    else if (c.manifest.family === 'solana')
      await rpc(c.rpc_url, 'sendTransaction', [
        raw.toString('base64'),
        { encoding: 'base64', skipPreflight: false },
      ]);
    else if (c.manifest.family === 'sui')
      await new SuiGrpcClient({
        network: 'testnet',
        baseUrl: c.rpc_url,
      }).executeTransaction({
        transaction: raw,
        signatures: [Buffer.from(packet.signature).toString('base64')],
      });
    else
      await rpc(c.rpc_url, 'starknet_addInvokeTransaction', {
        invoke_transaction: JSON.parse(raw.toString()),
      });
    console.log(`broadcast ${operation_id}: ${transaction_id}`);
  } catch (error) {
    effect.result = {
      broadcast_error: error instanceof Error ? error.message : String(error),
      checked_at: new Date().toISOString(),
    };
    await release.save();
    console.log(
      `Reconciling ${operation_id}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
    );
  }
  const providers = new RpcProvider(process.env);
  const reader = new ReadMpcClient(d, undefined, '1', providers);
  let observation;
  try {
    const historical = { ...c, manifest: op.manifest };
    observation = bitcoin
      ? await new BitcoinLightClient(d, providers).observe(
          historical,
          transaction_id,
        )
      : await reader.observe(
          historical,
          transaction_id,
          'CommandExecuted',
          'command' in op ? op.command.operation_id : undefined,
        );
  } catch (error) {
    console.log(
      `${operation_id}: source finality pending: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  let proof;
  try {
    proof =
      'proof' in observation
        ? observation.proof
        : await attest_live(release, c, observation);
  } catch (error) {
    if (!(
      error instanceof Error && error.message.includes('Request has timed out.')
    ))
      throw error;
    release.journal.contracts[`pending-${operation_id}`] = {
      message: error.message,
      checked_at: new Date().toISOString(),
    };
    await release.save();
    console.log(
      `${operation_id}: MPC read timed out; original source transaction retained for reconciliation`,
    );
    return false;
  }
  const delivery_args = {
    operation_id,
    proof,
    ...('proof' in observation
      ? { raw_transaction: observation.raw_transaction }
      : {}),
  };
  if (bitcoin)
    await submit_bitcoin_proof(
      release,
      `deliver-${operation_id}`,
      'submit_bitcoin_delivery',
      delivery_args,
    );
  else
    await near_send(
      release,
      `deliver-${operation_id}`,
      await near_signer(release, 'relayer'),
      d.near.coordinator,
      [call('submit_remote_delivery', delivery_args)],
    );
  effect.state = 'confirmed';
  effect.result = {
    ...(effect.result as Record<string, unknown> | undefined),
    accepted_proof: proof,
    verified_at: new Date().toISOString(),
  };
  await release.save();
  return true;
}
