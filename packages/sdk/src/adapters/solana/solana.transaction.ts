import { Buffer } from 'buffer';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { KansoError } from '@kanso/schema';
import type {
  ChainConfiguration,
  BasketLeg,
  TransactionAction,
} from '@kanso/schema';
import { digest, base64 } from '@sdk/transport/codec';
export async function solana_deposit(
  c: ChainConfiguration,
  leg: BasketLeg,
  agreement: number[],
  purpose: number,
): Promise<TransactionAction> {
  if (leg.custody.family !== 'remote')
    throw new Error('Remote custody required');
  const rpc = new Connection(c.rpc_url, 'finalized');
  if ((await rpc.getGenesisHash()) !== c.manifest.network_fingerprint)
    throw new KansoError('NETWORK_MISMATCH', 'Solana RPC network mismatch');
  const program = new PublicKey(c.manifest.vault.slice(0, 32)),
    config = new PublicKey(c.manifest.vault.slice(32)),
    owner = new PublicKey(leg.custody.source_owner);
  const [lock] = PublicKey.findProgramAddressSync(
    [Buffer.from('lock'), config.toBuffer(), Buffer.from(leg.custody.lock_id)],
    program,
  );
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(BigInt(leg.amount_atomic));
  const data = Buffer.concat([
    Buffer.from([1]),
    Buffer.from(leg.custody.lock_id),
    Buffer.from(agreement),
    Buffer.from(digest(leg.owner)),
    Buffer.from(digest(leg.leg_id)),
    Buffer.from(leg.custody.release_recipient),
    Buffer.from([purpose]),
    amount,
  ]);
  const tx = new Transaction({
    feePayer: owner,
    recentBlockhash: (await rpc.getLatestBlockhash('finalized')).blockhash,
  });
  tx.add(
    new TransactionInstruction({
      programId: program,
      keys: [
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: lock, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    }),
  );
  return {
    family: 'solana',
    chain_id: 'solana',
    signer_id: owner.toBase58(),
    transaction: base64(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
    ),
  };
}
