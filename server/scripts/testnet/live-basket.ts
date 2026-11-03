import type { Loan, Offer, RemoteOperation } from '@kanso/schema';
import { evm_deposit, sui_deposit } from '@kanso/sdk';
import { ReadMpcClient } from '@server/shared/near/read-mpc.client';
import { digest } from '@testnet/deployment';
import type { Release } from '@testnet/deployment';
import { near_signer, near_send, near_view, call } from '@testnet/deploy-near';
import { live_plan } from '@testnet/live-setup';
import { attest_live, refresh_prices, risk_window } from '@testnet/live-loans';
import { send_source } from '@testnet/live-wallets';
import { finalize_live } from '@testnet/live-settlement';
import { execute_outgoing } from '@testnet/live-outgoing';
import { read_json } from '@testnet/store';

export async function verify_basket(release: Release) {
  if (!release.journal.contracts.plan) {
    const primary = await read_json<{ contracts: { plan: unknown } }>(
      release.folder,
      'deployment-verification.json',
    );
    release.journal.contracts.plan = primary.contracts.plan;
    await release.save();
  }
  const plan = await live_plan(release),
    d = plan.deployment;
  const borrower = await near_signer(release, 'borrower');
  const loan_id = 'live_three_chain_basket_v1';
  let offer = release.journal.contracts.basket_offer as Offer | undefined;
  if (!offer) {
    await refresh_prices();
    const legs = [];
    for (const chain of ['near', 'bnb', 'sui']) {
      const leg = structuredClone(
        plan.offers.find((o) => o.offer_id === `live_${chain}_repay_v1`)!
          .legs[0]!,
      );
      const c = d.chains.find((c) => c.manifest.chain_id === chain);
      const price = await near_view<{
        price_atomic: string;
        confidence_bps: number;
      }>(d.near.coordinator, 'get_asset_price', { asset_id: leg.asset_id });
      const conservative =
        (BigInt(price.price_atomic) * BigInt(10000 - price.confidence_bps)) /
        10000n;
      const scale = 10n ** BigInt(c?.manifest.decimals ?? 24);
      leg.amount_atomic = (
        (20000n * scale + conservative - 1n) /
        conservative
      ).toString();
      if (leg.custody.family === 'remote')
        leg.custody.lock_id = Array.from(
          Buffer.from(digest(`${loan_id}:${chain}`), 'hex'),
        );
      legs.push(leg);
    }
    const now = Math.floor(Date.now() / 1000);
    offer = {
      ...plan.offers[0]!,
      offer_id: loan_id,
      principal_atomic: '10000',
      duration_seconds: 86400,
      expires_at: now + 3600,
      setup_deadline: now + 86000,
      legs,
    };
    release.journal.contracts.basket_offer = offer;
    await release.save();
  }
  let loan = await near_view<Loan>(d.near.coordinator, 'get_loan', {
    loan_id,
  }).catch((error) => {
    if (error instanceof Error && error.message.includes('LOAN_NOT_FOUND'))
      return null;
    throw error;
  });
  if (!loan) {
    await refresh_prices();
    await risk_window(release, 'basket-accept', () =>
      near_send(release, 'basket-accept', borrower, d.near.coordinator, [
        call('accept_offer', { offer }),
      ]),
    );
    loan = await near_view<Loan>(d.near.coordinator, 'get_loan', { loan_id });
  }
  if (loan.state === 'pending_funding') {
    const snapshot = loan;
    await Promise.all(
      snapshot.locks.map(async (lock) => {
        const leg = lock.leg,
          id = `basket-deposit-${leg.leg_id}`;
        if (
          lock.receipt_verified ||
          release.journal.effects[id]?.state === 'confirmed'
        )
          return;
        if (leg.custody.family === 'near') {
          await near_send(release, id, borrower, d.near.coordinator, [
            call(
              'lock_native',
              { loan_id, leg_id: leg.leg_id },
              BigInt(leg.amount_atomic),
            ),
          ]);
        } else {
          const c = d.chains.find((c) => c.manifest.chain_id === leg.leg_id)!;
          const action =
            c.manifest.family === 'evm'
              ? await evm_deposit(c, leg, lock.agreement, 0)
              : await sui_deposit(c, leg, lock.agreement, 0);
          await send_source(release, id, action);
        }
      }),
    );
    const reader = new ReadMpcClient(d, undefined, '1');
    for (const leg_id of ['bnb', 'sui']) {
      loan = await near_view<Loan>(d.near.coordinator, 'get_loan', { loan_id });
      const lock = loan.locks.find((l) => l.leg.leg_id === leg_id)!;
      if (!lock.receipt_verified) {
        const c = d.chains.find((c) => c.manifest.chain_id === leg_id)!;
        if (lock.leg.custody.family !== 'remote')
          throw new Error('Remote custody required');
        const observation = await reader.observe(
          c,
          release.journal.effects[`basket-deposit-${leg_id}`]!.transaction_id,
          'LockAccepted',
          lock.leg.custody.lock_id,
        );
        const proof = await attest_live(release, c, observation);
        await near_send(
          release,
          `basket-proof-${leg_id}`,
          await near_signer(release, 'relayer'),
          d.near.coordinator,
          [call('submit_remote_lock', { loan_id, leg_id, proof })],
        );
      }
      if (leg_id === 'bnb' && !release.journal.contracts.funding_barrier) {
        await risk_window(release, 'basket-barrier', async () => {
          try {
            await near_send(
              release,
              'basket-barrier',
              borrower,
              d.near.coordinator,
              [
                call('fund_loan', {
                  loan_id,
                  transfer_id: 'fund_three_chain_basket',
                }),
              ],
            );
          } catch (error) {
            if (
              !JSON.stringify(
                release.journal.effects['basket-barrier']?.result,
              ).includes('LOCK_NOT_VERIFIED')
            )
              throw error;
          }
          const failed = release.journal.effects['basket-barrier']!;
          if (
            failed.state !== 'failed' ||
            !JSON.stringify(failed.result).includes('LOCK_NOT_VERIFIED')
          )
            throw new Error('Partial basket funded unexpectedly');
          release.journal.contracts.funding_barrier = {
            transaction_id: failed.transaction_id,
            expected_error: 'LOCK_NOT_VERIFIED',
            verified_at: new Date().toISOString(),
          };
          await release.save();
        });
      }
    }
    loan = await near_view<Loan>(d.near.coordinator, 'get_loan', { loan_id });
    if (!loan.locks.every((l) => l.accepted))
      throw new Error('Three-chain basket locks are not all accepted');
    const balance_before =
      (release.journal.contracts.basket_balance_before as string | undefined) ??
      (await near_view<string>(d.near.settlement_token, 'ft_balance_of', {
        account_id: borrower.accountId,
      }));
    release.journal.contracts.basket_balance_before = balance_before;
    await release.save();
    await refresh_prices();
    await risk_window(release, 'basket-fund', () =>
      near_send(release, 'basket-fund', borrower, d.near.coordinator, [
        call('fund_loan', { loan_id, transfer_id: 'fund_three_chain_basket' }),
      ]),
    );
    await finalize_live(release, 'fund_three_chain_basket');
    const balance_after = await near_view<string>(
      d.near.settlement_token,
      'ft_balance_of',
      { account_id: borrower.accountId },
    );
    if (BigInt(balance_after) - BigInt(balance_before) !== 10000n)
      throw new Error('Basket payout amount mismatch');
    await near_send(
      release,
      'basket-fund-replay',
      borrower,
      d.near.coordinator,
      [call('fund_loan', { loan_id, transfer_id: 'fund_three_chain_basket' })],
    );
    if (
      (await near_view<string>(d.near.settlement_token, 'ft_balance_of', {
        account_id: borrower.accountId,
      })) !== balance_after
    )
      throw new Error('Duplicate basket payout');
    release.journal.contracts.exactly_once_funding = {
      amount_atomic: '10000',
      balance_before,
      balance_after,
      replay_transaction:
        release.journal.effects['basket-fund-replay']!.transaction_id,
    };
    await release.save();
  }
  loan = await near_view<Loan>(d.near.coordinator, 'get_loan', { loan_id });
  if (loan.state === 'active') {
    await near_send(
      release,
      'basket-repay',
      borrower,
      d.near.settlement_token,
      [
        call('ft_transfer_call', {
          receiver_id: d.near.coordinator,
          amount: '11000',
          msg: JSON.stringify({
            kind: 'repayment',
            loan_id,
            operation_id: 'repay_three_chain_basket',
          }),
        }),
      ],
    );
  }
  loan = await near_view<Loan>(d.near.coordinator, 'get_loan', { loan_id });
  if (loan.state !== 'repaid') throw new Error('Basket debt did not clear');
  for (const lock of loan.locks) {
    const leg = lock.leg;
    if (lock.locked_atomic === '0') continue;
    const operation_id = `basket_release_${leg.leg_id}`;
    if (leg.custody.family === 'near') {
      await near_send(release, operation_id, borrower, d.near.coordinator, [
        call('release_collateral', {
          loan_id,
          leg_id: leg.leg_id,
          transfer_id: operation_id,
        }),
      ]);
      await finalize_live(release, operation_id);
    } else {
      const c = d.chains.find((c) => c.manifest.chain_id === leg.leg_id)!;
      const existing = await near_view<RemoteOperation | null>(
        d.near.coordinator,
        'get_remote_operation',
        { operation_id },
      );
      if (!existing) {
        const current = await near_view<Loan>(d.near.coordinator, 'get_loan', {
          loan_id,
        });
        const deferred = release.journal.effects[operation_id];
        const retry =
          deferred?.state === 'failed' &&
          JSON.stringify(deferred.result).includes('OUTFLOW_UNRESOLVED');
        if (retry) {
          release.journal.contracts.outflow_serialization = {
            rejected_transaction: deferred.transaction_id,
            expected_error: 'OUTFLOW_UNRESOLVED',
          };
          await release.save();
        }
        await near_send(
          release,
          retry ? `${operation_id}-retry-1` : operation_id,
          borrower,
          d.near.coordinator,
          [
            call('prepare_remote_release', {
              operation_id,
              loan_id,
              leg_id: leg.leg_id,
              amount_atomic: lock.locked_atomic,
              expected_revision: String(current.revision),
              deadline: Math.floor(Date.now() / 1000) + 7200,
            }),
          ],
        );
      }
      if (!(await execute_outgoing(release, c, operation_id, 'borrower')))
        return false;
    }
  }
  const complete = await near_view<Loan>(d.near.coordinator, 'get_loan', {
    loan_id,
  });
  if (complete.locks.some((l) => l.locked_atomic !== '0')) return false;
  release.journal.contracts.complete = {
    loan_id,
    chains: ['near', 'bnb', 'sui'],
    debt_state: complete.state,
    all_collateral_released: true,
    verified_at: new Date().toISOString(),
  };
  await release.save();
  console.log(
    'Three-chain basket: funding barrier, exactly-once payout, repayment and collateral release verified',
  );
  return true;
}
