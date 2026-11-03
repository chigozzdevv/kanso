import bs58 from 'bs58';
import { Transaction as BitcoinTransaction } from 'bitcoinjs-lib';
import { Transaction as SolanaTransaction } from '@solana/web3.js';
import { Transaction as SuiTransaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { keccak256 } from 'viem';
import type { Connection } from 'mongoose';
import { KansoError, mpc_signature } from '@kanso/schema';
import type {
  BasketLeg,
  Loan,
  Deployment,
  TransactionAction,
  RemoteOperation,
} from '@kanso/schema';
import type { CoordinatorClient } from '@kanso/sdk';
import { configured_chain } from '@kanso/bindings';
import {
  to_hex,
  coordinator_transaction,
  scoped_id,
  base64,
  plan_hash,
} from '@kanso/sdk';
import { BitcoinLightClient } from '@server/shared/near/bitcoin-light-client';
import { ReadMpcClient } from '@server/shared/near/read-mpc.client';
import type { NearSigner } from '@server/shared/near/coordinator.client';
import { broadcast_model } from '@server/features/operation/remote-action.model';
import { transaction_context } from '@server/shared/near/chain-signatures.client';
import { RpcProvider } from '@server/shared/near/rpc.provider';
export interface RemoteProgress {
  name: string;
  label: string;
  done: boolean;
  action: TransactionAction | null;
}
export class RemoteService {
  private readonly reads;
  private readonly bitcoin;
  private readonly broadcasts;
  constructor(
    private readonly d: Deployment,
    private readonly near: CoordinatorClient,
    private readonly relayer: NearSigner | undefined,
    private readonly fee: string,
    db: Connection,
    private readonly providers = new RpcProvider(),
  ) {
    this.reads = new ReadMpcClient(d, relayer, fee, providers);
    this.bitcoin = new BitcoinLightClient(d, providers);
    this.broadcasts = broadcast_model(db);
  }
  private async configuration(leg: BasketLeg) {
    if (leg.custody.family !== 'remote')
      throw new Error('Remote custody required');
    const c = configured_chain(this.d, leg.custody.chain_id);
    return {
      ...c,
      manifest: await this.near.view('get_chain_manifest', {
        chain_id: leg.custody.chain_id,
        version: leg.custody.manifest_version,
      }),
    };
  }
  private signer() {
    if (!this.relayer)
      throw new KansoError(
        'CAPABILITY_DISABLED',
        'A funded reconciliation relayer is required',
      );
    return this.relayer;
  }
  async finalize_native(transfer_id: string) {
    if (!this.relayer) return;
    const t = await this.near.view('get_transfer', { transfer_id });
    if (t && !t.finalized && t.outcome !== 'unknown')
      await this.relayer.send(
        coordinator_transaction(
          this.d,
          this.relayer.account.accountId,
          'finalize_transfer',
          { transfer_id },
          '0',
        ),
        scoped_id('finalize-transfer', transfer_id),
      );
  }
  async bitcoin_key_ready(loan_id: string, leg_id: string) {
    try {
      await this.near.view('bitcoin_deposit_script', { loan_id, leg_id });
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('BITCOIN_KEY_NOT_DERIVED')
      )
        return false;
      throw error;
    }
  }
  async accept_lock(loan: Loan, leg: BasketLeg, transaction_id: string) {
    if (leg.custody.family !== 'remote') return;
    const c = await this.configuration(leg);
    const observation =
      c.manifest.family === 'bitcoin'
        ? await this.bitcoin.observe(c, transaction_id)
        : await this.reads.observe(
            c,
            transaction_id,
            'LockAccepted',
            leg.custody.lock_id,
          );
    const proof =
      'proof' in observation
        ? observation.proof
        : await this.reads.attest(c, observation);
    const signer = this.signer();
    let args: Record<string, unknown> = {
      loan_id: loan.loan_id,
      leg_id: leg.leg_id,
      proof,
    };
    let method = 'submit_remote_lock';
    if ('proof' in observation) {
      const bytes = observation.raw_transaction;
      const tx = BitcoinTransaction.fromBuffer(Uint8Array.from(bytes));
      const expected = await this.near.view('bitcoin_deposit_script', {
        loan_id: loan.loan_id,
        leg_id: leg.leg_id,
      });
      const vout = tx.outs.findIndex(
        (o) =>
          to_hex(o.script) === to_hex(expected) &&
          o.value === BigInt(leg.amount_atomic),
      );
      if (vout < 0)
        throw new KansoError(
          'LOCK_NOT_VERIFIED',
          'Bitcoin deposit output does not match the commitment',
        );
      args = { ...args, raw_transaction: bytes, vout };
      method = 'submit_bitcoin_lock';
    }
    await signer.send(
      coordinator_transaction(this.d, signer.account.accountId, method, args),
      scoped_id(
        'accept-lock',
        loan.loan_id,
        leg.leg_id,
        transaction_id,
        ...(c.manifest.family === 'bitcoin'
          ? ['bitcoin-light-client', plan_hash(proof)]
          : []),
      ),
      c.manifest.family === 'bitcoin',
    );
  }
  async outgoing(
    loan: Loan,
    leg: BasketLeg,
    operation_id: string,
    owner: string,
    amount: string,
    revision: string,
  ): Promise<RemoteProgress[]> {
    if (leg.custody.family !== 'remote') throw new Error('Remote leg required');
    const c = await this.configuration(leg);
    if (c.manifest.family === 'bitcoin') {
      const spend = await this.near.view('get_bitcoin_spend', { operation_id });
      if (!spend)
        return [
          {
            name: 'prepare',
            label: 'Reserve Bitcoin output',
            done: false,
            action: coordinator_transaction(
              this.d,
              owner,
              'prepare_bitcoin_release',
              {
                operation_id,
                loan_id: loan.loan_id,
                leg_id: leg.leg_id,
                amount_atomic:
                  BigInt(amount) ===
                  BigInt(
                    loan.locks.find((l) => l.leg.leg_id === leg.leg_id)!
                      .locked_atomic,
                  )
                    ? (
                        BigInt(amount) -
                        BigInt(c.manifest.max_network_cost_atomic)
                      ).toString()
                    : amount,
                max_fee_atomic: c.manifest.max_network_cost_atomic,
                expected_revision: revision,
              },
            ),
          },
        ];
    } else {
      const op = await this.near.view('get_remote_operation', { operation_id });
      if (!op)
        return [
          {
            name: 'prepare',
            label: 'Reserve remote collateral release',
            done: false,
            action: coordinator_transaction(
              this.d,
              owner,
              'prepare_remote_release',
              {
                operation_id,
                loan_id: loan.loan_id,
                leg_id: leg.leg_id,
                amount_atomic: amount,
                expected_revision: revision,
                deadline: (await this.near.now()) + 3600,
              },
            ),
          },
        ];
    }
    return [
      {
        name: 'prepare',
        label: 'Source reservation committed',
        done: true,
        action: null,
      },
      ...(await this.progress(loan, leg, operation_id, owner)),
    ];
  }
  async replacement(
    loan: Loan,
    leg: BasketLeg,
    parent: string,
    operation_id: string,
    owner: string,
  ): Promise<RemoteProgress[]> {
    if (leg.custody.family !== 'remote') throw new Error('Remote leg required');
    const c = await this.configuration(leg);
    const op =
      c.manifest.family === 'bitcoin'
        ? await this.near.view('get_bitcoin_spend', { operation_id })
        : await this.near.view('get_remote_operation', { operation_id });
    if (!op)
      return [
        {
          name: 'prepare',
          label: 'Prepare bounded outgoing replacement',
          done: false,
          action: coordinator_transaction(
            this.d,
            owner,
            c.manifest.family === 'bitcoin'
              ? 'prepare_bitcoin_replacement'
              : 'prepare_remote_replacement',
            {
              operation_id: parent,
              expected_revision: loan.revision,
              ...(c.manifest.family === 'bitcoin'
                ? {
                    spend_id: operation_id,
                    max_fee_atomic: c.manifest.max_network_cost_atomic,
                  }
                : {
                    remote_operation_id: operation_id,
                    deadline: (await this.near.now()) + 3600,
                  }),
            },
          ),
        },
      ];
    return [
      {
        name: 'prepare',
        label: 'Source reservation committed',
        done: true,
        action: null,
      },
      ...(await this.progress(loan, leg, operation_id, owner)),
    ];
  }
  async progress(
    loan: Loan,
    leg: BasketLeg,
    operation_id: string,
    owner: string,
  ): Promise<RemoteProgress[]> {
    if (leg.custody.family !== 'remote') throw new Error('Remote leg required');
    const c = await this.configuration(leg),
      btc = c.manifest.family === 'bitcoin';
    const op = btc
      ? await this.near.view('get_bitcoin_spend', { operation_id })
      : await this.near.view('get_remote_operation', { operation_id });
    if (!op)
      throw new KansoError(
        'SETTLEMENT_RECONCILING',
        'Source reservation is not visible yet',
        true,
      );
    if (op.state === 'delivered')
      return [
        {
          name: 'authorize',
          label: 'MPC authorization recorded',
          done: true,
          action: null,
        },
        {
          name: 'signature',
          label: 'MPC signature reconciled',
          done: true,
          action: null,
        },
        {
          name: 'delivery',
          label: 'Verified source delivery',
          done: true,
          action: null,
        },
      ];
    if (op.state === 'invalidated' || op.state === 'cancelled')
      throw new KansoError(
        'INVALID_INPUT',
        'Source operation was invalidated; review a new intent',
      );
    if (op.state === 'prepared') {
      const context = btc
        ? null
        : await transaction_context(
            c,
            op as RemoteOperation,
            this.providers.client(c),
          );
      return [
        {
          name: 'authorize',
          label: 'Authorize bounded MPC transaction',
          done: false,
          action: coordinator_transaction(
            this.d,
            owner,
            btc ? 'request_bitcoin_signature' : 'request_remote_signature',
            {
              operation_id,
              attempt_id: 'initial',
              ...(btc
                ? {
                    fee_atomic:
                      'max_fee_atomic' in op ? op.max_fee_atomic : '0',
                    cancellation: false,
                  }
                : { context, invalidation: false }),
            },
            this.fee,
          ),
        },
      ];
    }
    const attempts = 'attempts' in op ? op.attempts : op.signing_attempts;
    const attempt = attempts.find(
      (a) =>
        a.signature !== null &&
        !('cancellation' in a ? a.cancellation : a.invalidation),
    );
    if (!attempt)
      return [
        {
          name: 'authorize',
          label: 'MPC authorization recorded',
          done: true,
          action: null,
        },
        {
          name: 'signature',
          label: 'Reconcile MPC signature outcome',
          done: false,
          action: null,
        },
      ];
    const packet = btc
      ? {
          transaction: await this.near.rpc.near_view<number[]>(
            this.d.near.coordinator,
            'signed_bitcoin_transaction',
            { operation_id, attempt_id: attempt.attempt_id },
          ),
          signature: [],
        }
      : await this.near.rpc.near_view<{
          transaction: number[];
          signature: number[];
        }>(this.d.near.coordinator, 'remote_broadcast_transaction', {
          operation_id,
          attempt_id: attempt.attempt_id,
        });
    const broadcast_id = scoped_id(
      c.manifest.chain_id,
      operation_id,
      attempt.attempt_id,
    );
    let broadcast = await this.broadcasts.findById(broadcast_id).lean();
    if (!broadcast) {
      let transaction_id: string;
      if (btc)
        transaction_id = BitcoinTransaction.fromBuffer(
          Uint8Array.from(packet.transaction),
        ).getId();
      else if (c.manifest.family === 'evm')
        transaction_id = keccak256(
          ('0x' + to_hex(packet.transaction)) as `0x${string}`,
        );
      else if (c.manifest.family === 'solana') {
        const tx = SolanaTransaction.from(packet.transaction);
        if (!tx.signature) throw new Error('Missing source signature');
        transaction_id = bs58.encode(tx.signature);
      } else if (c.manifest.family === 'sui')
        transaction_id = await SuiTransaction.from(
          Uint8Array.from(packet.transaction),
        ).getDigest();
      else
        transaction_id =
          '0x' +
          to_hex('payload' in attempt ? attempt.payload : attempt.digest);
      broadcast = await this.broadcasts.create({
        _id: broadcast_id,
        chain_id: c.manifest.chain_id,
        transaction_id,
        transaction: packet.transaction,
        signature: packet.signature,
      });
    }
    const rpc = this.providers.client(c);
    try {
      if (btc)
        await rpc.call('sendrawtransaction', [to_hex(broadcast.transaction)]);
      else if (c.manifest.family === 'evm')
        await rpc.call('eth_sendRawTransaction', [
          '0x' + to_hex(broadcast.transaction),
        ]);
      else if (c.manifest.family === 'solana')
        await rpc.call('sendTransaction', [
          base64(Uint8Array.from(broadcast.transaction)),
          { encoding: 'base64', skipPreflight: false },
        ]);
      else if (c.manifest.family === 'sui')
        await new SuiGrpcClient({
          network: 'testnet',
          baseUrl: c.rpc_url,
        }).executeTransaction({
          transaction: Uint8Array.from(broadcast.transaction),
          signatures: [base64(Uint8Array.from(broadcast.signature))],
        });
      else
        await rpc.call('starknet_addInvokeTransaction', {
          invoke_transaction: JSON.parse(
            new TextDecoder().decode(Uint8Array.from(broadcast.transaction)),
          ),
        });
    } catch (error) {
      if (!(error instanceof KansoError)) throw error;
    }
    try {
      const observation = btc
        ? await this.bitcoin.observe(c, broadcast.transaction_id)
        : await this.reads.observe(
            c,
            broadcast.transaction_id,
            'CommandExecuted',
            'command' in op ? op.command.operation_id : undefined,
          );
      const proof =
        'proof' in observation
          ? observation.proof
          : await this.reads.attest(c, observation);
      const signer = this.signer();
      await signer.send(
        coordinator_transaction(
          this.d,
          signer.account.accountId,
          btc ? 'submit_bitcoin_delivery' : 'submit_remote_delivery',
          {
            operation_id,
            proof,
            ...('proof' in observation
              ? { raw_transaction: observation.raw_transaction }
              : {}),
          },
        ),
        scoped_id(
          'source-delivery',
          operation_id,
          broadcast.transaction_id,
          ...(btc ? ['bitcoin-light-client', plan_hash(proof)] : []),
        ),
        btc,
      );
      return [
        {
          name: 'authorize',
          label: 'MPC authorization recorded',
          done: true,
          action: null,
        },
        {
          name: 'signature',
          label: 'MPC signature reconciled',
          done: true,
          action: null,
        },
        {
          name: 'delivery',
          label: 'Verify source delivery',
          done: true,
          action: null,
        },
      ];
    } catch (error) {
      if (
        error instanceof KansoError &&
        ['SETTLEMENT_RECONCILING', 'RPC_UNAVAILABLE'].includes(error.code)
      )
        return [
          {
            name: 'authorize',
            label: 'MPC authorization recorded',
            done: true,
            action: null,
          },
          {
            name: 'signature',
            label: 'MPC signature reconciled',
            done: true,
            action: null,
          },
          {
            name: 'delivery',
            label: 'Wait for finalized source delivery',
            done: false,
            action: null,
          },
        ];
      throw error;
    }
  }
  async recover_signature(
    operation_id: string,
    attempt_id: string,
    authorization_transaction_id: string,
    signer_id: string,
    bitcoin = false,
  ) {
    const result = await this.near.rpc.call<{
      receipts_outcome: { outcome: { status: { SuccessValue?: string } } }[];
    }>('tx', {
      tx_hash: authorization_transaction_id,
      sender_account_id: signer_id,
      wait_until: 'FINAL',
    });
    for (const receipt of result.receipts_outcome) {
      try {
        const bytes = receipt.outcome.status.SuccessValue;
        if (!bytes) continue;
        const parsed = mpc_signature.safeParse(
          JSON.parse(
            new TextDecoder().decode(
              Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)),
            ),
          ),
        );
        if (!parsed.success) continue;
        const relayer = this.signer();
        await relayer.send(
          coordinator_transaction(
            this.d,
            relayer.account.accountId,
            bitcoin ? 'submit_bitcoin_signature' : 'submit_remote_signature',
            { operation_id, attempt_id, signature: parsed.data },
            '0',
          ),
          scoped_id('recover-signature', operation_id, attempt_id),
        );
        return true;
      } catch (e) {
        if (e instanceof KansoError) throw e;
      }
    }
    return false;
  }
}
