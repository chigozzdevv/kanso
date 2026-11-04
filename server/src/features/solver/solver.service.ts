import { KansoError, settlement_plan, mul_div_floor } from '@kanso/schema';
import type {
  Deployment,
  SettlementPlan,
  Loan,
  RepaymentEstimate,
  RepaymentEstimateInput,
} from '@kanso/schema';
import {
  scoped_id,
  coordinator_transaction,
  token_transaction,
  from_hex,
} from '@kanso/sdk';
import type { CoordinatorClient } from '@kanso/sdk';
import type { NearSigner } from '@server/shared/near/coordinator.client';
import { repayment_input } from '@server/features/solver/repayment-input';
import type { PricedAsset } from '@server/features/risk/risk.service';
import type { RiskService } from '@server/features/risk/risk.service';
export class SolverService {
  constructor(
    private readonly d: Deployment,
    private readonly near: CoordinatorClient,
    readonly signer: NearSigner | undefined,
    private readonly risk: RiskService,
    private readonly recipients: Record<string, string> = {},
    readonly fee_bps = 0,
  ) {}
  async quote(input: {
    loan_id: string;
    leg_id: string;
    input_atomic: string;
    max_execution_cost_atomic: string;
    kind?: SettlementPlan['kind'];
    conditional_version?: number;
  }): Promise<SettlementPlan> {
    if (!this.signer)
      throw new KansoError(
        'CAPABILITY_DISABLED',
        'Internal testnet solver is not configured',
      );
    const loan = await this.near.view('get_loan', { loan_id: input.loan_id });
    const lock = loan.locks.find((l) => l.leg.leg_id === input.leg_id);
    if (!lock?.accepted)
      throw new KansoError(
        'LOCK_NOT_VERIFIED',
        'Settlement input has not been accepted',
      );
    if (
      BigInt(input.input_atomic) >
      BigInt(lock.locked_atomic) - BigInt(lock.reserved_atomic)
    )
      throw new KansoError(
        'INSUFFICIENT_BALANCE',
        'Settlement input is already reserved',
      );
    const pricing = await this.pricing(lock.leg);
    const { output, cost } = pricing.convert(BigInt(input.input_atomic));
    await this.check(
      loan,
      output,
      cost,
      BigInt(input.max_execution_cost_atomic),
    );
    const now = await this.near.now();
    const fields = {
      loan_id: input.loan_id,
      expected_revision: loan.revision,
      leg_id: input.leg_id,
      input_atomic: input.input_atomic,
      net_output_atomic: output.toString(),
      execution_cost_atomic: cost.toString(),
      max_source_fee_atomic: pricing.source_fee.toString(),
      solver: this.signer.account.accountId,
      source_recipient: this.signer.account.accountId,
      remote_recipient: pricing.remote_recipient,
      expires_at: now + 120,
      kind: input.kind ?? 'repayment',
      conditional_version: input.conditional_version ?? 0,
    };
    return settlement_plan.parse({
      operation_id: scoped_id(
        'solver-quote',
        this.d.deployment_id,
        JSON.stringify(fields),
      ),
      ...fields,
    });
  }
  async estimate(
    loan: Loan,
    input: RepaymentEstimateInput,
  ): Promise<RepaymentEstimate> {
    const lock =
      'leg_id' in input
        ? loan.locks.find((l) => l.leg.leg_id === input.leg_id)
        : undefined;
    const chain =
      'asset_id' in input
        ? this.d.chains.find((c) => c.manifest.asset_id === input.asset_id)
        : undefined;
    if (
      ('leg_id' in input && !lock) ||
      ('asset_id' in input && input.asset_id !== 'near' && !chain)
    )
      throw new KansoError('NOT_FOUND', 'Repayment asset not found');
    const source: PricedAsset =
      lock?.leg ??
      (chain
        ? {
            asset_id: chain.manifest.asset_id,
            custody: {
              family: 'remote',
              chain_id: chain.manifest.chain_id,
              manifest_version: chain.manifest.version,
            },
          }
        : { asset_id: 'near', custody: { family: 'near' } });
    const pricing = await this.pricing(source);
    const maximum = lock
      ? BigInt(lock.locked_atomic) - BigInt(lock.reserved_atomic)
      : chain
        ? BigInt(chain.manifest.max_collateral_atomic)
        : (1n << 128n) - 1n;
    const amount = repayment_input(
      BigInt(input.amount_atomic),
      maximum,
      (n) => pricing.convert(n).output,
    );
    const { output, cost } = pricing.convert(amount);
    await this.check(
      loan,
      output,
      cost,
      BigInt(loan.policy.max_execution_cost_atomic),
    );
    return {
      mode: input.mode,
      loan_id: loan.offer.offer_id,
      leg_id: lock?.leg.leg_id ?? null,
      asset_id: source.asset_id,
      chain_id:
        source.custody.family === 'near' ? 'near' : source.custody.chain_id,
      decimals: this.risk.decimals(source),
      amount_atomic: input.amount_atomic,
      input_atomic: amount.toString(),
      net_output_atomic: output.toString(),
      execution_cost_atomic: cost.toString(),
      max_source_fee_atomic: pricing.source_fee.toString(),
      expires_at: (await this.near.now()) + 120,
    };
  }
  private async pricing(source: PricedAsset) {
    if (!this.signer)
      throw new KansoError(
        'CAPABILITY_DISABLED',
        'Internal testnet solver is not configured',
      );
    const prices = await this.risk.prices([source]);
    const price = prices.get(source.asset_id)!;
    let source_fee = 0n;
    let remote_recipient: number[] = [];
    if (source.custody.family === 'remote') {
      const custody = source.custody;
      const chain = this.d.chains.find(
        (c) => c.manifest.chain_id === custody.chain_id,
      );
      const recipient = chain && this.recipients[chain.manifest.chain_id];
      if (!chain || !recipient || !chain.evidence)
        throw new KansoError(
          'CAPABILITY_DISABLED',
          'No funded solver destination is configured for this source chain',
        );
      remote_recipient = Array.from(from_hex(recipient));
      if (chain.manifest.family === 'bitcoin')
        source_fee = BigInt(chain.manifest.max_network_cost_atomic);
    }
    const source_fee_value = this.risk.value(source, source_fee, price);
    return {
      source_fee,
      remote_recipient,
      convert: (amount: bigint) => {
        const fair = this.risk.value(source, amount, price);
        const cost =
          mul_div_floor(fair, BigInt(this.fee_bps), 10000n) + source_fee_value;
        return { output: fair - cost, cost };
      },
    };
  }
  private async check(
    loan: Loan,
    output: bigint,
    cost: bigint,
    budget: bigint,
  ) {
    if (
      output <= 0n ||
      cost > budget ||
      cost > BigInt(loan.policy.max_execution_cost_atomic) ||
      this.fee_bps > loan.policy.max_execution_cost_bps
    )
      throw new KansoError(
        'BUDGET_EXHAUSTED',
        'Execution costs exceed the reviewed limit',
      );
    const inventory = await this.near.rpc.near_view<string>(
      this.d.near.settlement_token,
      'ft_balance_of',
      { account_id: this.signer!.account.accountId },
    );
    if (BigInt(inventory) < output)
      throw new KansoError(
        'INSUFFICIENT_BALANCE',
        'Solver has insufficient funded USDC inventory',
      );
  }
  async quote_on_chain(plan: SettlementPlan) {
    if (!this.signer || plan.solver !== this.signer.account.accountId)
      throw new KansoError(
        'CAPABILITY_DISABLED',
        'This solver cannot fund the selected quote',
      );
    const now = await this.near.now();
    if (plan.expires_at <= now || plan.expires_at > now + 120)
      throw new KansoError(
        'OFFER_EXPIRED',
        'Solver quote expired or has an invalid deadline',
      );
    const checked = await this.quote({
      loan_id: plan.loan_id,
      leg_id: plan.leg_id,
      input_atomic: plan.input_atomic,
      max_execution_cost_atomic: plan.execution_cost_atomic,
      kind: plan.kind,
      conditional_version: plan.conditional_version,
    });
    if (
      checked.expected_revision !== plan.expected_revision ||
      plan.net_output_atomic !== checked.net_output_atomic ||
      checked.execution_cost_atomic !== plan.execution_cost_atomic ||
      checked.max_source_fee_atomic !== plan.max_source_fee_atomic ||
      checked.source_recipient !== plan.source_recipient ||
      JSON.stringify(checked.remote_recipient) !==
        JSON.stringify(plan.remote_recipient)
    )
      throw new KansoError(
        'INVALID_INPUT',
        'Solver quote differs from funded inventory and approved execution terms',
      );
    const { operation_id, ...fields } = plan;
    if (
      operation_id !==
      scoped_id('solver-quote', this.d.deployment_id, JSON.stringify(fields))
    )
      throw new KansoError(
        'INVALID_INPUT',
        'Solver quote identity was changed',
      );
    await this.signer.send(
      coordinator_transaction(this.d, plan.solver, 'quote_settlement', {
        plan,
      }),
      scoped_id('solver-quote', plan.operation_id),
    );
  }
  async fund(plan: SettlementPlan) {
    if (!this.signer || plan.solver !== this.signer.account.accountId)
      throw new KansoError(
        'CAPABILITY_DISABLED',
        'This solver cannot fund the selected quote',
      );
    await this.signer.send(
      token_transaction(this.d, plan.solver, plan.net_output_atomic, {
        kind: 'solver_escrow',
        operation_id: plan.operation_id,
      }),
      scoped_id('solver-fund', plan.operation_id),
    );
  }
  async refund_cancelled(plan: SettlementPlan) {
    if (!this.signer || plan.solver !== this.signer.account.accountId) return;
    const settlement = await this.near.view('get_settlement', {
      operation_id: plan.operation_id,
    });
    if (settlement?.state !== 'cancelled' || !settlement.refund_id) return;
    const refund = await this.near.view('get_refund', {
      refund_id: settlement.refund_id,
    });
    if (!refund || refund.paid || refund.transfer_id) return;
    await this.signer.send(
      coordinator_transaction(this.d, plan.solver, 'claim_refund', {
        refund_id: refund.refund_id,
        transfer_id: scoped_id('solver-refund', plan.operation_id),
      }),
      scoped_id('solver-refund', plan.operation_id),
    );
  }
  async cancel_expired(plan: SettlementPlan) {
    if (!this.signer || plan.solver !== this.signer.account.accountId) return;
    const settlement = await this.near.view('get_settlement', {
      operation_id: plan.operation_id,
    });
    if (
      settlement &&
      ['quoted', 'funded'].includes(settlement.state) &&
      (await this.near.now()) >= plan.expires_at
    )
      await this.signer.send(
        coordinator_transaction(this.d, plan.solver, 'cancel_settlement', {
          operation_id: plan.operation_id,
        }),
        scoped_id('solver-cancel', plan.operation_id),
      );
    await this.refund_cancelled(plan);
  }
}
