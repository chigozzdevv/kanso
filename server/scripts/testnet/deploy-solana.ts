import { setTimeout as pause } from 'node:timers/promises';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { read_json, private_json } from '@testnet/store';
import { digest } from '@testnet/deployment';
import type { Release } from '@testnet/deployment';
import type { MpcKeys } from '@testnet/mpc';
import { SOLANA_RPC } from '@testnet/network';

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({
  pubkey,
  isWritable,
  isSigner,
});
export async function deploy_solana(release: Release) {
  const connection = new Connection(SOLANA_RPC, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  });
  if (
    (await connection.getGenesisHash()) !==
    'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
  )
    throw new Error('Expected Solana Devnet');
  const load = async (role: string) =>
    Keypair.fromSecretKey(
      Uint8Array.from(
        await read_json<number[]>(release.folder, `keys/solana-${role}.json`),
      ),
    );
  for (const role of ['program', 'buffer']) {
    try {
      await load(role);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
      if (
        Object.keys(release.journal.effects).length ||
        release.journal.contracts.solana
      )
        throw new Error(
          'Restore the missing Solana deployment key before resuming',
          { cause: error },
        );
      await private_json(
        release.folder,
        `keys/solana-${role}.json`,
        Array.from(Keypair.generate().secretKey),
      );
    }
  }
  const payer = await load('deployer'),
    program = await load('program'),
    buffer = await load('buffer');
  const artifact = await release.artifact(
    'contracts/solana/target/deploy/kanso_solana_vault.so',
  );
  const mpc = await read_json<MpcKeys>(release.folder, 'mpc.json');
  const controller_address = mpc.controllers.solana?.address;
  if (!controller_address) throw new Error('Missing Solana controller address');
  const [programdata] = PublicKey.findProgramAddressSync(
    [program.publicKey.toBuffer()],
    LOADER,
  );
  async function send(
    id: string,
    instructions: TransactionInstruction[],
    additional: Keypair[] = [],
  ) {
    const intent = digest(JSON.stringify(instructions));
    let effect = release.journal.effects[id];
    if (effect && effect.intent !== intent)
      throw new Error(`Deployment intent changed: ${id}`);
    if (effect?.state === 'confirmed') return;
    if (effect?.state === 'failed')
      throw new Error(`Recorded Solana transaction failed: ${id}`);
    if (effect) {
      const status = (
        await connection.getSignatureStatuses([effect.transaction_id], {
          searchTransactionHistory: true,
        })
      ).value[0];
      if (status?.err)
        throw new Error(
          `Solana transaction failed: ${JSON.stringify(status.err)}`,
        );
      if (
        status?.confirmationStatus === 'finalized' ||
        status?.confirmationStatus === 'confirmed'
      ) {
        effect.state = 'confirmed';
        effect.result = status;
        await release.save();
        return;
      }
      const tx = Transaction.from(
        Buffer.from(effect.raw_transaction!, 'base64'),
      );
      if (!(await connection.isBlockhashValid(tx.recentBlockhash!)).value) {
        (effect.replacements ??= []).push({
          transaction_id: effect.transaction_id,
          raw_transaction: effect.raw_transaction!,
        });
        effect = undefined;
      }
    }
    if (!effect) {
      const latest = await connection.getLatestBlockhash();
      const tx = new Transaction({
        feePayer: payer.publicKey,
        recentBlockhash: latest.blockhash,
      }).add(...instructions);
      tx.sign(payer, ...additional);
      effect = {
        intent,
        state: 'prepared',
        transaction_id: bs58.encode(tx.signature!),
        raw_transaction: tx.serialize().toString('base64'),
        replacements: release.journal.effects[id]?.replacements ?? [],
      };
      release.journal.effects[id] = effect;
      await release.save();
    }
    await connection.sendRawTransaction(
      Buffer.from(effect.raw_transaction!, 'base64'),
      { skipPreflight: false, maxRetries: 2 },
    );
    for (let attempt = 0; attempt < 30; attempt++) {
      await pause(2500);
      const status = (
        await connection.getSignatureStatuses([effect.transaction_id], {
          searchTransactionHistory: true,
        })
      ).value[0];
      if (status?.err) {
        effect.state = 'failed';
        effect.result = status;
        await release.save();
        throw new Error(`${id}: ${JSON.stringify(status.err)}`);
      }
      if (
        status?.confirmationStatus === 'confirmed' ||
        status?.confirmationStatus === 'finalized'
      ) {
        effect.state = 'confirmed';
        effect.result = status;
        await release.save();
        console.log(`${id}: ${effect.transaction_id}`);
        return;
      }
    }
    throw new Error(`Unresolved Solana transaction: ${effect.transaction_id}`);
  }
  let deployed = await connection.getAccountInfo(program.publicKey);
  if (!deployed) {
    let uploaded = await connection.getAccountInfo(buffer.publicKey);
    if (!uploaded) {
      const rent = await connection.getMinimumBalanceForRentExemption(
        37 + artifact.bytes.length,
      );
      if (
        (await connection.getBalance(payer.publicKey)) <
        rent * 2 + 10_000_000
      )
        throw new Error('Insufficient Solana program and buffer funding');
      const data = Buffer.alloc(4);
      await send(
        'solana-buffer-create',
        [
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: buffer.publicKey,
            lamports: rent,
            space: 37 + artifact.bytes.length,
            programId: LOADER,
          }),
          new TransactionInstruction({
            programId: LOADER,
            keys: [meta(buffer.publicKey, true), meta(payer.publicKey)],
            data,
          }),
        ],
        [buffer],
      );
      uploaded = await connection.getAccountInfo(buffer.publicKey);
    }
    if (
      !uploaded ||
      !uploaded.owner.equals(LOADER) ||
      uploaded.data.readUInt32LE(0) !== 1 ||
      uploaded.data[4] !== 1 ||
      !uploaded.data.subarray(5, 37).equals(payer.publicKey.toBuffer())
    )
      throw new Error('Expected existing deployment buffer owned by deployer');
    for (let offset = 0; offset < artifact.bytes.length; offset += 900) {
      const chunk = artifact.bytes.subarray(offset, offset + 900);
      if (
        uploaded.data
          .subarray(37 + offset, 37 + offset + chunk.length)
          .equals(chunk)
      )
        continue;
      const data = Buffer.alloc(16 + chunk.length);
      data.writeUInt32LE(1, 0);
      data.writeUInt32LE(offset, 4);
      data.writeBigUInt64LE(BigInt(chunk.length), 8);
      chunk.copy(data, 16);
      await send(`solana-write-${offset}`, [
        new TransactionInstruction({
          programId: LOADER,
          keys: [
            meta(buffer.publicKey, true),
            meta(payer.publicKey, false, true),
          ],
          data,
        }),
      ]);
    }
    const complete = await connection.getAccountInfo(buffer.publicKey);
    if (!complete?.data.subarray(37).equals(artifact.bytes))
      throw new Error('Uploaded Solana program hash mismatch');
    const rent = await connection.getMinimumBalanceForRentExemption(36);
    const program_rent = await connection.getMinimumBalanceForRentExemption(
      45 + artifact.bytes.length,
    );
    if (
      (await connection.getBalance(payer.publicKey)) <
      rent + program_rent + 10_000_000
    )
      throw new Error('Insufficient Solana deployment funding');
    const data = Buffer.alloc(12);
    data.writeUInt32LE(2, 0);
    data.writeBigUInt64LE(BigInt(artifact.bytes.length), 4);
    await send(
      'solana-program-deploy',
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: program.publicKey,
          lamports: rent,
          space: 36,
          programId: LOADER,
        }),
        new TransactionInstruction({
          programId: LOADER,
          keys: [
            meta(payer.publicKey, true, true),
            meta(programdata, true),
            meta(program.publicKey, true),
            meta(buffer.publicKey, true),
            meta(SYSVAR_RENT_PUBKEY),
            meta(SYSVAR_CLOCK_PUBKEY),
            meta(SystemProgram.programId),
            meta(payer.publicKey, false, true),
          ],
          data,
        }),
      ],
      [program],
    );
    deployed = await connection.getAccountInfo(program.publicKey);
  }
  const code = await connection.getAccountInfo(programdata);
  if (
    !deployed?.executable ||
    !deployed.owner.equals(LOADER) ||
    !code?.data.subarray(45, 45 + artifact.bytes.length).equals(artifact.bytes)
  )
    throw new Error('Deployed Solana bytecode mismatch');
  const deployment = Buffer.from(digest(release.journal.deployment_id), 'hex'),
    network = Buffer.from(bs58.decode(await connection.getGenesisHash())),
    controller = new PublicKey(controller_address);
  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from('config'), deployment, controller.toBuffer()],
    program.publicKey,
  );
  const expected = Buffer.concat([
    Buffer.from('KANSOCFG'),
    deployment,
    network,
    controller.toBuffer(),
  ]);
  if (!(await connection.getAccountInfo(config)))
    await send('solana-config-initialize', [
      new TransactionInstruction({
        programId: program.publicKey,
        keys: [
          meta(config, true),
          meta(payer.publicKey, true, true),
          meta(SystemProgram.programId),
        ],
        data: Buffer.concat([
          Buffer.from([0]),
          deployment,
          network,
          controller.toBuffer(),
        ]),
      }),
    ]);
  const configuration = await connection.getAccountInfo(config);
  if (
    !configuration?.owner.equals(program.publicKey) ||
    !configuration.data.equals(expected)
  )
    throw new Error('Solana configuration mismatch');
  if (code.data[12] === 1) {
    if (!code.data.subarray(13, 45).equals(payer.publicKey.toBuffer()))
      throw new Error('Unexpected Solana upgrade authority');
    const data = Buffer.alloc(4);
    data.writeUInt32LE(4);
    await send('solana-make-immutable', [
      new TransactionInstruction({
        programId: LOADER,
        keys: [meta(programdata, true), meta(payer.publicKey, false, true)],
        data,
      }),
    ]);
  }
  const final = await connection.getAccountInfo(programdata, 'finalized');
  if (!final || final.data[12] !== 0)
    throw new Error('Solana upgrade authority remains active');
  release.journal.contracts.solana = {
    family: 'solana',
    program: program.publicKey.toBase58(),
    programdata: programdata.toBase58(),
    config: config.toBase58(),
    controller: mpc.controllers.solana,
    network_fingerprint: await connection.getGenesisHash(),
    artifact_sha256: artifact.sha256,
    deployment_slot: final.data.readBigUInt64LE(4).toString(),
    immutable: true,
    enabled: false,
    verified_at: new Date().toISOString(),
  };
  await release.save();
  console.log(
    `Solana: verified immutable program ${program.publicKey.toBase58()}`,
  );
}
