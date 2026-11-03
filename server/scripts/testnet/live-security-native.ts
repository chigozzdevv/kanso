import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { Transaction as SuiTransaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Account, RpcProvider } from 'starknet';
import { Transaction as BitcoinTransaction, payments } from 'bitcoinjs-lib';
import { secp256k1 } from '@noble/curves/secp256k1';
import type { Loan } from '@kanso/schema';
import { digest } from '@testnet/deployment';
import type { Release } from '@testnet/deployment';
import type { LivePlan } from '@testnet/live-setup';
import { read_json } from '@testnet/store';
import { near_view, near_signer, near_send, call } from '@testnet/deploy-near';
import { rpc } from '@testnet/network';

export async function verify_native_authority(release: Release) {
  const journal = await read_json<{ contracts: { plan: LivePlan } }>(
    release.folder,
    'deployment-verification.json',
  );
  const d = journal.contracts.plan.deployment;
  const hex = (b: number[]) => '0x' + Buffer.from(b).toString('hex');
  for (const c of d.chains.filter((c) =>
    ['solana', 'sui', 'starknet'].includes(c.manifest.family),
  )) {
    const m = c.manifest;
    if (process.env.LIVE_CHAIN && process.env.LIVE_CHAIN !== m.chain_id)
      continue;
    const loan = await near_view<Loan>(d.near.coordinator, 'get_loan', {
      loan_id: `live_${m.chain_id}_repay_v1`,
    });
    const lock = loan.locks[0]!,
      custody = lock.leg.custody;
    if (custody.family !== 'remote') throw new Error('Remote custody required');
    const operation = Buffer.from(digest(`unauthorized:${m.chain_id}`), 'hex');
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    let rejection: unknown;
    if (m.family === 'solana') {
      const key = Keypair.fromSecretKey(
        Uint8Array.from(
          await read_json<number[]>(
            release.folder,
            'keys/solana-deployer.json',
          ),
        ),
      );
      const program = new PublicKey(m.vault.slice(0, 32)),
        config = new PublicKey(m.vault.slice(32));
      const [resource] = PublicKey.findProgramAddressSync(
        [Buffer.from('lock'), config.toBuffer(), Buffer.from(custody.lock_id)],
        program,
      );
      const [receipt] = PublicKey.findProgramAddressSync(
        [Buffer.from('receipt'), config.toBuffer(), operation],
        program,
      );
      const integer = (v: bigint) => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(v);
        return b;
      };
      const data = Buffer.concat([
        Buffer.from([2]),
        operation,
        Buffer.from(custody.lock_id),
        Buffer.from(lock.agreement),
        Buffer.alloc(32),
        key.publicKey.toBuffer(),
        integer(1n),
        integer(BigInt(lock.remote_nonce)),
        integer(BigInt(deadline)),
        Buffer.from([0]),
        integer(2_000_000n),
      ]);
      const block = await rpc<{ value: { blockhash: string } }>(
        c.rpc_url,
        'getLatestBlockhash',
        [{ commitment: 'finalized' }],
      );
      const tx = new Transaction({
        feePayer: key.publicKey,
        recentBlockhash: block.value.blockhash,
      });
      tx.add(
        new TransactionInstruction({
          programId: program,
          keys: [
            { pubkey: config, isSigner: false, isWritable: false },
            { pubkey: resource, isSigner: false, isWritable: true },
            { pubkey: receipt, isSigner: false, isWritable: true },
            { pubkey: key.publicKey, isSigner: true, isWritable: true },
            { pubkey: key.publicKey, isSigner: true, isWritable: true },
            { pubkey: key.publicKey, isSigner: false, isWritable: true },
            {
              pubkey: SystemProgram.programId,
              isSigner: false,
              isWritable: false,
            },
          ],
          data,
        }),
      );
      tx.sign(key);
      const result = await rpc<{ value: { err: unknown; logs: string[] } }>(
        c.rpc_url,
        'simulateTransaction',
        [
          tx.serialize().toString('base64'),
          { encoding: 'base64', sigVerify: true, commitment: 'finalized' },
        ],
      );
      const error = result.value.err as {
        InstructionError?: [number, { Custom?: number }];
      } | null;
      if (error?.InstructionError?.[1]?.Custom !== 2)
        throw new Error(
          `Solana authority check did not reject with Unauthorized: ${JSON.stringify(result.value)}`,
        );
      rejection = result.value;
    } else if (m.family === 'sui') {
      const client = new SuiGrpcClient({
        network: 'testnet',
        baseUrl: c.rpc_url,
      });
      const key = await read_json<{ address: string }>(
        release.folder,
        'keys/sui-deployer.json',
      );
      const tx = new SuiTransaction();
      tx.setSender(key.address);
      tx.setGasBudget(20_000_000);
      tx.moveCall({
        target: `${hex(m.vault.slice(0, 32))}::collateral_vault::execute`,
        arguments: [
          tx.object(hex(m.vault.slice(32))),
          tx.object('0x6'),
          tx.pure.address('0x' + operation.toString('hex')),
          tx.pure.address(hex(custody.lock_id)),
          tx.pure.address(hex(lock.agreement)),
          tx.pure.address('0x0'),
          tx.pure.address(key.address),
          tx.pure.u64(1),
          tx.pure.u64(lock.remote_nonce),
          tx.pure.u64(deadline),
          tx.pure.u8(0),
        ],
      });
      let failure: unknown;
      try {
        const bytes = await tx.build({ client });
        const result = await client.simulateTransaction({
          transaction: bytes,
          checksEnabled: true,
        });
        if (
          result.$kind === 'FailedTransaction' &&
          !result.FailedTransaction.status.success
        )
          failure = result.FailedTransaction.status.error;
      } catch (error) {
        if (!(error instanceof Error) || !('executionError' in error))
          throw error;
        failure = error.executionError;
      }
      const error = failure as
        | {
            $kind?: string;
            MoveAbort?: { abortCode: string; location?: { module?: string } };
          }
        | undefined;
      if (
        error?.$kind !== 'MoveAbort' ||
        error.MoveAbort?.abortCode !== '4' ||
        error.MoveAbort.location?.module !== 'collateral_vault'
      )
        throw new Error(
          `Sui authority check failed for an unexpected reason: ${JSON.stringify(error)}`,
        );
      rejection = failure;
    } else {
      const key = await read_json<{ address: string; private_key: string }>(
        release.folder,
        'keys/starknet-deployer.json',
      );
      const account = new Account({
        provider: new RpcProvider({ nodeUrl: c.rpc_url }),
        address: key.address,
        signer: key.private_key,
      });
      const felt = (bytes: number[] | Buffer) => {
        const b = Buffer.from(bytes);
        b[0] = b[0]! & 3;
        return '0x' + b.toString('hex');
      };
      try {
        await account.estimateInvokeFee([
          {
            contractAddress: hex(m.vault),
            entrypoint: 'execute',
            calldata: [
              felt(operation),
              hex(custody.lock_id),
              felt(lock.agreement),
              '0',
              key.address,
              '1',
              String(lock.remote_nonce),
              String(deadline),
              '0',
            ],
          },
        ]);
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error);
      }
      if (typeof rejection !== 'string' || !rejection.includes('UNAUTHORIZED'))
        throw new Error(
          `Starknet authority check failed for an unexpected reason: ${String(rejection)}`,
        );
    }
    release.journal.contracts[m.chain_id] = {
      test: 'source owner cannot withdraw committed collateral',
      method: 'source chain simulation',
      chain_id: m.network_fingerprint,
      vault: hex(m.vault),
      rejection,
      verified_at: new Date().toISOString(),
    };
    await release.save();
    console.log(
      `${m.chain_id}: unauthorized withdrawal blocked by deployed custody`,
    );
  }
  if (!process.env.LIVE_CHAIN || process.env.LIVE_CHAIN === 'near') {
    const id = 'unauthorized-near-release';
    const recorded = () => release.journal.effects[id];
    if (!recorded()) {
      try {
        await near_send(
          release,
          id,
          await near_signer(release, 'manager'),
          d.near.coordinator,
          [
            call('release_collateral', {
              loan_id: 'live_near_repay_v1',
              leg_id: 'near',
              transfer_id: 'unauthorized_near_release',
            }),
          ],
        );
      } catch (error) {
        if (!JSON.stringify(recorded()?.result).includes('BORROWER_REQUIRED'))
          throw error;
      }
    }
    const effect = release.journal.effects[id]!;
    if (
      effect.state !== 'failed' ||
      !JSON.stringify(effect.result).includes('BORROWER_REQUIRED')
    )
      throw new Error('NEAR unauthorized withdrawal was not rejected');
    release.journal.contracts.near = {
      test: 'non-borrower cannot withdraw committed collateral',
      method: 'rejected on-chain transaction',
      transaction_id: effect.transaction_id,
      expected_error: 'BORROWER_REQUIRED',
      verified_at: new Date().toISOString(),
    };
    await release.save();
    console.log(
      'near: unauthorized withdrawal blocked by deployed coordinator',
    );
  }
  if (!process.env.LIVE_CHAIN || process.env.LIVE_CHAIN === 'bitcoin') {
    const c = d.chains.find((c) => c.manifest.family === 'bitcoin')!;
    const primary = await read_json<{
      effects: Record<string, { transaction_id: string }>;
    }>(release.folder, 'deployment-verification.json');
    const parent =
      primary.effects['deposit-live_bitcoin_repay_v1']!.transaction_id;
    const loan = await near_view<Loan>(d.near.coordinator, 'get_loan', {
      loan_id: 'live_bitcoin_repay_v1',
    });
    const amount = BigInt(loan.offer.legs[0]!.amount_atomic);
    const script = Buffer.from(
      await near_view<number[]>(d.near.coordinator, 'bitcoin_deposit_script', {
        loan_id: loan.loan_id,
        leg_id: 'bitcoin',
      }),
    );
    const key = await read_json<{ public_key: string; private_key: string }>(
      release.folder,
      'keys/bitcoin-deployer.json',
    );
    const tx = new BitcoinTransaction();
    tx.version = 2;
    tx.addInput(Buffer.from(parent, 'hex').reverse(), 0, 0xfffffffd);
    const leg = loan.offer.legs[0]!;
    if (leg.custody.family !== 'remote')
      throw new Error('Bitcoin custody required');
    tx.addOutput(Uint8Array.from(leg.custody.source_owner), amount - 1000n);
    const code = payments.p2pkh({ hash: script.subarray(2) }).output!;
    const sighash = tx.hashForWitnessV0(
      0,
      code,
      amount,
      BitcoinTransaction.SIGHASH_ALL,
    );
    const signature = secp256k1
      .sign(sighash, Buffer.from(key.private_key.replace(/^0x/, ''), 'hex'))
      .toDERRawBytes();
    tx.setWitness(0, [
      Buffer.concat([Buffer.from(signature), Buffer.from([1])]),
      Buffer.from(key.public_key, 'hex'),
    ]);
    const results = await rpc<{ allowed: boolean; 'reject-reason'?: string }[]>(
      c.rpc_url,
      'testmempoolaccept',
      [[tx.toHex()]],
    );
    const result = results[0];
    if (
      result?.allowed !== false ||
      !/(Witness program hash mismatch|Script failed an OP_EQUALVERIFY operation)/.test(
        result['reject-reason'] ?? '',
      )
    )
      throw new Error(
        `Bitcoin unauthorized spend rejected for an unexpected reason: ${JSON.stringify(results)}`,
      );
    release.journal.contracts.bitcoin = {
      test: 'source private key cannot spend MPC-controlled collateral',
      method: 'testmempoolaccept',
      parent_transaction: parent,
      candidate_transaction: tx.getId(),
      rejection: result,
      verified_at: new Date().toISOString(),
    };
    await release.save();
    console.log(
      'bitcoin: unauthorized custody spend blocked by native signature validation',
    );
  }
}
