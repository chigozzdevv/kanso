import bs58 from 'bs58';
import { Buffer } from 'node:buffer';
import { PublicKey } from '@solana/web3.js';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { TransactionError } from '@mysten/sui/client';
import { KansoError } from '@kanso/schema';
import type { ChainConfiguration, Deployment } from '@kanso/schema';
import {
  unbase64,
  to_hex,
  coordinator_transaction,
  scoped_id,
} from '@kanso/sdk';
import type { NearSigner } from '@server/shared/near/coordinator.client';
import { RpcProvider } from '@server/shared/near/rpc.provider';
const raw = (value: string) => value.replace(/^0x/, '').toLowerCase();
const felt = (value: string) => BigInt(value).toString(16).padStart(64, '0');
export interface Observation {
  payload: Record<string, unknown>;
}
export class ReadMpcClient {
  constructor(
    private readonly d: Deployment,
    private readonly signer: NearSigner | undefined,
    private readonly deposit_atomic: string,
    private readonly providers = new RpcProvider(),
  ) {}
  async attest(c: ChainConfiguration, observation: Observation) {
    if (c.manifest.family === 'bitcoin')
      throw new KansoError(
        'CAPABILITY_DISABLED',
        'Bitcoin uses light-client inclusion proofs',
      );
    if (!this.signer)
      throw new KansoError(
        'CAPABILITY_DISABLED',
        'A funded read-MPC relayer is not configured',
      );
    const action = coordinator_transaction(
      this.d,
      this.signer.account.accountId,
      'request_read_attestation',
      {
        chain_id: c.manifest.chain_id,
        manifest_version: c.manifest.version,
        payload: observation.payload,
      },
      this.deposit_atomic,
    );
    const result = await this.signer.send(
      action,
      scoped_id(
        'read-mpc',
        this.d.deployment_id,
        c.manifest.chain_id,
        JSON.stringify(observation.payload),
      ),
    );
    const response = result.value as {
      signature?: {
        scheme?: string;
        big_r?: unknown;
        s?: unknown;
        recovery_id?: number;
      };
    };
    if (response?.signature?.scheme !== 'Secp256k1')
      throw new KansoError(
        'SETTLEMENT_RECONCILING',
        'MPC response is not an authenticated secp256k1 observation',
        true,
      );
    return {
      payload: observation.payload,
      signature: {
        big_r: response.signature.big_r,
        s: response.signature.s,
        recovery_id: response.signature.recovery_id,
      },
    };
  }
  async observe(
    c: ChainConfiguration,
    transaction_id: string,
    event: 'LockAccepted' | 'CommandExecuted',
    resource?: number[],
  ): Promise<Observation> {
    const m = c.manifest,
      rpc = this.providers.client(c);
    if (m.family === 'evm') {
      const receipt = await rpc.call<{
        blockNumber: string;
        blockHash: string;
        status: string;
        logs: {
          address: string;
          topics: string[];
          data: string;
          logIndex: string;
          transactionIndex: string;
          transactionHash: string;
          blockHash: string;
          blockNumber: string;
          removed?: boolean;
        }[];
      } | null>('eth_getTransactionReceipt', [transaction_id]);
      if (!receipt || receipt.status !== '0x1')
        throw new KansoError(
          'SETTLEMENT_RECONCILING',
          'EVM receipt is not successful',
          true,
        );
      const final = await rpc.call<{ number: string }>('eth_getBlockByNumber', [
        'finalized',
        false,
      ]);
      if (BigInt(receipt.blockNumber) > BigInt(final.number))
        throw new KansoError(
          'SETTLEMENT_RECONCILING',
          'EVM transaction has not finalized',
          true,
        );
      const topic = await import('viem').then((v) =>
        v.keccak256(
          v.stringToHex(
            event === 'LockAccepted'
              ? 'LockAccepted(bytes32,bytes32,bytes32,bytes32,bytes32,address,address,address,uint128,uint8)'
              : 'CommandExecuted(bytes32,bytes32,bytes32,bytes32,bytes32,address,uint128,uint128,uint64,uint8)',
          ),
        ),
      );
      const log = receipt.logs.find(
        (l) =>
          raw(l.address) === to_hex(m.vault) &&
          l.topics[0] === topic &&
          (!resource || raw(l.topics[1] ?? '') === to_hex(resource)),
      );
      if (!log)
        throw new KansoError(
          'LOCK_NOT_VERIFIED',
          'Committed vault event not found',
        );
      const request = {
        tx_id: raw(transaction_id),
        extractors: [{ Log: { log_index: Number(BigInt(log.logIndex)) } }],
        finality: 'Finalized',
      };
      const chain: Record<string, string> = {
        base: 'Base',
        arbitrum: 'Arbitrum',
        bnb: 'Bnb',
        polygon: 'Polygon',
        avalanche: 'Avalanche',
        hyperevm: 'HyperEvm',
      };
      return {
        payload: {
          V1: {
            request: { [chain[m.chain_id]!]: request },
            values: [
              {
                EvmExtractedValue: {
                  Log: {
                    removed: log.removed ?? false,
                    log_index: Number(BigInt(log.logIndex)),
                    transaction_index: Number(BigInt(log.transactionIndex)),
                    transaction_hash: raw(log.transactionHash),
                    block_hash: raw(log.blockHash),
                    block_number: Number(BigInt(log.blockNumber)),
                    address: raw(log.address),
                    data: log.data,
                    topics: log.topics.map(raw),
                  },
                },
              },
            ],
          },
        },
      };
    }
    if (m.family === 'solana') {
      if (!resource) throw new Error('Solana resource identity required');
      const program = new PublicKey(m.vault.slice(0, 32)),
        config = new PublicKey(m.vault.slice(32));
      const [account] = PublicKey.findProgramAddressSync(
        [
          Buffer.from(event === 'LockAccepted' ? 'lock' : 'receipt'),
          config.toBuffer(),
          Buffer.from(resource),
        ],
        program,
      );
      const status = await rpc.call<{
        value: ({ err: unknown; confirmationStatus: string } | null)[];
      }>('getSignatureStatuses', [
        [transaction_id],
        { searchTransactionHistory: true },
      ]);
      if (
        status.value[0]?.confirmationStatus !== 'finalized' ||
        status.value[0].err
      )
        throw new KansoError(
          'SETTLEMENT_RECONCILING',
          'Solana transaction has not finalized',
          true,
        );
      const accountInfo = await rpc.call<{
        value: { owner: string; data: [string, string] } | null;
      }>('getAccountInfo', [
        account.toBase58(),
        { encoding: 'base64', commitment: 'finalized' },
      ]);
      if (!accountInfo.value)
        throw new KansoError('LOCK_NOT_VERIFIED', 'Source account is absent');
      return {
        payload: {
          V1: {
            request: {
              Solana: {
                tx_id: to_hex(bs58.decode(transaction_id)),
                finality: 'Finalized',
                extractors: [
                  { AccountState: { pubkey: to_hex(account.toBytes()) } },
                ],
              },
            },
            values: [
              {
                SvmExtractedValue: {
                  AccountState: {
                    owner: to_hex(bs58.decode(accountInfo.value.owner)),
                    data: to_hex(unbase64(accountInfo.value.data[0])),
                  },
                },
              },
            ],
          },
        },
      };
    }
    if (m.family === 'sui') {
      const client = new SuiGrpcClient({
        network: 'testnet',
        baseUrl: c.rpc_url,
      });
      const result = await client
        .getTransaction({
          digest: transaction_id,
          include: { events: true },
        })
        .catch((error: unknown) => {
          if (error instanceof TransactionError && error.reason === 'notFound')
            throw new KansoError(
              'SETTLEMENT_RECONCILING',
              'Sui transaction is not indexed yet',
              true,
            );
          throw error;
        });
      if (result.$kind !== 'Transaction')
        throw new KansoError('LOCK_NOT_VERIFIED', 'Sui transaction failed');
      const tx = result.Transaction;
      if (!tx.checkpoint)
        throw new KansoError(
          'SETTLEMENT_RECONCILING',
          'Sui transaction has no checkpoint',
          true,
        );
      const index = tx.events.findIndex(
        (e) =>
          raw(e.packageId).padStart(64, '0') === to_hex(m.vault.slice(0, 32)) &&
          e.eventType.endsWith('::collateral_vault::' + event) &&
          (!resource || to_hex(e.bcs.slice(96, 128)) === to_hex(resource)),
      );
      if (index < 0)
        throw new KansoError('LOCK_NOT_VERIFIED', 'Sui vault event absent');
      const e = tx.events[index]!;
      const tag = e.eventType.replace(
        /^0x[0-9a-fA-F]+/,
        '0x' + raw(e.packageId).padStart(64, '0'),
      );
      return {
        payload: {
          V1: {
            request: {
              Sui: {
                tx_id: to_hex(bs58.decode(transaction_id)),
                finality: 'Checkpointed',
                extractors: [{ Event: { event_index: index } }],
              },
            },
            values: [
              {
                SuiExtractedValue: {
                  Event: {
                    package_id: raw(e.packageId).padStart(64, '0'),
                    transaction_module: e.module,
                    sender: raw(e.sender).padStart(64, '0'),
                    type_tag: tag,
                    bcs: to_hex(e.bcs),
                  },
                },
              },
            ],
          },
        },
      };
    }
    if (m.family === 'starknet') {
      const tx = await rpc.call<{
        finality_status: string;
        execution_status: string;
        block_hash: string;
        block_number: number;
        events: { from_address: string; keys: string[]; data: string[] }[];
      }>('starknet_getTransactionReceipt', {
        transaction_hash: transaction_id,
      });
      if (
        tx.finality_status !== 'ACCEPTED_ON_L1' ||
        tx.execution_status !== 'SUCCEEDED'
      )
        throw new KansoError(
          'SETTLEMENT_RECONCILING',
          'Starknet transaction is not accepted on L1',
          true,
        );
      const selector = await import('starknet').then((s) =>
        s.hash.getSelectorFromName(event),
      );
      const index = tx.events.findIndex(
        (e) =>
          felt(e.from_address) === to_hex(m.vault) &&
          BigInt(e.keys[0] ?? 0) === BigInt(selector) &&
          (!resource || felt(e.keys[1] ?? '0') === to_hex(resource)),
      );
      if (index < 0)
        throw new KansoError(
          'LOCK_NOT_VERIFIED',
          'Starknet vault event absent',
        );
      const e = tx.events[index]!;
      return {
        payload: {
          V1: {
            request: {
              Starknet: {
                tx_id: felt(transaction_id),
                finality: 'AcceptedOnL1',
                extractors: [{ Log: { log_index: index } }],
              },
            },
            values: [
              {
                StarknetExtractedValue: {
                  Log: {
                    block_hash: felt(tx.block_hash),
                    block_number: tx.block_number,
                    from_address: felt(e.from_address),
                    keys: e.keys.map(felt),
                    data: e.data.map(felt),
                  },
                },
              },
            ],
          },
        },
      };
    }
    throw new KansoError(
      'CAPABILITY_DISABLED',
      'Bitcoin uses light-client inclusion proofs',
    );
  }
}
