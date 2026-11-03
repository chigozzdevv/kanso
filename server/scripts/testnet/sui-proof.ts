import * as crypto from 'node:crypto';
import { argon2d } from '@noble/hashes/argon2';

export interface SuiChallenge {
  version: number;
  domain: string;
  algorithm: string;
  argon2Version: number;
  memorySize: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
  salt: string;
  network: string;
  chainId: string;
  checkpointSeq: string;
  checkpointDigest: string;
  randomBytes: string;
  faucetAddress: string;
  recipient: string;
  threshold: string;
  windowSeconds: number;
  amountMist: string;
}
export function proof_hash(message: string): Buffer {
  if (typeof crypto.argon2Sync === 'function')
    return crypto.argon2Sync('argon2d', {
      message,
      nonce: 'sui-faucet-pow-1',
      memory: 8192,
      passes: 1,
      parallelism: 1,
      tagLength: 32,
    });
  return Buffer.from(
    argon2d(message, 'sui-faucet-pow-1', {
      m: 8192,
      t: 1,
      p: 1,
      dkLen: 32,
      version: 19,
    }),
  );
}
export function solve(
  challenge: SuiChallenge,
  recipient: string,
  started_at: number,
) {
  if (
    challenge.version !== 1 ||
    challenge.domain !== 'sui-faucet-pow/1' ||
    challenge.algorithm !== 'argon2d' ||
    challenge.argon2Version !== 19 ||
    challenge.memorySize !== 8192 ||
    challenge.iterations !== 1 ||
    challenge.parallelism !== 1 ||
    challenge.hashLength !== 32 ||
    challenge.salt !== 'sui-faucet-pow-1' ||
    challenge.network !== 'testnet' ||
    challenge.recipient !== recipient
  )
    throw new Error('Unsupported faucet challenge');
  const threshold = BigInt(challenge.threshold);
  if (threshold <= 0n || threshold >= 1n << 64n)
    throw new Error('Invalid faucet threshold');
  const prefix =
    [
      challenge.domain,
      challenge.chainId,
      challenge.checkpointSeq,
      challenge.checkpointDigest,
      challenge.randomBytes,
      challenge.faucetAddress,
      recipient,
    ].join('\n') + '\n';
  const deadline =
    started_at + Math.min(45, challenge.windowSeconds - 10) * 1000;
  for (let nonce = 0n; Date.now() < deadline; nonce++) {
    const hash = proof_hash(prefix + nonce.toString());
    if (hash.readBigUInt64BE(0) < threshold)
      return {
        recipient,
        checkpointSeq: challenge.checkpointSeq,
        nonce: nonce.toString(),
        hashHex: hash.toString('hex'),
      };
  }
  throw new Error(
    'Faucet proof deadline exceeded before submission; no payout requested',
  );
}
