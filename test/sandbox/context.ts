import { fileURLToPath } from 'node:url';
import { keyStores } from 'near-api-js';
import {
  Sandbox as NearSandbox,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_PRIVATE_KEY,
} from 'near-sandbox';
import { KeyPair, Worker } from 'near-workspaces';
import type { NearAccount } from 'near-workspaces';
import { loan_record, loan_offer, transfer } from '@kanso/schema';
import type { Offer } from '@kanso/schema';

export const NEAR = 10n ** 24n;
export const GAS = 300n * 10n ** 12n;
export const signed = { gas: GAS, attachedDeposit: 1n };

export const policy = {
  version: 1,
  apr_bps: 1000,
  origination_fee_atomic: '0',
  min_principal_atomic: '1000000',
  max_principal_atomic: '1000000000',
  max_duration_seconds: 2_592_000,
  setup_duration_seconds: 3600,
  grace_seconds: 60,
  interest_buffer_seconds: 86_400,
  ltv_bps: 5000,
  liquidation_threshold_bps: 7000,
  min_liquidity_atomic: '0',
  withdrawal_health_ppm: 1_200_000,
  min_conditional_trigger_health_ppm: 1_100_000,
  max_liquidation_surplus_atomic: '1000000',
  recovery_health_ppm: 1_300_000,
  max_execution_cost_bps: 500,
  max_slippage_bps: 500,
  max_execution_cost_atomic: '10000000',
  eligible_assets: ['near'],
  asset_caps: [
    { asset_id: 'near', max_collateral_value_atomic: '1000000000000' },
  ],
  max_outstanding_principal_atomic: '10000000000',
};

export async function create_sandbox(genesis: { epoch_length?: number } = {}) {
  const node = await NearSandbox.start({
    version: '2.13.4',
    config: { additionalGenesis: genesis },
  });
  try {
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey(
      'custom',
      DEFAULT_ACCOUNT_ID,
      KeyPair.fromString(DEFAULT_PRIVATE_KEY),
    );
    const worker = await Worker.init({
      network: 'custom',
      rpcAddr: node.rpcUrl,
      rootAccountId: DEFAULT_ACCOUNT_ID,
      keyStore,
    });
    const root = worker.rootAccount;
    const coordinator = await root.createSubAccount('kanso', {
      initialBalance: 20n * NEAR,
    });
    const token = await root.createSubAccount('usdc', {
      initialBalance: 10n * NEAR,
    });
    const lp = await root.createSubAccount('lp', {
      initialBalance: 100n * NEAR,
    });
    const borrower = await root.createSubAccount('borrower', {
      initialBalance: 1000n * NEAR,
    });
    const unregistered = await root.createSubAccount('unregistered', {
      initialBalance: 10n * NEAR,
    });
    const wasm = new URL('../../contracts/near/target/near/', import.meta.url);
    await token.deploy(fileURLToPath(new URL('kanso_test_usdc.wasm', wasm)));
    await root.call(token, 'new', {
      owner_id: root.accountId,
      total_supply: '1000000000000',
    });
    await coordinator.deploy(
      fileURLToPath(new URL('kanso_coordinator.wasm', wasm)),
    );
    await root.call(coordinator, 'new', {
      config: {
        deployment_id: 'sandbox',
        network: 'sandbox',
        owner: root.accountId,
        oracle_account: root.accountId,
        settlement_token: token.accountId,
        settlement_decimals: 6,
        max_price_age_seconds: 300,
        max_confidence_bps: 100,
        max_ltv_bps: 6000,
        max_liquidation_threshold_bps: 8000,
        operational_reserve_atomic: (NEAR / 10n).toString(),
      },
    });
    for (const account of [coordinator, lp, borrower]) {
      await root.call(
        token,
        'storage_deposit',
        { account_id: account.accountId },
        { attachedDeposit: NEAR / 10n },
      );
    }
    for (const account of [root, lp, borrower]) {
      await account.call(
        coordinator,
        'storage_deposit',
        {},
        { attachedDeposit: 2n * NEAR },
      );
    }
    await root.call(
      token,
      'ft_transfer',
      { receiver_id: lp.accountId, amount: '10000000000' },
      signed,
    );
    await root.call(
      token,
      'ft_transfer',
      { receiver_id: borrower.accountId, amount: '1000000000' },
      signed,
    );
    let sequence = 0;

    async function now() {
      const block = await worker.provider.block({ finality: 'final' });
      return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000_000n);
    }

    async function refresh_price(price_atomic = '5000000') {
      const previous = await coordinator.view<{ sequence: number } | null>(
        'get_asset_price',
        { asset_id: 'near' },
      );
      sequence = Math.max(sequence, previous?.sequence ?? 0) + 1;
      await root.call(coordinator, 'publish_price', {
        price: {
          price_atomic,
          confidence_bps: 0,
          published_at: await now(),
          sequence,
        },
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await worker.provider.query<{
          result: number[];
          block_height: number;
          block_hash: string;
        }>({
          request_type: 'call_function',
          finality: 'final',
          account_id: coordinator.accountId,
          method_name: 'get_asset_price',
          args_base64: Buffer.from(
            JSON.stringify({ asset_id: 'near' }),
          ).toString('base64'),
        });
        const price = JSON.parse(Buffer.from(result.result).toString()) as {
          sequence: number;
        } | null;
        if (price?.sequence === sequence) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Published oracle price did not reach finality');
    }

    async function pay(
      payer: NearAccount,
      amount: string,
      intent: Record<string, string>,
    ) {
      return payer.call<string>(
        token,
        'ft_transfer_call',
        {
          receiver_id: coordinator.accountId,
          amount,
          msg: JSON.stringify(intent),
        },
        signed,
      );
    }

    async function create_pool(pool_id: string) {
      await lp.call(coordinator, 'create_pool', { pool_id, policy }, signed);
      await pay(lp, '1000000000', {
        kind: 'pool_deposit',
        pool_id,
        operation_id: `deposit_${pool_id}`,
      });
    }

    async function offer(
      offer_id: string,
      pool_id: string,
      overrides: Partial<Offer> = {},
    ) {
      await refresh_price();
      const timestamp = await now();
      return loan_offer.parse({
        deployment_id: 'sandbox',
        network: 'sandbox',
        offer_id,
        pool_id,
        borrower: borrower.accountId,
        payout_account: borrower.accountId,
        policy_version: 1,
        principal_atomic: '100000000',
        apr_bps: 1000,
        duration_seconds: 2_592_000,
        origination_fee_atomic: '0',
        expires_at: timestamp + 300,
        setup_deadline: timestamp + 1800,
        min_price_atomic: '4000000',
        max_price_atomic: '6000000',
        legs: [
          {
            asset_id: 'near',
            custody: { family: 'near' as const },
            leg_id: 'near',
            owner: borrower.accountId,
            amount_atomic: (100n * NEAR).toString(),
            release_recipient: borrower.accountId,
          },
        ],
        ...overrides,
      });
    }

    async function loan(loan_id: string) {
      return loan_record.parse(await coordinator.view('get_loan', { loan_id }));
    }

    async function operation(transfer_id: string) {
      return transfer.parse(
        await coordinator.view('get_transfer', { transfer_id }),
      );
    }

    async function token_balance(account: NearAccount) {
      return BigInt(
        await token.view<string>('ft_balance_of', {
          account_id: account.accountId,
        }),
      );
    }

    return {
      worker,
      node,
      root,
      coordinator,
      token,
      lp,
      borrower,
      unregistered,
      now,
      pay,
      create_pool,
      offer,
      loan,
      operation,
      token_balance,
      refresh_price,
    };
  } catch (error) {
    await node.tearDown();
    throw error;
  }
}

export type Sandbox = Awaited<ReturnType<typeof create_sandbox>>;
