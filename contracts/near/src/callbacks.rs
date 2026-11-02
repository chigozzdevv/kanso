use near_sdk::{
    env,
    json_types::U128,
    near,
    serde_json::{self, json},
    AccountId, Gas, NearToken, Promise, PromiseError,
};

use crate::{
    config::valid_id,
    events, math,
    state::{LoanState, SetupState, Transfer, TransferKind, TransferOutcome, WithdrawalState},
    Coordinator, CoordinatorExt,
};

#[near]
impl Coordinator {
    #[payable]
    pub fn fund_loan(&mut self, loan_id: String, transfer_id: String) -> Transfer {
        Self::one_yocto();
        let mut loan = self.loan(&loan_id);
        let borrower = env::predecessor_account_id();
        assert_eq!(borrower, loan.offer.borrower, "BORROWER_REQUIRED");
        if let Some(existing) = self.transfers.get(&transfer_id) {
            self.check_transfer_identity(
                &existing,
                TransferKind::Disbursement,
                &borrower,
                &loan_id,
                "",
            );
            return existing;
        }
        assert!(!self.controls.origination, "ORIGINATION_PAUSED");
        assert_eq!(loan.state, LoanState::PendingFunding, "LOAN_NOT_PENDING");
        assert_eq!(loan.setup_state, SetupState::Ready, "LOCK_NOT_VERIFIED");
        assert!(Self::now() < loan.offer.setup_deadline, "SETUP_EXPIRED");
        assert!(
            loan.locks.iter().all(|lock| lock.accepted
                && lock.locked_atomic == lock.leg.amount_atomic
                && lock.reserved_atomic.0 == 0),
            "LOCK_NOT_VERIFIED"
        );
        if loan
            .offer
            .legs
            .iter()
            .any(|leg| matches!(leg.custody, crate::state::Custody::Near))
        {
            let price = self.conservative_price();
            assert!(
                price >= loan.offer.min_price_atomic.0 && price <= loan.offer.max_price_atomic.0,
                "PRICE_OUT_OF_BOUNDS"
            );
        }
        for lock in &loan.locks {
            self.validate_leg(&lock.leg, true);
        }
        let capacity = self.basket_capacity(&loan, false);
        let buffer = math::interest(
            loan.offer.principal_atomic.0,
            loan.offer.apr_bps,
            loan.policy.interest_buffer_seconds,
            0,
        );
        assert!(
            capacity
                >= loan.offer.principal_atomic.0
                    + loan.offer.origination_fee_atomic.0
                    + buffer.0
                    + u128::from(buffer.1 > 0),
            "INSUFFICIENT_CAPACITY"
        );
        let mut pool = self.pool(&loan.offer.pool_id);
        assert!(
            pool.cash_atomic.0 >= pool.reserved_atomic.0
                && pool.reserved_atomic.0 >= loan.offer.principal_atomic.0,
            "POOL_RESERVE_INVARIANT"
        );
        let before = env::storage_usage();
        let transfer = self.new_transfer(
            transfer_id,
            TransferKind::Disbursement,
            borrower.clone(),
            loan_id.clone(),
            String::new(),
            loan.offer.payout_account.clone(),
            loan.offer.principal_atomic,
        );
        loan.setup_state = SetupState::Funding;
        loan.revision += 1;
        pool.cash_atomic.0 -= transfer.amount_atomic.0;
        pool.reserved_atomic.0 -= transfer.amount_atomic.0;
        pool.in_flight_atomic.0 += transfer.amount_atomic.0;
        pool.revision += 1;
        self.loans.insert(&loan_id, &loan);
        self.pools.insert(&pool.pool_id, &pool);
        self.transfers.insert(&transfer.transfer_id, &transfer);
        self.charge_storage(&borrower, before);
        events::emit(
            &self.config.deployment_id,
            "DisbursementCommitted",
            &loan_id,
            loan.revision,
            json!({"loan_id": loan_id, "transfer_id": transfer.transfer_id, "amount_atomic": transfer.amount_atomic, "revision": loan.revision.to_string()}),
        );
        self.send_transfer(&transfer, true);
        transfer
    }

    #[private]
    pub fn record_transfer_result(&mut self, transfer_id: String) -> bool {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "PRIVATE_CALLBACK"
        );
        assert_eq!(env::promise_results_count(), 1, "INVALID_CALLBACK");
        let mut transfer = self
            .transfers
            .get(&transfer_id)
            .expect("TRANSFER_NOT_FOUND");
        if transfer.outcome != TransferOutcome::Unknown {
            return transfer.outcome == TransferOutcome::Succeeded;
        }
        // Record delivery before accounting so finalization can retry without another payout.
        transfer.outcome = match env::promise_result_checked(0, 64) {
            Ok(_) => TransferOutcome::Succeeded,
            Err(PromiseError::Failed) => TransferOutcome::Failed,
            Err(_) => return false,
        };
        transfer.observed_at = Self::now();
        self.transfers.insert(&transfer_id, &transfer);
        transfer.outcome == TransferOutcome::Succeeded
    }

    pub fn finalize_transfer(&mut self, transfer_id: String) -> Transfer {
        let mut transfer = self
            .transfers
            .get(&transfer_id)
            .expect("TRANSFER_NOT_FOUND");
        if transfer.finalized {
            return transfer;
        }
        assert_ne!(
            transfer.outcome,
            TransferOutcome::Unknown,
            "TRANSFER_RECONCILING"
        );
        let success = transfer.outcome == TransferOutcome::Succeeded;
        match transfer.kind {
            TransferKind::Disbursement => self.finalize_disbursement(&transfer, success),
            TransferKind::CollateralRelease => self.finalize_collateral_release(&transfer, success),
            TransferKind::LpWithdrawal => self.finalize_lp_withdrawal(&transfer, success),
            TransferKind::SettlementDelivery => {
                self.finalize_settlement_delivery(&transfer, success)
            }
            TransferKind::Refund => self.finalize_refund(&transfer, success),
            TransferKind::StorageWithdrawal => {
                if !success {
                    let credit = self.storage_credits.get(&transfer.owner).unwrap_or(0);
                    self.storage_credits
                        .insert(&transfer.owner, &(credit + transfer.amount_atomic.0));
                    self.total_storage_credit += transfer.amount_atomic.0;
                }
            }
        }
        transfer.finalized = true;
        self.transfers.insert(&transfer_id, &transfer);
        transfer
    }

    pub fn get_transfer(&self, transfer_id: String) -> Option<Transfer> {
        self.transfers.get(&transfer_id)
    }

    #[payable]
    pub fn withdraw_storage(&mut self, amount_atomic: U128, transfer_id: String) -> Transfer {
        Self::one_yocto();
        let owner = env::predecessor_account_id();
        if let Some(existing) = self.transfers.get(&transfer_id) {
            self.check_transfer_identity(
                &existing,
                TransferKind::StorageWithdrawal,
                &owner,
                "",
                "",
            );
            assert_eq!(
                existing.amount_atomic, amount_atomic,
                "IDEMPOTENCY_CONFLICT"
            );
            return existing;
        }
        let credit = self.storage_credits.get(&owner).unwrap_or(0);
        assert!(
            amount_atomic.0 > 0 && credit >= amount_atomic.0,
            "INSUFFICIENT_STORAGE_CREDIT"
        );
        let before = env::storage_usage();
        let transfer = self.new_transfer(
            transfer_id,
            TransferKind::StorageWithdrawal,
            owner.clone(),
            String::new(),
            String::new(),
            owner.clone(),
            amount_atomic,
        );
        self.storage_credits
            .insert(&owner, &(credit - amount_atomic.0));
        self.total_storage_credit -= amount_atomic.0;
        self.transfers.insert(&transfer.transfer_id, &transfer);
        self.charge_storage(&owner, before);
        self.send_transfer(&transfer, false);
        transfer
    }
}

impl Coordinator {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new_transfer(
        &mut self,
        transfer_id: String,
        kind: TransferKind,
        owner: AccountId,
        object_id: String,
        leg_id: String,
        recipient: AccountId,
        amount_atomic: U128,
    ) -> Transfer {
        valid_id(&transfer_id);
        assert!(
            self.config.network == crate::config::Network::Sandbox
                || self.recovery_policy.is_some(),
            "RECOVERY_NOT_CONFIGURED"
        );
        self.transfer_count = self
            .transfer_count
            .checked_add(1)
            .expect("TRANSFER_COUNT_OVERFLOW");
        Transfer {
            transfer_id,
            kind,
            owner,
            object_id,
            leg_id,
            recipient,
            amount_atomic,
            outcome: TransferOutcome::Unknown,
            finalized: false,
            committed_at: Self::now(),
            observed_at: 0,
        }
    }

    pub(crate) fn check_transfer_identity(
        &self,
        transfer: &Transfer,
        kind: TransferKind,
        owner: &AccountId,
        object_id: &str,
        leg_id: &str,
    ) {
        assert!(
            transfer.kind == kind
                && transfer.owner == *owner
                && transfer.object_id == object_id
                && transfer.leg_id == leg_id,
            "IDEMPOTENCY_CONFLICT"
        );
    }

    pub(crate) fn send_transfer(&self, transfer: &Transfer, token: bool) {
        assert!(
            env::prepaid_gas().as_gas() >= Gas::from_tgas(100).as_gas(),
            "INSUFFICIENT_GAS"
        );
        let promise = if token {
            Promise::new(self.config.settlement_token.clone()).function_call(
                "ft_transfer".to_owned(),
                serde_json::to_vec(&json!({"receiver_id": transfer.recipient, "amount": transfer.amount_atomic, "memo": transfer.transfer_id})).unwrap(),
                NearToken::from_yoctonear(1),
                Gas::from_tgas(20),
            )
        } else {
            Promise::new(transfer.recipient.clone())
                .transfer(NearToken::from_yoctonear(transfer.amount_atomic.0))
        };
        let arguments = serde_json::to_vec(&json!({"transfer_id": transfer.transfer_id})).unwrap();
        promise
            .then(Promise::new(env::current_account_id()).function_call(
                "record_transfer_result".to_owned(),
                arguments.clone(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(15),
            ))
            .then(Promise::new(env::current_account_id()).function_call(
                "finalize_transfer".to_owned(),
                arguments,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(30),
            ))
            .detach();
    }

    fn finalize_disbursement(&mut self, transfer: &Transfer, success: bool) {
        let mut loan = self.loan(&transfer.object_id);
        assert_eq!(
            loan.setup_state,
            SetupState::Funding,
            "INVALID_DISBURSEMENT_STATE"
        );
        let mut pool = self.pool(&loan.offer.pool_id);
        pool.in_flight_atomic.0 -= transfer.amount_atomic.0;
        if success {
            loan.state = LoanState::Active;
            loan.setup_state = SetupState::Funded;
            loan.principal_outstanding_atomic = transfer.amount_atomic;
            loan.fees_due_atomic = loan.offer.origination_fee_atomic;
            loan.started_at = Self::now();
            loan.last_accrued_at = loan.started_at;
            loan.matures_at = loan
                .started_at
                .checked_add(loan.offer.duration_seconds)
                .expect("TIME_OVERFLOW");
        } else {
            pool.cash_atomic.0 += transfer.amount_atomic.0;
            pool.reserved_atomic.0 += transfer.amount_atomic.0;
            loan.setup_state = SetupState::Ready;
        }
        pool.revision += 1;
        loan.revision += 1;
        self.pools.insert(&pool.pool_id, &pool);
        self.loans.insert(&loan.loan_id, &loan);
        events::emit(
            &self.config.deployment_id,
            if success {
                "LoanFunded"
            } else {
                "DisbursementFailed"
            },
            &loan.loan_id,
            loan.revision,
            json!({"loan_id": loan.loan_id, "transfer_id": transfer.transfer_id, "amount_atomic": transfer.amount_atomic, "revision": loan.revision.to_string()}),
        );
    }

    fn finalize_collateral_release(&mut self, transfer: &Transfer, success: bool) {
        let mut loan = self.loan(&transfer.object_id);
        let lock = loan
            .locks
            .iter_mut()
            .find(|lock| lock.leg.leg_id == transfer.leg_id)
            .expect("LEG_NOT_FOUND");
        lock.reserved_atomic.0 -= transfer.amount_atomic.0;
        if success {
            lock.locked_atomic.0 -= transfer.amount_atomic.0;
        } else {
            self.native_custody_total += transfer.amount_atomic.0;
        }
        if loan.has_outflow(&transfer.transfer_id) {
            loan.resolve_outflow(&transfer.transfer_id);
        }
        if loan.state == LoanState::Cancelled && loan.custody_resolved() {
            loan.setup_state = SetupState::Aborted;
        }
        loan.revision += 1;
        self.loans.insert(&loan.loan_id, &loan);
        events::emit(
            &self.config.deployment_id,
            if success {
                "CollateralReleased"
            } else {
                "CollateralReleaseFailed"
            },
            &loan.loan_id,
            loan.revision,
            json!({"loan_id": loan.loan_id, "leg_id": transfer.leg_id, "transfer_id": transfer.transfer_id, "amount_atomic": transfer.amount_atomic, "revision": loan.revision.to_string()}),
        );
    }

    fn finalize_lp_withdrawal(&mut self, transfer: &Transfer, success: bool) {
        let mut withdrawal = self
            .withdrawals
            .get(&transfer.object_id)
            .expect("WITHDRAWAL_NOT_FOUND");
        assert!(
            withdrawal.state == WithdrawalState::Pending,
            "INVALID_WITHDRAWAL_STATE"
        );
        let mut pool = self.pool(&withdrawal.pool_id);
        pool.in_flight_atomic.0 -= transfer.amount_atomic.0;
        pool.pending_withdrawal = false;
        withdrawal.state = WithdrawalState::Requested;
        if success {
            let key = (withdrawal.pool_id.clone(), withdrawal.owner.clone());
            let mut position = self.positions.get(&key).expect("POSITION_NOT_FOUND");
            position.shares.0 -= withdrawal.shares.0;
            position.reserved_shares.0 -= withdrawal.shares.0;
            pool.total_shares.0 -= withdrawal.shares.0;
            withdrawal.state = WithdrawalState::Paid;
            self.positions.insert(&key, &position);
        } else {
            pool.cash_atomic.0 += transfer.amount_atomic.0;
        }
        pool.revision += 1;
        self.withdrawals
            .insert(&withdrawal.withdrawal_id, &withdrawal);
        self.pools.insert(&pool.pool_id, &pool);
        events::emit(
            &self.config.deployment_id,
            if success {
                "WithdrawalPaid"
            } else {
                "WithdrawalFailed"
            },
            &withdrawal.withdrawal_id,
            pool.revision,
            json!({"withdrawal_id": withdrawal.withdrawal_id, "transfer_id": transfer.transfer_id, "amount_atomic": transfer.amount_atomic, "revision": pool.revision.to_string()}),
        );
    }
}
