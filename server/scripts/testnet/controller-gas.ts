import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deployment } from '@kanso/schema';
import {
  SystemProgram,
  PublicKey,
  Transaction as SolanaTransaction,
} from '@solana/web3.js';
import { Transaction as SuiTransaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Hex } from 'viem';
import { digest } from '@testnet/deployment';
import type { Release } from '@testnet/deployment';
import { read_json, workspace_root } from '@testnet/store';
import { send_evm, send_solana } from '@testnet/controller-transfers';
import { execute_sui } from '@testnet/deploy-sui';
import { starknet_invoke } from '@testnet/deploy-starknet';
import { STRK } from '@testnet/network';

export async function fund_controllers(
  release: Release,
  run: string,
  chain_id?: string,
) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(run))
    throw new Error(
      'A run ID of 1-64 letters, digits, underscores or hyphens is required',
    );
  const configured = deployment.parse(
    JSON.parse(
      await readFile(join(workspace_root, 'deployments/testnet.json'), 'utf8'),
    ),
  );
  if (
    chain_id &&
    !configured.chains.some((chain) => chain.manifest.chain_id === chain_id)
  )
    throw new Error(`Unknown controller chain: ${chain_id}`);
  const amounts: Record<string, bigint> = {
    base: 500_000_000_000_000n,
    arbitrum: 500_000_000_000_000n,
    bnb: 1_000_000_000_000_000n,
    polygon: 15_000_000_000_000_000n,
    avalanche: 10_000_000_000_000_000n,
    hyperevm: 500_000_000_000_000n,
  };
  for (const c of configured.chains) {
    const m = c.manifest;
    if (chain_id && chain_id !== m.chain_id) continue;
    const id = `gas-${m.chain_id}-${run}`;
    if (release.journal.effects[id]?.state === 'confirmed') continue;
    const address = ('0x' + Buffer.from(m.controller).toString('hex')) as Hex;
    if (m.family === 'evm')
      await send_evm(
        release,
        id,
        m.chain_id,
        address,
        '0x',
        amounts[m.chain_id]!,
      );
    if (m.family === 'solana') {
      const { Keypair } = await import('@solana/web3.js');
      const key = Keypair.fromSecretKey(
        Uint8Array.from(
          await read_json<number[]>(release.key_folder, 'solana-deployer.json'),
        ),
      );
      await send_solana(
        release,
        id,
        new SolanaTransaction().add(
          SystemProgram.transfer({
            fromPubkey: key.publicKey,
            toPubkey: new PublicKey(m.controller),
            lamports: 50_000_000,
          }),
        ),
      );
    }
    if (m.family === 'sui') {
      const key = await read_json<{ private_key: string }>(
        release.key_folder,
        'sui-deployer.json',
      );
      const tx = new SuiTransaction();
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(200_000_000)]);
      tx.transferObjects([coin], tx.pure.address(address));
      await execute_sui(
        release,
        id,
        tx,
        Ed25519Keypair.fromSecretKey(key.private_key),
        digest(JSON.stringify({ address, amount: '200000000' })),
      );
    }
    if (m.family === 'starknet')
      await starknet_invoke(release, id, [
        {
          contractAddress: STRK,
          entrypoint: 'transfer',
          calldata: [address, '25000000000000000000', '0'],
        },
      ]);
  }
}
