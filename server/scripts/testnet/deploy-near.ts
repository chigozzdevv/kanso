import bs58 from 'bs58';
import { NEAR_TESTNET_USDC } from '@kanso/bindings';
import { delay } from '@kanso/sdk';
import {
  Account,
  connect,
  KeyPair,
  keyStores,
  transactions,
} from 'near-api-js';
import { rpc, NEAR_RPC, NEAR_SIGNER_RPC } from '@testnet/network';
import { read_json } from '@testnet/store';
import { digest } from '@testnet/deployment';
import type { Release } from '@testnet/deployment';
import type { Transfer } from '@kanso/schema';

const NEAR = 10n ** 24n;
const GAS = 100n * 10n ** 12n;
class DeployAccount extends Account {
  async prepare(receiver: string, actions: transactions.Action[]) {
    this.accessKeyByPublicKeyCache = {};
    const [hash, signed] = await this.signTransaction(receiver, actions);
    return {
      transaction_id: bs58.encode(hash),
      raw_transaction: Buffer.from(signed.encode()).toString('base64'),
    };
  }
}
export async function near_view<T>(
  account_id: string,
  method_name: string,
  args: unknown = {},
): Promise<T> {
  const result = await rpc<{ result?: number[]; error?: string }>(
    NEAR_RPC,
    'query',
    {
      request_type: 'call_function',
      finality: 'final',
      account_id,
      method_name,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    },
  );
  if (result.error) throw new Error(result.error);
  if (!result.result) throw new Error('NEAR view returned no result');
  return JSON.parse(Buffer.from(result.result).toString()) as T;
}
export async function near_signer(release: Release, role: string) {
  const key = await read_json<{
    account_id: string;
    private_key: `ed25519:${string}`;
  }>(release.key_folder, `near-${role}.json`);
  const store = new keyStores.InMemoryKeyStore();
  await store.setKey(
    'testnet',
    key.account_id,
    KeyPair.fromString(key.private_key),
  );
  const near = await connect({
    networkId: 'testnet',
    nodeUrl: NEAR_SIGNER_RPC,
    keyStore: store,
  });
  return new DeployAccount(near.connection, key.account_id);
}
export async function near_send(
  release: Release,
  id: string,
  signer: DeployAccount,
  receiver: string,
  actions: transactions.Action[],
) {
  const intent = digest(
    JSON.stringify(
      { signer: signer.accountId, receiver, actions },
      (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    ),
  );
  let effect = release.journal.effects[id];
  if (effect && effect.intent !== intent)
    throw new Error(`Deployment intent changed: ${id}`);
  if (effect?.state === 'failed')
    throw new Error(`Recorded transaction failed: ${id}`);
  if (effect?.state === 'confirmed') return effect;
  if (!effect) {
    effect = {
      intent,
      state: 'prepared',
      ...(await signer.prepare(receiver, actions)),
    };
    release.journal.effects[id] = effect;
    await release.save();
  }
  return reconcile_near(release, id, signer.accountId);
}
export async function reconcile_near(
  release: Release,
  id: string,
  signer_id: string,
) {
  const effect = release.journal.effects[id];
  if (!effect) throw new Error(`Missing signed transaction: ${id}`);
  if (effect.state === 'confirmed') return effect;
  if (effect.state === 'failed')
    throw new Error(`Recorded transaction failed: ${id}`);
  try {
    await rpc(NEAR_SIGNER_RPC, 'send_tx', {
      signed_tx_base64: effect.raw_transaction,
      wait_until: 'FINAL',
    });
  } catch (error) {
    console.log(
      `${id}: reconciling ${effect.transaction_id} (${error instanceof Error ? error.message.slice(0, 100) : 'RPC interrupted'})`,
    );
  }
  type Outcome = {
    status: { Failure?: unknown; SuccessValue?: string };
    receipts_outcome: unknown[];
    final_execution_status: string;
  };
  const deadline = Date.now() + 240000;
  let result: Outcome;
  for (;;) {
    try {
      result = await rpc<Outcome>(NEAR_RPC, 'tx', {
        tx_hash: effect.transaction_id,
        sender_account_id: signer_id,
        wait_until: 'NONE',
      });
      if (result.final_execution_status === 'FINAL') break;
    } catch (error) {
      if (!(
        error instanceof Error && error.message.includes('UNKNOWN_TRANSACTION')
      ))
        throw error;
    }
    if (Date.now() >= deadline)
      throw new Error(`Unresolved transaction: ${id}`);
    await delay(2000);
  }
  if (result.status.Failure !== undefined) {
    effect.state = 'failed';
    effect.result = result;
    await release.save();
    throw new Error(`${id}: ${JSON.stringify(result.status.Failure)}`);
  }
  if (result.status.SuccessValue === undefined)
    throw new Error(`Unresolved transaction: ${id}`);
  effect.state = 'confirmed';
  effect.result = result;
  await release.save();
  console.log(`${id}: ${effect.transaction_id}`);
  return effect;
}
export const call = (method: string, args: object, deposit = 1n) =>
  transactions.functionCall(
    method,
    args,
    [
      'submit_bitcoin_lock',
      'submit_bitcoin_delivery',
      'register_bitcoin_recovery',
      'stage_upgrade_chunk',
    ].includes(method)
      ? 300_000_000_000_000n
      : GAS,
    deposit,
  );

export async function finalize_near_transfer(
  release: Release,
  coordinator: string,
  transfer_id: string,
) {
  let transfer = await near_view<Transfer>(coordinator, 'get_transfer', {
    transfer_id,
  });
  if (transfer.outcome === 'unknown')
    throw new Error(`Transfer outcome unresolved: ${transfer_id}`);
  if (!transfer.finalized) {
    await near_send(
      release,
      `finalize-${transfer_id}`,
      await near_signer(release, 'relayer'),
      coordinator,
      [call('finalize_transfer', { transfer_id }, 0n)],
    );
    transfer = await near_view<Transfer>(coordinator, 'get_transfer', {
      transfer_id,
    });
  }
  if (!transfer.finalized || transfer.outcome !== 'succeeded')
    throw new Error(`Transfer did not succeed and finalize: ${transfer_id}`);
  return transfer;
}

export async function deploy_near(release: Release) {
  const owner = await near_signer(release, 'owner'),
    coordinator = await near_signer(release, 'coordinator');
  const wasm = await release.artifact(
    'contracts/near/target/near/kanso_coordinator.wasm',
  );
  const config = {
    deployment_id: release.journal.deployment_id,
    network: 'testnet',
    owner: coordinator.accountId,
    oracle_account: (await near_signer(release, 'oracle')).accountId,
    settlement_token: NEAR_TESTNET_USDC,
    settlement_decimals: 6,
    max_price_age_seconds: 300,
    max_confidence_bps: 100,
    max_ltv_bps: 6000,
    max_liquidation_threshold_bps: 8000,
    operational_reserve_atomic: (NEAR / 10n).toString(),
  };
  const metadata = await near_view<{ symbol: string; decimals: number }>(
    NEAR_TESTNET_USDC,
    'ft_metadata',
  );
  if (metadata.symbol !== 'USDC' || metadata.decimals !== 6)
    throw new Error('Circle USDC metadata mismatch');
  const protocol = await rpc<{
    runtime_config: { storage_amount_per_byte: string };
  }>(NEAR_RPC, 'EXPERIMENTAL_protocol_config', { finality: 'final' });
  const account = await rpc<{ amount: string; code_hash: string }>(
    NEAR_RPC,
    'query',
    {
      request_type: 'view_account',
      account_id: coordinator.accountId,
      finality: 'final',
    },
  );
  const storage =
    BigInt(wasm.bytes.length + 20_000) *
    BigInt(protocol.runtime_config.storage_amount_per_byte);
  if (!release.journal.effects['near-coordinator-deploy']) {
    const required = storage + NEAR;
    if (BigInt(account.amount) < required)
      await near_send(
        release,
        'near-storage-topup',
        owner,
        coordinator.accountId,
        [transactions.transfer(required - BigInt(account.amount))],
      );
  }
  // Self-initialization in the deployment batch prevents an initialization takeover.
  await near_send(
    release,
    'near-coordinator-deploy',
    coordinator,
    coordinator.accountId,
    [
      transactions.deployContract(wasm.bytes),
      call('new', { config }, 0n),
      call('set_pause_flags', {
        flags: {
          origination: true,
          collateral_withdrawals: false,
          settlements: false,
        },
      }),
    ],
  );
  await near_send(
    release,
    'near-bootstrap-storage',
    coordinator,
    coordinator.accountId,
    [call('storage_deposit', {}, NEAR / 10n)],
  );
  await near_send(
    release,
    'near-owner-propose',
    coordinator,
    coordinator.accountId,
    [call('propose_owner', { new_owner: owner.accountId })],
  );
  await near_send(release, 'near-owner-accept', owner, coordinator.accountId, [
    call('accept_owner', {}),
  ]);
  await near_send(release, 'near-owner-storage', owner, coordinator.accountId, [
    call('storage_deposit', {}, NEAR / 2n),
  ]);
  const public_keys = [];
  for (let i = 0; i < 3; i++) {
    const key = await read_json<{ public_key: string }>(
      release.key_folder,
      `recovery-attestor-${i}.json`,
    );
    public_keys.push(Array.from(bs58.decode(key.public_key.split(':')[1]!)));
  }
  await near_send(
    release,
    'near-recovery-configure',
    owner,
    coordinator.accountId,
    [call('configure_recovery', { policy: { public_keys, threshold: 2 } })],
  );
  const storage_bounds = await near_view<{ min: string }>(
    NEAR_TESTNET_USDC,
    'storage_balance_bounds',
  );
  for (const role of ['coordinator', 'lp', 'borrower', 'solver']) {
    const target = await near_signer(release, role);
    await near_send(
      release,
      `near-token-register-${role}`,
      owner,
      NEAR_TESTNET_USDC,
      [
        call(
          'storage_deposit',
          { account_id: target.accountId, registration_only: true },
          BigInt(storage_bounds.min),
        ),
      ],
    );
  }
  const live = await near_view<typeof config>(
    coordinator.accountId,
    'get_config',
  );
  if (
    live.owner !== owner.accountId ||
    live.deployment_id !== config.deployment_id
  )
    throw new Error('Coordinator configuration mismatch');
  const deployed = await rpc<{ code_hash: string }>(NEAR_RPC, 'query', {
    request_type: 'view_account',
    account_id: coordinator.accountId,
    finality: 'final',
  });
  if (deployed.code_hash !== bs58.encode(Buffer.from(wasm.sha256, 'hex')))
    throw new Error('Coordinator code hash mismatch');
  release.journal.contracts.near = {
    coordinator: coordinator.accountId,
    settlement_token: NEAR_TESTNET_USDC,
    config: live,
    code_sha256: wasm.sha256,
    paused: await near_view(coordinator.accountId, 'get_pause_flags'),
    recovery: await near_view(coordinator.accountId, 'get_recovery_policy'),
    upgrade: await near_view(coordinator.accountId, 'get_upgrade_status'),
    verified_at: new Date().toISOString(),
  };
  await release.save();
  return release.journal.contracts.near;
}
