import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Loan, LoanSummary, Settlement } from '@kanso/schema';
import { confirmed_effect_id, Release } from '@testnet/deployment';
import { read_json } from '@testnet/store';
import { near_view } from '@testnet/deploy-near';
import { rpc } from '@testnet/network';
import type { LivePlan } from '@testnet/live-setup';

export async function live_report() {
  const release = await Release.load('deployment-verification.json');
  const plan = release.journal.contracts.plan as LivePlan;
  const d = plan.deployment;
  const security = await read_json<{ contracts: Record<string, unknown> }>(
    release.folder,
    'deployment-security.json',
  );
  const effects = release.journal.effects;
  const runtime = JSON.parse(
    await readFile(
      join(release.folder, '..', 'deployments/testnet.json'),
      'utf8',
    ),
  ) as LivePlan['deployment'];
  const tx = (id: string) =>
    effects[confirmed_effect_id(effects, id) ?? id]?.transaction_id ?? null;
  function incoming_attempts(transaction_id: string | null) {
    if (!transaction_id) return [];
    return Object.entries(effects).flatMap(([id, effect]) => {
      if (!id.startsWith('attest-')) return [];
      try {
        const receipt = effect.result as {
          transaction: { actions: { FunctionCall: { args: string } }[] };
        };
        const args = JSON.parse(
          Buffer.from(
            receipt.transaction.actions[0]!.FunctionCall.args,
            'base64',
          ).toString(),
        );
        const request = args.payload.V1.request as Record<
          string,
          { tx_id: string }
        >;
        if (
          !Object.values(request).some(
            (r) => r.tx_id === transaction_id.replace(/^0x/, ''),
          )
        )
          return [];
        return [
          {
            transaction_id: effect.transaction_id,
            state: effect.state,
            request_timed_out: JSON.stringify(effect.result).includes(
              'Request has timed out.',
            ),
          },
        ];
      } catch {
        return [];
      }
    });
  }
  const chains = [];
  for (const chain_id of [
    'near',
    ...d.chains.map((c) => c.manifest.chain_id),
  ]) {
    const c = d.chains.find((c) => c.manifest.chain_id === chain_id);
    const cases = [];
    for (const kind of ['repay', 'liquidate']) {
      const loan_id = `live_${chain_id}_${kind}_v1`;
      const loan = await near_view<Loan>(d.near.coordinator, 'get_loan', {
        loan_id,
      });
      const summary = await near_view<LoanSummary>(
        d.near.coordinator,
        'loan_summary',
        { loan_id },
      );
      const sale = await near_view<Settlement | null>(
        d.near.coordinator,
        'get_settlement',
        { operation_id: `sale_${loan_id}` },
      );
      cases.push({
        kind,
        loan_id,
        principal_atomic: loan.offer.principal_atomic,
        collateral: loan.locks.map((l) => ({
          asset_id: l.leg.asset_id,
          amount_atomic: l.leg.amount_atomic,
          locked_atomic: l.locked_atomic,
          reserved_atomic: l.reserved_atomic,
          receipt_verified: l.receipt_verified,
          remote_nonce: l.remote_nonce,
        })),
        debt_state: loan.state,
        setup_state: loan.setup_state,
        debt_atomic: summary.debt_atomic,
        custody_resolved: summary.custody_resolved,
        pending_lock_verification: lock_pending(loan)
          ? (release.journal.contracts[`pending-${loan_id}`] ?? null)
          : null,
        source_finality:
          chain_id === 'starknet' && tx(`deposit-${loan_id}`)
            ? await rpc<Record<string, unknown>>(
                c!.rpc_url,
                'starknet_getTransactionReceipt',
                { transaction_hash: tx(`deposit-${loan_id}`) },
              ).then((r) => ({
                finality_status: r.finality_status,
                execution_status: r.execution_status,
                block_number: r.block_number,
              }))
            : null,
        source_delivery_finality:
          chain_id === 'starknet' && tx(`outgoing-delivery_${loan_id}`)
            ? await rpc<Record<string, unknown>>(
                c!.rpc_url,
                'starknet_getTransactionReceipt',
                {
                  transaction_hash: tx(`outgoing-delivery_${loan_id}`),
                },
              ).then((r) => ({
                finality_status: r.finality_status,
                execution_status: r.execution_status,
                block_number: r.block_number,
              }))
            : null,
        sale_state: sale?.state ?? null,
        sale_applied_atomic: sale?.applied_atomic ?? null,
        transactions: {
          deposit: tx(`deposit-${loan_id}`),
          accepted_lock: tx(`verify-${loan_id}`),
          disbursement: tx(
            confirmed_effect_id(effects, `fund-${loan_id}`) ??
              `fund-${loan_id}`,
          ),
          disbursement_finalization: tx(`finalize-fund-${loan_id}`),
          source_sale: tx(`outgoing-delivery_${loan_id}`),
          source_sale_proof: tx(`deliver-delivery_${loan_id}`),
          settlement_applied: tx(`apply-${loan_id}`),
          direct_repayment: tx(`repay-${loan_id}`),
          release_preparation: tx(`release-${loan_id}`),
          source_release: tx(`outgoing-release_${loan_id}`),
          source_release_proof: tx(`deliver-release_${loan_id}`),
          incoming_attestation_attempts: incoming_attempts(
            tx(`deposit-${loan_id}`),
          ),
        },
      });
    }
    chains.push({
      chain_id,
      family: c?.manifest.family ?? 'near',
      network_fingerprint: c?.manifest.network_fingerprint ?? 'testnet',
      manifest: c?.manifest ?? null,
      authority_check: security.contracts[chain_id] ?? null,
      positive_lifecycle_complete: cases.every(
        (c) =>
          c.debt_state === 'repaid' &&
          c.debt_atomic === '0' &&
          c.custody_resolved &&
          c.collateral.every(
            (l) =>
              l.receipt_verified &&
              l.locked_atomic === '0' &&
              l.reserved_atomic === '0',
          ),
      ),
      cases,
    });
  }
  const report = {
    deployment_id: d.deployment_id,
    network: 'testnet',
    checked_at: new Date().toISOString(),
    coordinator: d.near.coordinator,
    settlement_token: d.near.settlement_token,
    settlement_provider: 'internal_testnet_solver',
    settlement_decimals: 6,
    pause_flags: await near_view(d.near.coordinator, 'get_pause_flags'),
    verified_remote_capabilities: runtime.chains
      .filter((c) => c.evidence && c.manifest.new_locks_enabled)
      .map((c) => c.manifest.chain_id),
    disabled_remote_capabilities: runtime.chains
      .filter((c) => !c.evidence || !c.manifest.new_locks_enabled)
      .map((c) => c.manifest.chain_id),
    pool: await near_view(d.near.coordinator, 'get_pool', {
      pool_id: 'live-verification',
    }),
    chains,
    accounting: release.journal.contracts.accounting ?? null,
    governance: release.journal.contracts.pool_governance ?? null,
  };
  console.log(JSON.stringify(report, null, 2));
}

function lock_pending(loan: Loan) {
  return loan.locks.some((l) => !l.receipt_verified);
}
