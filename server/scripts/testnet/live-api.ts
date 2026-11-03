import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { create_kanso, scoped_id, delay } from '@kanso/sdk';
import type { Operation } from '@kanso/sdk';
import { deployment, KansoError } from '@kanso/schema';
import type { Release } from '@testnet/deployment';
import { testnet_wallet } from '@testnet/live-wallet-auth';
import { call, near_send, near_signer, near_view } from '@testnet/deploy-near';
import { refresh_prices } from '@testnet/live-loans';
import { NEAR_TESTNET_USDC } from '@kanso/bindings';
import { send_source } from '@testnet/live-wallets';
import { verify_usdc_refund, verify_liquidity } from '@testnet/verify-usdc';

export async function verify_api_lifecycle(release: Release) {
  const d = deployment.parse(
    JSON.parse(
      await readFile(
        join(release.folder, '..', 'deployments/testnet.json'),
        'utf8',
      ),
    ),
  );
  const settings = parse(await readFile(join(release.folder, 'server.env')));
  const chain_ids = (process.env.LIVE_CHAIN ?? 'near')
    .split(',')
    .map((value) => value.trim())
    .sort();
  if (
    new Set(chain_ids).size !== chain_ids.length ||
    chain_ids.some((value) => !value)
  )
    throw new Error('Choose distinct collateral chain IDs');
  const sources = chain_ids.map((chain_id) => {
    if (chain_id === 'near') return { asset_id: 'near', decimals: 24 };
    const source = d.chains.find((c) => c.manifest.chain_id === chain_id);
    if (!source?.manifest.new_locks_enabled || !source.evidence)
      throw new Error(
        `Enable verified ${chain_id} capabilities before the API lifecycle test`,
      );
    return {
      asset_id: source.manifest.asset_id,
      decimals: source.manifest.decimals,
    };
  });
  const bitcoin = chain_ids.includes('bitcoin');
  const remote = chain_ids.some((value) => value !== 'near');
  const principal = bitcoin ? 5_000_000n : 1_000_000n;
  const scope = scoped_id(
    'api-lifecycle',
    d.near.settlement_token,
    ...d.pool_ids,
    ...chain_ids,
  );
  const details = (release.journal.contracts[scope] ??= {}) as Record<
    string,
    unknown
  >;
  const key_for = (kind: string) => scoped_id(scope, kind);
  const api_url = `http://127.0.0.1:${settings.PORT}`;
  const client = create_kanso({
    deployment: d,
    api_url,
    auth_domain: settings.AUTH_DOMAIN!,
    wallets: async (r) => testnet_wallet(release, d, r.family, r.chain_id),
  });
  const wallet = await testnet_wallet(release, d, 'near', 'near');
  const owner = (await wallet.accounts())[0]!.address;
  await client.session.connect(owner);
  const balance = () =>
    near_view<string>(d.near.settlement_token, 'ft_balance_of', {
      account_id: owner,
    });
  async function previous(key: string) {
    try {
      return await client.operation(scoped_id(d.deployment_id, owner, key));
    } catch (error) {
      if (error instanceof KansoError && error.code === 'NOT_FOUND')
        return null;
      throw error;
    }
  }
  async function complete(op: Operation) {
    release.journal.contracts[op.operation_id] = op.checkpoint();
    await release.save();
    for (const step of (await op.snapshot()).steps) {
      if (
        !['confirmed', 'submitted', 'unknown'].includes(step.state) ||
        step.transaction_id ||
        !step.action
      )
        continue;
      const id = scoped_id('live-wallet', JSON.stringify(step.action));
      const receipt = release.journal.effects[id];
      let transaction_id =
        receipt?.state === 'confirmed' ? receipt.transaction_id : null;
      // This owned test wallet journals before broadcast, so retries preserve the transaction identity.
      if (
        !transaction_id &&
        step.state !== 'confirmed' &&
        step.action.family !== 'near'
      )
        transaction_id = await send_source(release, id, step.action);
      if (transaction_id)
        await op.record_transaction({
          step_id: step.step_id,
          transaction_id,
        });
    }
    const end = Date.now() + (bitcoin ? 1_800_000 : remote ? 900_000 : 240_000);
    let progress = '';
    for (;;) {
      const state = await op.execute();
      const current = JSON.stringify([
        state.status,
        state.steps.map((s) => [s.label, s.state]),
      ]);
      if (current !== progress) {
        console.log(`${op.operation_id}: ${current}`);
        progress = current;
      }
      if (state.status === 'succeeded') {
        console.log(`${op.operation_id}: SDK/API/worker operation succeeded`);
        return state;
      }
      if (['failed', 'cancelled'].includes(state.status) || Date.now() >= end)
        throw new Error(
          `Live API operation is ${state.status}: ${JSON.stringify(state.error)}`,
        );
      await delay(2500);
    }
  }
  const key = key_for('borrow');
  let setup = await previous(key);
  if (!setup) {
    await refresh_prices();
    const basket = await Promise.all(
      sources.map(async ({ asset_id, decimals }) => {
        const price = await client.coordinator.view('get_asset_price', {
          asset_id,
        });
        if (!price)
          throw new Error(`Collateral price is unavailable: ${asset_id}`);
        const conservative =
          (BigInt(price.price_atomic) * BigInt(10000 - price.confidence_bps)) /
          10000n;
        const denominator = conservative * BigInt(sources.length);
        if (denominator <= 0n)
          throw new Error(`Collateral price is invalid: ${asset_id}`);
        return {
          asset_id,
          amount_atomic: (
            (principal * 4n * 10n ** BigInt(decimals) + denominator - 1n) /
            denominator
          ).toString(),
        };
      }),
    );
    if (!details.balance_before) {
      details.balance_before = await balance();
      await release.save();
    }
    const request = client.request({
      borrower: owner,
      basket,
      loan_terms: {
        principal_atomic: principal.toString(),
        duration_seconds: 3600,
        payout_account: owner,
      },
      conditional_repayment: { enabled: false },
    });
    await request.connect_required_wallets();
    const response = await request.offers();
    const offer = response.offers.find((o) => d.pool_ids.includes(o.pool_id));
    if (!offer)
      throw new Error(
        `Public pool returned no offer: ${JSON.stringify(response.rejections)}`,
      );
    setup = await request.accept({
      offer_id: offer.offer_id,
      idempotency_key: key,
    });
  }
  const funded = await complete(setup);
  if (funded.plan.kind !== 'setup')
    throw new Error('Expected a setup operation');
  const loan_id = funded.plan.offer.offer_id;
  if (!(await client.loans.list()).some((loan) => loan.loan_id === loan_id))
    throw new Error('The new loan is missing from the authenticated loan list');
  const loan = client.loan(loan_id);
  if (!details.payout_verified) {
    const after = await balance();
    if (BigInt(after) - BigInt(String(details.balance_before)) !== principal)
      throw new Error('Public API loan payout amount mismatch');
    await setup.execute();
    if ((await balance()) !== after)
      throw new Error('Public API payout replay changed the token balance');
    details.payout_verified = {
      amount_atomic: principal.toString(),
      balance_after: after,
    };
    await release.save();
  }
  if (
    d.near.settlement_token === NEAR_TESTNET_USDC &&
    chain_ids.includes('near')
  )
    await verify_usdc_refund(release, d, await loan.record());
  const repay =
    (await previous(key_for('repay'))) ??
    (await loan.repay({
      review: await loan.repayment.review({
        mode: 'direct',
        amount_atomic: (principal * 2n).toString(),
      }),
      idempotency_key: key_for('repay'),
    }));
  const repayment = await complete(repay);
  if ((await loan.summary()).debt_atomic !== '0')
    throw new Error('Public API loan debt did not clear');
  const released = [];
  for (const leg of funded.plan.offer.legs) {
    const key = key_for(`release-${leg.leg_id}`);
    const operation =
      (await previous(key)) ??
      (await loan.collateral.release({
        leg_id: leg.leg_id,
        idempotency_key: key,
      }));
    released.push(await complete(operation));
  }
  const record = await loan.record(),
    summary = await loan.summary();
  if (
    !summary.custody_resolved ||
    record.locks.some(
      (l) => l.locked_atomic !== '0' || l.reserved_atomic !== '0',
    )
  )
    throw new Error('Public API collateral release did not complete');
  const evidence = {
    deployment_id: d.deployment_id,
    settlement_token: d.near.settlement_token,
    collateral_chains: chain_ids,
    api_url,
    owner,
    loan_id,
    setup: funded,
    repayment,
    release: released,
    loan: record,
    summary,
    payout: details.payout_verified,
    verified_at: new Date().toISOString(),
  };
  details.complete = evidence;
  await release.save();
  client.session.disconnect();
  console.log(
    'Live public-pool SDK/API/worker borrowing, repayment and release verified',
  );
}

export async function verify_settlement(release: Release) {
  const d = deployment.parse(
    JSON.parse(
      await readFile(
        join(release.folder, '..', 'deployments/testnet.json'),
        'utf8',
      ),
    ),
  );
  if (d.near.settlement_token !== NEAR_TESTNET_USDC)
    throw new Error('Migrate to Circle USDC before verification');
  const owner = await near_signer(release, 'owner'),
    attempt = Date.now();
  try {
    await near_send(
      release,
      `circle-verification-open-${attempt}`,
      owner,
      d.near.coordinator,
      [
        call('set_pause_flags', {
          flags: {
            origination: false,
            collateral_withdrawals: false,
            settlements: false,
          },
        }),
      ],
    );
    process.env.LIVE_CHAIN ??= 'near,bnb,sui';
    await verify_api_lifecycle(release);
    await verify_liquidity(release, d);
  } finally {
    await near_send(
      release,
      `circle-verification-close-${attempt}`,
      owner,
      d.near.coordinator,
      [
        call('set_pause_flags', {
          flags: {
            origination: true,
            collateral_withdrawals: false,
            settlements: false,
          },
        }),
      ],
    );
  }
}
