import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  balance,
  json_request,
  rpc,
  near_account,
  NEAR_RPC,
  NEAR_FAUCET,
  SOLANA_RPC,
  SUI_FAUCET,
  NetworkError,
  sui,
  evm_balances,
} from '@testnet/network';
import { solve } from '@testnet/sui-proof';
import { starknet_proof } from '@testnet/starknet-proof';
import type { SuiChallenge } from '@testnet/sui-proof';
import {
  directory,
  keys_directory,
  read_json,
  private_json,
  replace_json,
} from '@testnet/store';
import type { KeyIndex } from '@testnet/store';

export interface FaucetRecord {
  family: string;
  role: string;
  address: string;
  endpoint: string;
  requested_at: string;
  state: 'prepared' | 'submitted' | 'confirmed' | 'unavailable' | 'unknown';
  request?: unknown;
  transaction_id?: string;
  request_id?: string;
  balance_atomic?: string;
  amount_atomic?: string;
  detail?: string;
}

async function faucet_records(folder: string): Promise<FaucetRecord[]> {
  try {
    return await read_json<FaucetRecord[]>(folder, 'faucets.json');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
    await private_json(folder, 'faucets.json', []);
    return [];
  }
}
export async function fund_testnet(family?: string, retry_unavailable = false) {
  if (family && !['near', 'solana', 'sui', 'starknet'].includes(family))
    throw new Error('Unsupported automated faucet family');
  const folder = await directory(),
    index = await read_json<KeyIndex>(await keys_directory(), 'index.json');
  const lock = await open(join(folder, 'faucet.lock'), 'wx', 0o600);
  try {
    const records = await faucet_records(folder);
    const save = () => replace_json(folder, 'faucets.json', records);
    const blocked = new Set<string>();
    for (const wallet of index.wallets) {
      if (family && wallet.family !== family) continue;
      if (
        !['near', 'solana', 'sui', 'starknet'].includes(wallet.family) ||
        blocked.has(wallet.family)
      )
        continue;
      const existing = records
        .filter(
          (r) => r.family === wallet.family && r.address === wallet.address,
        )
        .at(-1);
      if (
        existing &&
        !(retry_unavailable && existing.state === 'unavailable')
      ) {
        console.log(
          JSON.stringify({
            family: wallet.family,
            role: wallet.role,
            state: existing.state,
            detail:
              'Existing request retained; inspect status before any further payout',
          }),
        );
        continue;
      }
      const record: FaucetRecord = {
        family: wallet.family,
        role: wallet.role,
        address: wallet.address,
        endpoint:
          wallet.family === 'near'
            ? NEAR_FAUCET
            : wallet.family === 'solana'
              ? SOLANA_RPC
              : wallet.family === 'sui'
                ? SUI_FAUCET + '/v3/gas'
                : 'https://api.faucet.starknet.io/api/public-agent/faucet/request',
        requested_at: new Date().toISOString(),
        state: 'prepared',
      };
      records.push(record);
      await save();
      let awaiting_submission = false;
      try {
        const before = await balance(wallet);
        if (before !== null && BigInt(before) > 0n) {
          record.state = 'confirmed';
          record.balance_atomic = before;
          record.detail = 'Already funded; no payout requested';
          await save();
          continue;
        }
        if (wallet.family === 'near') {
          const key = await read_json<{ public_key: string }>(
            await keys_directory(),
            wallet.key_file,
          );
          record.request = {
            newAccountId: wallet.address,
            newAccountPublicKey: key.public_key,
          };
          record.state = 'submitted';
          await save();
          awaiting_submission = true;
          await json_request<unknown>(NEAR_FAUCET, record.request);
          awaiting_submission = false;
          const account = await near_account(wallet.address);
          if (!account)
            throw new Error(
              'Faucet response received; account not yet finalized',
            );
          await rpc(NEAR_RPC, 'query', {
            request_type: 'view_access_key',
            finality: 'final',
            account_id: wallet.address,
            public_key: key.public_key,
          });
        } else if (wallet.family === 'solana') {
          record.request = { address: wallet.address, lamports: 2_000_000_000 };
          record.state = 'submitted';
          await save();
          awaiting_submission = true;
          record.transaction_id = await rpc<string>(
            SOLANA_RPC,
            'requestAirdrop',
            [wallet.address, 2_000_000_000],
          );
          awaiting_submission = false;
          await save();
        } else if (wallet.family === 'sui') {
          const started = Date.now();
          const challenge = await json_request<SuiChallenge>(
            SUI_FAUCET + '/v3/challenge?recipient=' + wallet.address,
          );
          record.request = solve(challenge, wallet.address, started);
          record.state = 'submitted';
          await save();
          awaiting_submission = true;
          const response = await json_request<{
            status: string;
            digest?: string;
            recipient?: string;
            amountMist?: string;
          }>(record.endpoint, record.request);
          awaiting_submission = false;
          if (
            response.status !== 'success' ||
            !response.digest ||
            response.recipient !== wallet.address
          )
            throw new Error(
              'Unexpected Sui faucet result: ' + JSON.stringify(response),
            );
          record.transaction_id = response.digest;
          await save();
          const transaction = await sui.waitForTransaction({
            digest: response.digest,
            signal: AbortSignal.timeout(25_000),
          });
          if (transaction.$kind !== 'Transaction')
            throw new Error('Sui faucet transaction failed');
        } else {
          const challenge = await json_request<{
            data: {
              challengeId: string;
              powInputPrefix: string;
              difficulty: number;
            };
          }>('https://api.faucet.starknet.io/api/public-agent/pow/challenge', {
            userAddress: wallet.address,
          });
          const nonce = starknet_proof(
            challenge.data.powInputPrefix,
            challenge.data.difficulty,
          );
          record.request = {
            userAddress: wallet.address,
            challengeId: challenge.data.challengeId,
            nonce,
          };
          record.state = 'submitted';
          await save();
          awaiting_submission = true;
          const result = await json_request<{
            data: { requestId: string; pollAfterSeconds: number };
          }>(record.endpoint, record.request);
          awaiting_submission = false;
          if (!result.data?.requestId)
            throw new Error('Faucet request identity missing');
          record.request_id = result.data.requestId;
          await save();
          let delay = result.data.pollAfterSeconds;
          for (let attempt = 0; attempt < 12; attempt++) {
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(1, Math.min(60, delay)) * 1000),
            );
            const status = await json_request<{
              data: {
                jobStatus: string;
                txHash?: string;
                pollAfterSeconds: number;
              };
            }>(
              'https://api.faucet.starknet.io/api/public-agent/faucet/status/' +
                encodeURIComponent(record.request_id),
            );
            if (status.data.txHash) {
              record.transaction_id = status.data.txHash;
              await save();
            }
            if (status.data.jobStatus === 'confirmed') break;
            if (status.data.jobStatus === 'failed')
              throw new Error('Starknet faucet job failed');
            delay = status.data.pollAfterSeconds;
          }
        }
        for (let attempt = 0; attempt < 8; attempt++) {
          const current = await balance(wallet);
          if (current !== null && BigInt(current) > 0n) {
            record.balance_atomic = current;
            record.state = 'confirmed';
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (record.state !== 'confirmed') {
          record.state = 'unknown';
          record.detail =
            'Submitted; funding not yet observed. Do not request another payout.';
        }
      } catch (error) {
        record.detail = error instanceof Error ? error.message : String(error);
        const definitive =
          awaiting_submission &&
          !record.transaction_id &&
          !record.request_id &&
          error instanceof NetworkError &&
          (error.status === 429 ||
            error.status === 400 ||
            error.message.includes('429') ||
            error.message.includes('rate limit'));
        record.state =
          record.state === 'submitted' && !definitive
            ? 'unknown'
            : 'unavailable';
        blocked.add(wallet.family);
      }
      await save();
      console.log(JSON.stringify(record));
    }
    return records;
  } finally {
    await lock.close();
    await unlink(join(folder, 'faucet.lock'));
  }
}
export async function testnet_status() {
  const folder = await directory(),
    index = await read_json<KeyIndex>(await keys_directory(), 'index.json'),
    records = await faucet_records(folder);
  const wallets = [];
  for (const wallet of index.wallets) {
    try {
      wallets.push(
        wallet.family === 'evm'
          ? { ...wallet, networks: await evm_balances(wallet.address) }
          : { ...wallet, balance_atomic: await balance(wallet) },
      );
    } catch (error) {
      wallets.push({
        ...wallet,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { checked_at: new Date().toISOString(), wallets, faucets: records };
}
