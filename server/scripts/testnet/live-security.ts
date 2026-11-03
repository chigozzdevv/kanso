import { encodeFunctionData, keccak256, stringToHex } from 'viem';
import type { Hex } from 'viem';
import { evm_vault_abi } from '@kanso/bindings';
import type { Loan } from '@kanso/schema';
import type { Release } from '@testnet/deployment';
import type { LivePlan } from '@testnet/live-setup';
import { read_json } from '@testnet/store';
import { near_view } from '@testnet/deploy-near';
import { rpc } from '@testnet/network';

export async function verify_unauthorized(release: Release) {
  const journal = await read_json<{ contracts: { plan: LivePlan } }>(
    release.folder,
    'deployment-verification.json',
  );
  const d = journal.contracts.plan.deployment;
  const key = await read_json<{ address: Hex }>(
    release.folder,
    'keys/evm-deployer.json',
  );
  const hex = (bytes: number[]) =>
    ('0x' + Buffer.from(bytes).toString('hex')) as Hex;
  const unauthorized = keccak256(stringToHex('Unauthorized()')).slice(0, 10);
  for (const c of d.chains.filter((c) => c.manifest.family === 'evm')) {
    const m = c.manifest;
    if (process.env.LIVE_CHAIN && process.env.LIVE_CHAIN !== m.chain_id)
      continue;
    const loan = await near_view<Loan>(d.near.coordinator, 'get_loan', {
      loan_id: `live_${m.chain_id}_repay_v1`,
    });
    const lock = loan.locks[0]!;
    if (lock.leg.custody.family !== 'remote')
      throw new Error('Remote custody required');
    const data = encodeFunctionData({
      abi: evm_vault_abi,
      functionName: 'execute',
      args: [
        {
          operationId: keccak256(stringToHex(`unauthorized:${m.chain_id}`)),
          lockId: hex(lock.leg.custody.lock_id),
          agreement: hex(lock.agreement),
          settlementId: ('0x' + '00'.repeat(32)) as Hex,
          recipient: key.address,
          amount: 1n,
          nonce: BigInt(lock.remote_nonce),
          deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
          kind: 0,
        },
      ],
    });
    let rejection: string | undefined;
    try {
      await rpc(c.rpc_url, 'eth_call', [
        { from: key.address, to: hex(m.vault), data },
        'latest',
      ]);
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    if (!rejection?.includes(unauthorized))
      throw new Error(
        `${m.chain_id}: expected vault Unauthorized rejection, received ${rejection ?? 'success'}`,
      );
    release.journal.contracts[m.chain_id] = {
      test: 'source owner cannot withdraw committed collateral',
      method: 'eth_call',
      from: key.address,
      vault: hex(m.vault),
      chain_id: m.network_fingerprint,
      expected_error: unauthorized,
      rejection,
      verified_at: new Date().toISOString(),
    };
    await release.save();
    console.log(
      `${m.chain_id}: unauthorized withdrawal blocked by deployed vault`,
    );
  }
}
