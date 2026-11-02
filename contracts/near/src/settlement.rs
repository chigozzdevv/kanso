use crate::{
    config::valid_id,
    events, math,
    state::{LoanState, Transfer, TransferKind},
    Coordinator, CoordinatorExt,
};
use near_sdk::{env, json_types::U128, near, serde_json::json, AccountId};

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SettlementKind {
    Repayment,
    Conditional,
    Liquidation,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct SettlementPlan {
    pub operation_id: String,
    pub loan_id: String,
    pub expected_revision: String,
    pub leg_id: String,
    pub input_atomic: U128,
    pub net_output_atomic: U128,
    pub execution_cost_atomic: U128,
    pub max_source_fee_atomic: U128,
    pub solver: AccountId,
    pub source_recipient: AccountId,
    pub remote_recipient: Vec<u8>,
    pub expires_at: u64,
    pub kind: SettlementKind,
    pub conditional_version: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SettlementState {
    Quoted,
    Funded,
    Committed,
    Delivered,
    Applied,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Settlement {
    pub plan: SettlementPlan,
    pub state: SettlementState,
    pub escrow_atomic: U128,
    pub applied_atomic: U128,
    pub refund_id: Option<String>,
    pub source_spent_atomic: U128,
    pub actual_cost_atomic: U128,
    pub reserved_source_fee_value_atomic: U128,
    pub transfer_id: Option<String>,
    pub revision: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Refund {
    pub refund_id: String,
    pub owner: AccountId,
    pub amount_atomic: U128,
    pub transfer_id: Option<String>,
    pub paid: bool,
}

#[near]
impl Coordinator {
    #[payable]
    pub fn quote_settlement(&mut self, plan: SettlementPlan) -> Settlement {
        Self::one_yocto();
        valid_id(&plan.operation_id);
        assert_eq!(
            env::predecessor_account_id(),
            plan.solver,
            "SOLVER_REQUIRED"
        );
        assert_ne!(
            plan.source_recipient,
            env::current_account_id(),
            "INVALID_RECIPIENT"
        );
        if let Some(existing) = self.settlements.get(&plan.operation_id) {
            assert_eq!(existing.plan, plan, "IDEMPOTENCY_CONFLICT");
            return existing;
        }
        assert!(
            plan.expires_at > Self::now()
                && plan.input_atomic.0 > 0
                && plan.net_output_atomic.0 > 0,
            "INVALID_QUOTE"
        );
        self.loan(&plan.loan_id);
        let before = env::storage_usage();
        let settlement = Settlement {
            plan,
            state: SettlementState::Quoted,
            escrow_atomic: U128(0),
            applied_atomic: U128(0),
            refund_id: None,
            source_spent_atomic: U128(0),
            actual_cost_atomic: U128(0),
            reserved_source_fee_value_atomic: U128(0),
            transfer_id: None,
            revision: 1,
        };
        self.settlements
            .insert(&settlement.plan.operation_id, &settlement);
        self.charge_storage(&settlement.plan.solver, before);
        settlement
    }

    #[payable]
    pub fn commit_settlement(&mut self, operation_id: String, transfer_id: String) -> Settlement {
        Self::one_yocto();
        let mut settlement = self.settlement(&operation_id);
        if matches!(
            settlement.state,
            SettlementState::Committed | SettlementState::Delivered | SettlementState::Applied
        ) {
            assert_eq!(
                settlement.transfer_id.as_ref(),
                Some(&transfer_id),
                "IDEMPOTENCY_CONFLICT"
            );
            return settlement;
        }
        assert!(!self.controls.settlements, "SETTLEMENTS_PAUSED");
        assert_eq!(
            settlement.state,
            SettlementState::Funded,
            "ESCROW_NOT_FUNDED"
        );
        assert!(Self::now() < settlement.plan.expires_at, "QUOTE_EXPIRED");
        let plan = &settlement.plan;
        let mut loan = self.loan(&plan.loan_id);
        assert_eq!(loan.state, LoanState::Active, "LOAN_NOT_ACTIVE");
        assert_eq!(
            loan.revision.to_string(),
            plan.expected_revision,
            "BASKET_REVISION_CHANGED"
        );
        assert!(
            loan.active_outflow.is_none() || plan.kind == SettlementKind::Liquidation,
            "OUTFLOW_UNRESOLVED"
        );
        loan.accrue(Self::now());
        let risk = self.risk(&loan);
        let repayment = plan.net_output_atomic.0.min(loan.debt());
        let cost = plan.execution_cost_atomic.0;
        assert!(
            cost <= loan.policy.max_execution_cost_atomic.0
                && cost
                    <= math::mul_div_floor(
                        plan.net_output_atomic.0 + cost,
                        u128::from(loan.policy.max_execution_cost_bps),
                        10_000
                    ),
            "EXECUTION_COST_LIMIT"
        );
        let lock = loan
            .locks
            .iter_mut()
            .find(|l| l.leg.leg_id == plan.leg_id)
            .expect("LEG_NOT_FOUND");
        assert!(
            lock.accepted && lock.locked_atomic.0 - lock.reserved_atomic.0 >= plan.input_atomic.0,
            "COLLATERAL_UNAVAILABLE"
        );
        let source_leg = lock.leg.clone();
        let wallet_payer = match &lock.purpose {
            crate::state::LockPurpose::Collateral => None,
            crate::state::LockPurpose::Payment { payer, .. } => Some(payer.clone()),
        };
        let mut post_sale = loan.clone();
        post_sale
            .locks
            .iter_mut()
            .find(|l| l.leg.leg_id == plan.leg_id)
            .unwrap()
            .reserved_atomic
            .0 += plan.input_atomic.0;
        let pending_output = self.committed_settlement_output(&loan);
        let fair = self.leg_value(&source_leg, plan.input_atomic.0);
        assert!(
            plan.net_output_atomic.0 + cost
                >= math::mul_div_floor(
                    fair,
                    u128::from(10_000 - loan.policy.max_slippage_bps),
                    10_000
                ),
            "QUOTE_BELOW_ORACLE_BOUND"
        );
        let post_debt = loan.debt() - repayment;
        let post_value = self.basket_capacity(&post_sale, true) + pending_output.min(post_debt);
        let post_health = if post_debt == 0 {
            u128::MAX
        } else {
            math::mul_div_floor(post_value, 1_000_000, post_debt)
        };
        if let Some(payer) = &wallet_payer {
            assert_eq!(
                plan.kind,
                SettlementKind::Repayment,
                "WALLET_PAYMENT_IS_NOT_COLLATERAL"
            );
            assert_eq!(env::predecessor_account_id(), *payer, "PAYER_REQUIRED");
        }
        let before = env::storage_usage();
        match plan.kind {
            SettlementKind::Repayment => assert_eq!(
                env::predecessor_account_id(),
                wallet_payer
                    .clone()
                    .unwrap_or_else(|| loan.offer.borrower.clone()),
                "PAYER_REQUIRED"
            ),
            SettlementKind::Conditional => {
                let auth = self
                    .conditionals
                    .get(&plan.loan_id)
                    .expect("CONDITIONAL_NOT_CONFIGURED");
                assert!(
                    risk.health_ppm.0 > 1_000_000
                        && risk.health_ppm.0 <= u128::from(auth.terms.trigger_health_ppm),
                    "CONDITIONAL_NOT_TRIGGERED"
                );
                assert!(
                    post_health > risk.health_ppm.0
                        && post_health <= u128::from(auth.terms.target_health_ppm)
                        || post_debt == 0,
                    "INVALID_CONDITIONAL_REPAIR"
                );
                assert!(
                    plan.net_output_atomic.0 <= loan.debt(),
                    "REPAYMENT_EXCEEDS_DEBT"
                );
                self.reserve_conditional(
                    &plan.loan_id,
                    plan.conditional_version,
                    &source_leg.asset_id,
                    plan.input_atomic.0,
                    plan.net_output_atomic.0,
                    cost,
                );
            }
            SettlementKind::Liquidation => {
                assert!(
                    pending_output + plan.net_output_atomic.0
                        <= loan.debt() + loan.policy.max_liquidation_surplus_atomic.0,
                    "LIQUIDATION_REPAYMENT_LIMIT"
                );
                assert!(
                    risk.defaulted || risk.health_ppm.0 <= 1_000_000,
                    "NOT_LIQUIDATABLE"
                );
                assert!(
                    risk.defaulted
                        || post_debt == 0
                        || post_health >= u128::from(loan.policy.recovery_health_ppm),
                    "INVALID_POST_SALE_HEALTH"
                );
            }
        }
        assert!(
            self.transfers.get(&transfer_id).is_none()
                && self.remote_operations.get(&transfer_id).is_none(),
            "TRANSFER_EXISTS"
        );
        let mut bitcoin_spend = None;
        let remote = match &source_leg.custody {
            crate::state::Custody::Near => {
                assert!(
                    plan.remote_recipient.is_empty() && plan.max_source_fee_atomic.0 == 0,
                    "INVALID_NATIVE_RECIPIENT"
                );
                None
            }
            crate::state::Custody::Remote {
                chain_id,
                manifest_version,
                lock_id,
                ..
            } => {
                let manifest = self.get_chain_manifest(chain_id.clone(), Some(*manifest_version));
                if manifest.family == crate::manifest::ChainFamily::Bitcoin {
                    assert!(
                        plan.max_source_fee_atomic.0 > 0
                            && plan.max_source_fee_atomic.0 <= manifest.max_network_cost_atomic.0
                            && plan.input_atomic.0 > plan.max_source_fee_atomic.0,
                        "BITCOIN_FEE_LIMIT"
                    );
                    let fee_value = self.leg_value(&source_leg, plan.max_source_fee_atomic.0);
                    assert!(
                        fee_value <= plan.execution_cost_atomic.0,
                        "SOURCE_FEE_NOT_DISCLOSED"
                    );
                    let spend =
                        self.bitcoin_sale(plan, &loan, manifest.clone(), transfer_id.clone());
                    bitcoin_spend = Some(spend);
                    None
                } else {
                    assert_eq!(plan.max_source_fee_atomic.0, 0, "UNEXPECTED_SOURCE_FEE");
                    let width = if manifest.family == crate::manifest::ChainFamily::Evm {
                        20
                    } else {
                        32
                    };
                    assert!(
                        plan.remote_recipient.len() == width
                            && plan.remote_recipient.iter().any(|b| *b != 0),
                        "INVALID_REMOTE_RECIPIENT"
                    );
                    let lock = loan
                        .locks
                        .iter()
                        .find(|l| l.leg.leg_id == plan.leg_id)
                        .unwrap();
                    let command = crate::operation::SourceCommand {
                        operation_id: crate::mpc::commitment(
                            &manifest.family,
                            transfer_id.as_bytes(),
                        ),
                        lock_id: lock_id.clone(),
                        agreement: crate::collateral::remote::family_hash(
                            &manifest,
                            &lock.agreement,
                        ),
                        settlement_id: crate::mpc::commitment(
                            &manifest.family,
                            operation_id.as_bytes(),
                        ),
                        recipient: plan.remote_recipient.clone(),
                        amount_atomic: plan.input_atomic,
                        nonce: lock.remote_nonce,
                        deadline: plan.expires_at,
                        kind: 1,
                    };
                    Some(crate::operation::RemoteOperation {
                        operation_id: transfer_id.clone(),
                        settlement_id: Some(operation_id.clone()),
                        loan_id: loan.loan_id.clone(),
                        leg_id: plan.leg_id.clone(),
                        owner: plan.solver.clone(),
                        manifest,
                        command,
                        state: crate::operation::RemoteState::Prepared,
                        signing_attempts: vec![],
                        network_cost_reserved_atomic: U128(0),
                        revision: 1,
                    })
                }
            }
        };
        let transfer = if matches!(source_leg.custody, crate::state::Custody::Near) {
            Some(self.new_transfer(
                transfer_id.clone(),
                TransferKind::SettlementDelivery,
                plan.solver.clone(),
                operation_id.clone(),
                plan.leg_id.clone(),
                plan.source_recipient.clone(),
                plan.input_atomic,
            ))
        } else {
            None
        };
        loan.locks
            .iter_mut()
            .find(|l| l.leg.leg_id == plan.leg_id)
            .unwrap()
            .reserved_atomic
            .0 += plan.input_atomic.0;
        loan.track_outflow(operation_id.clone());
        loan.revision += 1;
        settlement.state = SettlementState::Committed;
        settlement.transfer_id = Some(transfer_id);
        settlement.revision += 1;
        if remote.is_none() && bitcoin_spend.is_none() {
            self.native_custody_total -= plan.input_atomic.0;
        }
        self.loans.insert(&loan.loan_id, &loan);
        if let Some(spend) = &bitcoin_spend {
            self.bitcoin_spends.insert(&spend.operation_id, spend);
            settlement.reserved_source_fee_value_atomic =
                U128(self.leg_value(&source_leg, plan.max_source_fee_atomic.0));
        }
        if let Some(operation) = &remote {
            self.remote_operations
                .insert(&operation.operation_id, operation);
        } else if let Some(transfer) = &transfer {
            self.transfers.insert(&transfer.transfer_id, transfer);
        }
        self.settlements.insert(&operation_id, &settlement);
        self.charge_storage(&env::predecessor_account_id(), before);
        events::emit(
            &self.config.deployment_id,
            if settlement.plan.kind == SettlementKind::Liquidation {
                "LiquidationCommitted"
            } else {
                "SettlementCommitted"
            },
            &operation_id,
            settlement.revision,
            json!({"operation_id": operation_id, "loan_id": loan.loan_id, "input_atomic": settlement.plan.input_atomic, "net_output_atomic": settlement.plan.net_output_atomic}),
        );
        if let Some(transfer) = &transfer {
            self.send_transfer(transfer, false);
        }
        settlement
    }

    pub fn apply_settlement(&mut self, operation_id: String) -> Settlement {
        let mut settlement = self.settlement(&operation_id);
        if settlement.state == SettlementState::Applied {
            return settlement;
        }
        assert_eq!(
            settlement.state,
            SettlementState::Delivered,
            "SOURCE_DELIVERY_UNVERIFIED"
        );
        let before = env::storage_usage();
        let plan = &settlement.plan;
        let used = self.apply_repayment(&plan.loan_id, settlement.escrow_atomic.0, &operation_id);
        let mut loan = self.loan(&plan.loan_id);
        assert!(loan.has_outflow(&operation_id), "OUTFLOW_IDENTITY_MISMATCH");
        if plan.kind == SettlementKind::Conditional {
            self.resolve_conditional(
                &plan.loan_id,
                &loan
                    .locks
                    .iter()
                    .find(|l| l.leg.leg_id == plan.leg_id)
                    .unwrap()
                    .leg
                    .asset_id,
                plan.input_atomic.0,
                plan.net_output_atomic.0,
                plan.execution_cost_atomic.0,
                Some((
                    settlement.source_spent_atomic.0,
                    used,
                    settlement.actual_cost_atomic.0,
                )),
            );
        }
        let source = loan
            .locks
            .iter()
            .find(|l| l.leg.leg_id == plan.leg_id)
            .unwrap();
        let surplus_owner = match &source.purpose {
            crate::state::LockPurpose::Collateral => loan.offer.borrower.clone(),
            crate::state::LockPurpose::Payment { payer, .. } => payer.clone(),
        };
        let surplus = settlement.escrow_atomic.0 - used;
        if surplus > 0 {
            settlement.refund_id =
                Some(self.create_refund(format!("surplus_{operation_id}"), surplus_owner, surplus));
        }
        self.escrow_total -= settlement.escrow_atomic.0;
        settlement.escrow_atomic = U128(0);
        settlement.applied_atomic = U128(used);
        settlement.state = SettlementState::Applied;
        settlement.revision += 1;
        loan.resolve_outflow(&operation_id);
        loan.revision += 1;
        self.loans.insert(&loan.loan_id, &loan);
        self.settlements.insert(&operation_id, &settlement);
        self.charge_storage(&settlement.plan.solver, before);
        settlement
    }

    #[payable]
    pub fn cancel_settlement(&mut self, operation_id: String) -> Settlement {
        Self::one_yocto();
        let mut settlement = self.settlement(&operation_id);
        assert!(
            env::predecessor_account_id() == settlement.plan.solver
                || Self::now() >= settlement.plan.expires_at,
            "SOLVER_REQUIRED"
        );
        if settlement.state == SettlementState::Cancelled {
            return settlement;
        }
        assert!(
            matches!(
                settlement.state,
                SettlementState::Quoted | SettlementState::Funded
            ),
            "COMMITTED_SPEND_UNRESOLVED"
        );
        let before = env::storage_usage();
        if settlement.escrow_atomic.0 > 0 {
            settlement.refund_id = Some(self.create_refund(
                format!("escrow_{operation_id}"),
                settlement.plan.solver.clone(),
                settlement.escrow_atomic.0,
            ));
            self.escrow_total -= settlement.escrow_atomic.0;
            settlement.escrow_atomic = U128(0);
        }
        settlement.state = SettlementState::Cancelled;
        settlement.revision += 1;
        self.settlements.insert(&operation_id, &settlement);
        self.charge_storage(&settlement.plan.solver, before);
        settlement
    }

    pub fn get_settlement(&self, operation_id: String) -> Option<Settlement> {
        self.settlements.get(&operation_id)
    }
    pub fn get_refund(&self, refund_id: String) -> Option<Refund> {
        self.refunds.get(&refund_id)
    }
    pub fn settlement_liabilities(&self) -> (U128, U128) {
        (U128(self.escrow_total), U128(self.refund_total))
    }

    #[payable]
    pub fn claim_refund(&mut self, refund_id: String, transfer_id: String) -> Transfer {
        Self::one_yocto();
        let mut refund = self.refunds.get(&refund_id).expect("REFUND_NOT_FOUND");
        assert_eq!(
            env::predecessor_account_id(),
            refund.owner,
            "REFUND_OWNER_REQUIRED"
        );
        if let Some(id) = &refund.transfer_id {
            assert_eq!(id, &transfer_id, "REFUND_COMMITTED");
            return self.transfers.get(id).unwrap();
        }
        assert!(!refund.paid, "REFUND_PAID");
        assert!(
            self.transfers.get(&transfer_id).is_none(),
            "TRANSFER_EXISTS"
        );
        let before = env::storage_usage();
        let transfer = self.new_transfer(
            transfer_id.clone(),
            TransferKind::Refund,
            refund.owner.clone(),
            refund_id.clone(),
            String::new(),
            refund.owner.clone(),
            refund.amount_atomic,
        );
        refund.transfer_id = Some(transfer_id);
        self.refunds.insert(&refund_id, &refund);
        self.transfers.insert(&transfer.transfer_id, &transfer);
        self.charge_storage(&refund.owner, before);
        self.send_transfer(&transfer, true);
        transfer
    }
}

impl Coordinator {
    pub(crate) fn settlement(&self, id: &str) -> Settlement {
        self.settlements
            .get(&id.to_owned())
            .expect("SETTLEMENT_NOT_FOUND")
    }

    pub(crate) fn fund_escrow(&mut self, id: &str, sender: &AccountId, amount: u128) -> u128 {
        let mut settlement = self.settlement(id);
        assert_eq!(&settlement.plan.solver, sender, "SOLVER_REQUIRED");
        assert_eq!(
            settlement.state,
            SettlementState::Quoted,
            "ESCROW_ALREADY_FUNDED"
        );
        assert!(Self::now() < settlement.plan.expires_at, "QUOTE_EXPIRED");
        assert_eq!(
            amount, settlement.plan.net_output_atomic.0,
            "INCORRECT_ESCROW_AMOUNT"
        );
        settlement.escrow_atomic = U128(amount);
        settlement.state = SettlementState::Funded;
        settlement.revision += 1;
        self.escrow_total += amount;
        self.settlements.insert(&id.to_owned(), &settlement);
        amount
    }

    pub(crate) fn finalize_settlement_delivery(&mut self, transfer: &Transfer, success: bool) {
        let mut settlement = self.settlement(&transfer.object_id);
        assert_eq!(
            settlement.state,
            SettlementState::Committed,
            "INVALID_SETTLEMENT_STATE"
        );
        let plan = &settlement.plan;
        let mut loan = self.loan(&plan.loan_id);
        let lock = loan
            .locks
            .iter_mut()
            .find(|l| l.leg.leg_id == plan.leg_id)
            .unwrap();
        lock.reserved_atomic.0 -= plan.input_atomic.0;
        if success {
            lock.locked_atomic.0 -= plan.input_atomic.0;
            settlement.state = SettlementState::Delivered;
            settlement.source_spent_atomic = settlement.plan.input_atomic;
            settlement.actual_cost_atomic = settlement.plan.execution_cost_atomic;
        } else {
            self.native_custody_total += plan.input_atomic.0;
            loan.resolve_outflow(&plan.operation_id);
            if plan.kind == SettlementKind::Conditional {
                self.resolve_conditional(
                    &plan.loan_id,
                    &loan
                        .locks
                        .iter()
                        .find(|l| l.leg.leg_id == plan.leg_id)
                        .unwrap()
                        .leg
                        .asset_id,
                    plan.input_atomic.0,
                    plan.net_output_atomic.0,
                    plan.execution_cost_atomic.0,
                    None,
                );
            }
            settlement.state = SettlementState::Funded;
            settlement.transfer_id = None;
        }
        loan.revision += 1;
        settlement.revision += 1;
        self.loans.insert(&loan.loan_id, &loan);
        self.settlements.insert(&plan.operation_id, &settlement);
    }

    pub(crate) fn create_refund(&mut self, id: String, owner: AccountId, amount: u128) -> String {
        let id = hex::encode(env::sha256(id.as_bytes()));
        assert!(self.refunds.get(&id).is_none(), "REFUND_EXISTS");
        self.refund_total += amount;
        self.refunds.insert(
            &id,
            &Refund {
                refund_id: id.clone(),
                owner: owner.clone(),
                amount_atomic: U128(amount),
                transfer_id: None,
                paid: false,
            },
        );
        events::emit(
            &self.config.deployment_id,
            "RefundCreated",
            &id,
            1,
            json!({"refund_id": id, "owner": owner, "amount_atomic": U128(amount)}),
        );
        id
    }

    pub(crate) fn finalize_refund(&mut self, transfer: &Transfer, success: bool) {
        let mut refund = self
            .refunds
            .get(&transfer.object_id)
            .expect("REFUND_NOT_FOUND");
        assert_eq!(
            refund.transfer_id.as_ref(),
            Some(&transfer.transfer_id),
            "REFUND_TRANSFER_MISMATCH"
        );
        if success {
            refund.paid = true;
            self.refund_total -= refund.amount_atomic.0;
            events::emit(
                &self.config.deployment_id,
                "RefundPaid",
                &refund.refund_id,
                2,
                json!({"refund_id": refund.refund_id, "amount_atomic": refund.amount_atomic}),
            );
        } else {
            refund.transfer_id = None;
        }
        self.refunds.insert(&refund.refund_id, &refund);
    }
}

impl Coordinator {
    pub(crate) fn recheck_settlement(
        &self,
        id: &str,
        leg_id: &str,
        reserved_input: u128,
        loan: &crate::state::Loan,
    ) {
        let settlement = self.settlement(id);
        assert!(!self.controls.settlements, "SETTLEMENTS_PAUSED");
        assert_eq!(
            settlement.state,
            SettlementState::Committed,
            "SETTLEMENT_NOT_COMMITTED"
        );
        assert_eq!(
            settlement.escrow_atomic, settlement.plan.net_output_atomic,
            "ESCROW_INVARIANT"
        );
        assert!(Self::now() < settlement.plan.expires_at, "QUOTE_EXPIRED");
        let mut before = loan.clone();
        let lock = before
            .locks
            .iter_mut()
            .find(|l| l.leg.leg_id == leg_id)
            .unwrap();
        lock.reserved_atomic.0 -= reserved_input;
        before.resolve_outflow(id);
        let source = loan.locks.iter().find(|l| l.leg.leg_id == leg_id).unwrap();
        assert!(
            settlement.plan.net_output_atomic.0 + settlement.plan.execution_cost_atomic.0
                >= math::mul_div_floor(
                    self.leg_value(&source.leg, settlement.plan.input_atomic.0),
                    u128::from(10_000 - loan.policy.max_slippage_bps),
                    10_000
                ),
            "QUOTE_BELOW_ORACLE_BOUND"
        );
        let original = self.risk(&before);
        let mut after = loan.clone();
        after.resolve_outflow(id);
        let repayment = settlement.plan.net_output_atomic.0.min(loan.debt());
        let debt = loan.debt() - repayment;
        let pending_output = self.committed_settlement_output(&after);
        let post_value = self.basket_capacity(&after, true) + pending_output.min(debt);
        let health = if debt == 0 {
            u128::MAX
        } else {
            math::mul_div_floor(post_value, 1_000_000, debt)
        };
        match settlement.plan.kind {
            SettlementKind::Repayment => {}
            SettlementKind::Conditional => {
                let a = self.conditionals.get(&loan.loan_id).unwrap();
                assert!(
                    a.terms.enabled
                        && a.version == settlement.plan.conditional_version
                        && a.terms.expires_at.is_none_or(|expiry| Self::now() < expiry),
                    "CONDITIONAL_AUTHORIZATION_CHANGED"
                );
                assert!(
                    original.health_ppm.0 > 1_000_000
                        && original.health_ppm.0 <= u128::from(a.terms.trigger_health_ppm)
                        && health > original.health_ppm.0
                        && (debt == 0 || health <= u128::from(a.terms.target_health_ppm)),
                    "CONDITIONAL_NOT_TRIGGERED"
                );
            }
            SettlementKind::Liquidation => {
                assert!(
                    pending_output + settlement.plan.net_output_atomic.0
                        <= loan.debt() + loan.policy.max_liquidation_surplus_atomic.0,
                    "LIQUIDATION_REPAYMENT_LIMIT"
                );
                assert!(
                    original.defaulted || original.health_ppm.0 <= 1_000_000,
                    "NOT_LIQUIDATABLE"
                );
                assert!(
                    original.defaulted
                        || debt == 0
                        || health >= u128::from(loan.policy.recovery_health_ppm),
                    "INVALID_POST_SALE_HEALTH"
                );
            }
        }
    }
    pub(crate) fn resolve_remote_settlement(
        &mut self,
        operation: &crate::operation::RemoteOperation,
        delivered: bool,
    ) {
        let id = operation
            .settlement_id
            .as_ref()
            .expect("SETTLEMENT_ID_REQUIRED");
        let mut settlement = self.settlement(id);
        assert_eq!(
            settlement.state,
            SettlementState::Committed,
            "SETTLEMENT_NOT_COMMITTED"
        );
        if delivered {
            settlement.state = SettlementState::Delivered;
            settlement.source_spent_atomic = settlement.plan.input_atomic;
            settlement.actual_cost_atomic = settlement.plan.execution_cost_atomic;
        } else {
            settlement.state = SettlementState::Funded;
            settlement.transfer_id = None;
            if settlement.plan.kind == SettlementKind::Conditional {
                let loan = self.loan(&settlement.plan.loan_id);
                let asset = loan
                    .locks
                    .iter()
                    .find(|l| l.leg.leg_id == settlement.plan.leg_id)
                    .unwrap()
                    .leg
                    .asset_id
                    .clone();
                self.resolve_conditional(
                    &loan.loan_id,
                    &asset,
                    settlement.plan.input_atomic.0,
                    settlement.plan.net_output_atomic.0,
                    settlement.plan.execution_cost_atomic.0,
                    None,
                );
            }
        }
        settlement.revision += 1;
        self.settlements.insert(id, &settlement);
    }
}
