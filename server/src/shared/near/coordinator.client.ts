import { randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import {
  Account,
  KeyPair,
  keyStores,
  connect,
  transactions,
} from 'near-api-js';
import {
  CoordinatorClient,
  plan_hash,
  base64,
  unbase64,
  JsonRpc,
} from '@kanso/sdk';
import { KansoError } from '@kanso/schema';
import type { Deployment, NearAction } from '@kanso/schema';
import type { RemoteActionRepo } from '@server/features/operation/remote-action.repo';
export { CoordinatorClient };
class SignableAccount extends Account {
  async prepare(action: NearAction) {
    this.accessKeyByPublicKeyCache = {};
    const [hash, signed] = await this.signTransaction(
      action.receiver_id,
      action.calls.map((c) =>
        transactions.functionCall(
          c.method,
          c.args,
          BigInt(c.gas),
          BigInt(c.deposit),
        ),
      ),
    );
    return {
      transaction_id: bs58.encode(hash),
      raw_transaction: base64(signed.encode()),
      nonce: signed.transaction.nonce.toString(),
    };
  }
}
export class NearSigner {
  readonly rpc: JsonRpc;
  private constructor(
    readonly account: SignableAccount,
    readonly deployment: Deployment,
    private readonly journal: RemoteActionRepo,
  ) {
    this.rpc = new JsonRpc(deployment.near.rpc_url);
  }
  static async create(
    d: Deployment,
    account_id: string,
    private_key: string,
    journal: RemoteActionRepo,
  ) {
    const keys = new keyStores.InMemoryKeyStore();
    await keys.setKey(
      d.network,
      account_id,
      KeyPair.fromString(private_key as `ed25519:${string}`),
    );
    const near = await connect({
      networkId: d.network,
      nodeUrl: d.near.rpc_url,
      keyStore: keys,
    });
    const account = new SignableAccount(near.connection, account_id);
    return new NearSigner(account, d, journal);
  }
  async send(
    action: NearAction,
    effect_id: string,
    retry_bitcoin_proof = false,
  ): Promise<{ transaction_id: string; value: unknown }> {
    if (action.signer_id !== this.account.accountId)
      throw new Error('Relayer signer mismatch');
    if (
      retry_bitcoin_proof &&
      (action.calls.length !== 1 ||
        ![
          'submit_bitcoin_lock',
          'submit_bitcoin_delivery',
          'register_bitcoin_recovery',
        ].includes(action.calls[0]!.method))
    )
      throw new Error('Only Bitcoin inclusion callbacks support proof retries');
    const intent = plan_hash(action),
      owner = randomUUID();
    if (!(await this.journal.lease(this.account.accountId, owner)))
      throw new KansoError(
        'SETTLEMENT_RECONCILING',
        'Signer is processing another transaction',
        true,
      );
    try {
      let effect = await this.journal.get(effect_id, intent);
      const original_id = effect_id;
      for (
        let retry = 1;
        retry_bitcoin_proof && effect?.state === 'failed' && retry <= 8;
        retry++
      ) {
        effect_id = `${original_id}-retry-${retry}`;
        effect = await this.journal.get(effect_id, intent);
      }
      if (!effect) {
        const pending = await this.journal.model
          .find({ signer_id: this.account.accountId, state: 'prepared' })
          .lean();
        if (pending.length) {
          const keys = await this.account.getAccessKeys();
          const key = await this.account.connection.signer.getPublicKey(
            this.account.accountId,
            this.deployment.network,
          );
          const nonce =
            keys.find((k) => k.public_key === key?.toString())?.access_key
              .nonce ?? 0;
          if (pending.some((p) => BigInt(p.nonce) > BigInt(nonce)))
            throw new KansoError(
              'BROADCAST_UNKNOWN',
              'Reconcile earlier account nonce before signing another effect',
              true,
            );
        }
        const prepared = await this.account.prepare(action);
        effect = await this.journal.model.create({
          _id: effect_id,
          intent_hash: intent,
          signer_id: this.account.accountId,
          ...prepared,
          state: 'prepared',
          result: null,
        });
      }
      if (effect.state === 'failed')
        throw new KansoError(
          'INVALID_INPUT',
          'The recorded transaction failed on-chain',
        );
      if (effect.state === 'confirmed')
        return { transaction_id: effect.transaction_id, value: effect.result };
      try {
        await this.rpc.call('send_tx', {
          signed_tx_base64: effect.raw_transaction,
          wait_until: 'FINAL',
        });
      } catch (error) {
        if (!(error instanceof KansoError)) throw error;
      }
      const result = await this.rpc.call<{
        status: { SuccessValue?: string; Failure?: unknown };
        final_execution_status?: string;
      }>('tx', {
        tx_hash: effect.transaction_id,
        sender_account_id: this.account.accountId,
        wait_until: 'FINAL',
      });
      if (result.status.Failure) {
        await this.journal.model.updateOne(
          { _id: effect_id },
          { $set: { state: 'failed', result: result.status.Failure } },
        );
        throw new KansoError(
          retry_bitcoin_proof ? 'SETTLEMENT_RECONCILING' : 'INVALID_INPUT',
          'Relayer transaction failed: ' +
            JSON.stringify(result.status.Failure),
          retry_bitcoin_proof,
        );
      }
      if (result.status.SuccessValue === undefined)
        throw new KansoError(
          'BROADCAST_UNKNOWN',
          'Transaction outcome is pending',
          true,
        );
      const bytes = unbase64(result.status.SuccessValue);
      const value = bytes.length
        ? (JSON.parse(new TextDecoder().decode(bytes)) as unknown)
        : null;
      await this.journal.model.updateOne(
        { _id: effect_id },
        { $set: { state: 'confirmed', result: value } },
      );
      return { transaction_id: effect.transaction_id, value };
    } finally {
      await this.journal.release(this.account.accountId, owner);
    }
  }
}
