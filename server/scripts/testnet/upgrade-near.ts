import { transactions } from 'near-api-js';
import bs58 from 'bs58';
import type { Release } from '@testnet/deployment';
import { near_send, near_signer, near_view, call } from '@testnet/deploy-near';
import { NEAR_SIGNER_RPC, rpc } from '@testnet/network';

interface UpgradeStatus {
  staged_bytes: number;
  minimum_delay_seconds: number;
  governance: {
    pending_upgrade: { code_hash: number[]; execute_after: number } | null;
    last_upgrade_hash: number[] | null;
  };
}
export async function upgrade_near(release: Release) {
  const owner = await near_signer(release, 'owner');
  const coordinator = (await near_signer(release, 'coordinator')).accountId;
  const artifact = await release.artifact(
    'contracts/near/target/near/kanso_coordinator.wasm',
  );
  const code_hash = Array.from(Buffer.from(artifact.sha256, 'hex'));
  const id = `upgrade-${artifact.sha256}`;
  async function record_completed(status: UpgradeStatus) {
    const account = await rpc<{ code_hash: string }>(NEAR_SIGNER_RPC, 'query', {
      request_type: 'view_account',
      account_id: coordinator,
      finality: 'final',
    });
    if (account.code_hash !== bs58.encode(Buffer.from(code_hash)))
      throw new Error(
        'Deployed coordinator code differs from the scheduled artifact',
      );
    const near = (release.journal.contracts.near ??= {}) as Record<
      string,
      unknown
    >;
    near.coordinator = coordinator;
    near.code_sha256 = artifact.sha256;
    near.upgrade = status;
    near.verified_at = new Date().toISOString();
    release.journal.contracts.coordinator_upgrade = {
      code_hash: artifact.sha256,
      state: 'completed',
      staged_bytes: status.staged_bytes,
    };
    await release.save();
  }
  let status = await near_view<UpgradeStatus>(
    coordinator,
    'get_upgrade_status',
  );
  if (
    JSON.stringify(status.governance.last_upgrade_hash) ===
    JSON.stringify(code_hash)
  ) {
    await record_completed(status);
    console.log(`Coordinator already runs ${artifact.sha256}`);
    return;
  }
  const pending = status.governance.pending_upgrade;
  if (
    pending &&
    JSON.stringify(pending.code_hash) !== JSON.stringify(code_hash)
  )
    throw new Error('A different coordinator upgrade is pending');
  if (!pending) {
    const block = await rpc<{ header: { timestamp_nanosec: string } }>(
      NEAR_SIGNER_RPC,
      'block',
      { finality: 'final' },
    );
    const execute_after =
      Number(BigInt(block.header.timestamp_nanosec) / 1_000_000_000n) +
      status.minimum_delay_seconds +
      30;
    await near_send(release, `${id}-schedule`, owner, coordinator, [
      call('schedule_upgrade', { code_hash, execute_after }),
    ]);
  }
  const credit = BigInt(
    await near_view<string>(coordinator, 'storage_balance', {
      account_id: owner.accountId,
    }),
  );
  const required =
    BigInt(artifact.bytes.length - status.staged_bytes) * 10n ** 19n +
    10n ** 23n;
  if (credit < required) {
    const funding_id = `${id}-storage-${status.staged_bytes}`;
    let funding = release.journal.contracts[funding_id] as
      { role: string; amount: string }[] | undefined;
    if (!funding) {
      funding = [];
      let remaining = required - credit;
      for (const role of ['owner', 'manager', 'solver']) {
        const signer =
          role === 'owner' ? owner : await near_signer(release, role);
        const account = await rpc<{ amount: string; storage_usage: number }>(
          NEAR_SIGNER_RPC,
          'query',
          {
            request_type: 'view_account',
            account_id: signer.accountId,
            finality: 'final',
          },
        );
        const reserve =
          (role === 'owner' ? 2n * 10n ** 24n : 10n ** 24n) +
          BigInt(account.storage_usage) * 10n ** 19n;
        const available =
          BigInt(account.amount) > reserve
            ? BigInt(account.amount) - reserve
            : 0n;
        const amount = available < remaining ? available : remaining;
        if (amount > 0n) {
          funding.push({ role, amount: amount.toString() });
          remaining -= amount;
        }
        if (remaining === 0n) break;
      }
      if (remaining > 0n)
        throw new Error(
          `Upgrade storage needs ${remaining} additional yoctoNEAR`,
        );
      release.journal.contracts[funding_id] = funding;
      await release.save();
    }
    for (const item of funding) {
      await near_send(
        release,
        `${funding_id}-${item.role}`,
        await near_signer(release, item.role),
        coordinator,
        [
          call(
            'storage_deposit',
            { account_id: owner.accountId },
            BigInt(item.amount),
          ),
        ],
      );
    }
  }
  status = await near_view<UpgradeStatus>(coordinator, 'get_upgrade_status');
  if (status.staged_bytes > artifact.bytes.length)
    throw new Error('Staged upgrade exceeds the local artifact');
  const owner_account = await rpc<{ amount: string }>(
    NEAR_SIGNER_RPC,
    'query',
    {
      request_type: 'view_account',
      account_id: owner.accountId,
      finality: 'final',
    },
  );
  if (BigInt(owner_account.amount) < 2n * 10n ** 24n) {
    const funding_id = `${id}-gas-${status.staged_bytes}`;
    const amount =
      (release.journal.contracts[funding_id] as string | undefined) ??
      (2n * 10n ** 24n - BigInt(owner_account.amount)).toString();
    const relayer = await near_signer(release, 'relayer');
    const balance = await rpc<{ amount: string }>(NEAR_SIGNER_RPC, 'query', {
      request_type: 'view_account',
      account_id: relayer.accountId,
      finality: 'final',
    });
    if (BigInt(balance.amount) < BigInt(amount) + 10n ** 24n)
      throw new Error(
        'Fund the owner account with 2 test NEAR for upgrade gas',
      );
    release.journal.contracts[funding_id] = amount;
    await release.save();
    await near_send(release, funding_id, relayer, owner.accountId, [
      transactions.transfer(BigInt(amount)),
    ]);
  }
  for (
    let offset = status.staged_bytes;
    offset < artifact.bytes.length;
    offset += 120_000
  )
    await near_send(
      release,
      `${id}-chunk-${offset}-gas300`,
      owner,
      coordinator,
      [
        call('stage_upgrade_chunk', {
          code_hash,
          offset,
          chunk: artifact.bytes
            .subarray(offset, offset + 120_000)
            .toString('base64'),
        }),
      ],
    );
  status = await near_view<UpgradeStatus>(coordinator, 'get_upgrade_status');
  const execute_after = status.governance.pending_upgrade!.execute_after;
  release.journal.contracts.coordinator_upgrade = {
    state: 'staged',
    code_hash: artifact.sha256,
    execute_after,
    staged_bytes: status.staged_bytes,
  };
  await release.save();
  const block = await rpc<{ header: { timestamp_nanosec: string } }>(
    NEAR_SIGNER_RPC,
    'block',
    { finality: 'final' },
  );
  if (
    Number(BigInt(block.header.timestamp_nanosec) / 1_000_000_000n) <
    execute_after
  ) {
    console.log(
      `Upgrade staged; execution opens at ${new Date(execute_after * 1000).toISOString()}`,
    );
    return;
  }
  await near_send(release, `${id}-execute`, owner, coordinator, [
    transactions.functionCall(
      'execute_upgrade',
      { code: null },
      300_000_000_000_000n,
      1n,
    ),
  ]);
  const completed = await near_view<UpgradeStatus>(
    coordinator,
    'get_upgrade_status',
  );
  if (
    completed.governance.pending_upgrade ||
    JSON.stringify(completed.governance.last_upgrade_hash) !==
      JSON.stringify(code_hash)
  )
    throw new Error('Coordinator upgrade did not complete');
  await record_completed(completed);
  console.log(`Coordinator upgraded to ${artifact.sha256}`);
}
