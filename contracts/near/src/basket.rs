use crate::{
    config::valid_id,
    events,
    state::{BasketLeg, Loan, LoanState, Lock, Transfer, TransferKind},
    Coordinator, CoordinatorExt,
};
use near_sdk::{env, json_types::U128, near, serde_json::json};

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TopUp {
    pub operation_id: String,
    pub loan_id: String,
    pub leg: BasketLeg,
    pub accepted: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Replacement {
    pub operation_id: String,
    pub loan_id: String,
    pub incoming_topup_id: String,
    pub outgoing_leg_id: String,
    pub outgoing_amount_atomic: U128,
    pub transfer_id: Option<String>,
}

#[near]
impl Coordinator {
    #[payable]
    pub fn commit_topup(&mut self, operation_id: String, loan_id: String, leg: BasketLeg) -> TopUp {
        Self::one_yocto();
        valid_id(&operation_id);
        valid_id(&leg.leg_id);
        let mut loan = self.loan(&loan_id);
        assert_eq!(
            env::predecessor_account_id(),
            loan.offer.borrower,
            "BORROWER_REQUIRED"
        );
        if let Some(existing) = self.get_topup(operation_id.clone()) {
            assert!(
                existing.loan_id == loan_id
                    && near_sdk::borsh::to_vec(&existing.leg).unwrap()
                        == near_sdk::borsh::to_vec(&leg).unwrap(),
                "IDEMPOTENCY_CONFLICT"
            );
            return existing;
        }
        assert_eq!(loan.state, LoanState::Active, "LOAN_NOT_ACTIVE");
        self.validate_leg(&leg, true);
        assert!(
            loan.policy.eligible_assets.contains(&leg.asset_id),
            "ASSET_NOT_ELIGIBLE"
        );
        assert_eq!(leg.owner, loan.offer.borrower, "SOURCE_OWNER_MISMATCH");
        assert_ne!(
            leg.release_recipient,
            env::current_account_id(),
            "INVALID_RELEASE_RECIPIENT"
        );
        assert!(
            leg.amount_atomic.0 > 0 && loan.locks.len() < 16,
            "INVALID_TOPUP"
        );
        assert!(
            !loan.locks.iter().any(|l| l.leg.leg_id == leg.leg_id),
            "DUPLICATE_LEG"
        );
        let before = env::storage_usage();
        let topup = TopUp {
            operation_id: operation_id.clone(),
            loan_id: loan_id.clone(),
            leg,
            accepted: false,
        };
        loan.locks.push(Lock {
            purpose: crate::state::LockPurpose::Collateral,
            agreement: loan.offer_hash.clone(),
            leg: topup.leg.clone(),
            locked_atomic: U128(0),
            reserved_atomic: U128(0),
            accepted: false,
            receipt_verified: false,
            remote_nonce: 0,
        });
        loan.revision += 1;
        self.loans.insert(&loan_id, &loan);
        self.topups.insert(&operation_id, &topup);
        self.charge_storage(&loan.offer.borrower, before);
        topup
    }

    #[payable]
    pub fn lock_native_topup(&mut self, operation_id: String) -> Loan {
        let mut topup = self.topups.get(&operation_id).expect("TOPUP_NOT_FOUND");
        assert!(
            matches!(topup.leg.custody, crate::state::Custody::Near),
            "NATIVE_LEG_REQUIRED"
        );
        assert!(!topup.accepted, "DEPOSIT_ALREADY_ACCEPTED");
        assert_eq!(
            env::predecessor_account_id(),
            topup.leg.owner,
            "SOURCE_OWNER_REQUIRED"
        );
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            topup.leg.amount_atomic.0,
            "INCORRECT_DEPOSIT"
        );
        let before = env::storage_usage();
        let loan = self.lock_native(topup.loan_id.clone(), topup.leg.leg_id.clone());
        topup.accepted = true;
        self.topups.insert(&operation_id, &topup);
        self.charge_storage(&topup.leg.owner, before);
        events::emit(
            &self.config.deployment_id,
            "CollateralLockAccepted",
            &loan.loan_id,
            loan.revision,
            json!({"operation_id": operation_id, "leg_id": topup.leg.leg_id, "amount_atomic": topup.leg.amount_atomic}),
        );
        loan
    }

    #[payable]
    pub fn withdraw_excess(
        &mut self,
        loan_id: String,
        leg_id: String,
        amount_atomic: U128,
        transfer_id: String,
        expected_revision: String,
    ) -> Transfer {
        Self::one_yocto();
        let mut loan = self.loan(&loan_id);
        assert_eq!(
            env::predecessor_account_id(),
            loan.offer.borrower,
            "BORROWER_REQUIRED"
        );
        if let Some(existing) = self.transfers.get(&transfer_id) {
            self.check_transfer_identity(
                &existing,
                TransferKind::CollateralRelease,
                &loan.offer.borrower,
                &loan_id,
                &leg_id,
            );
            assert_eq!(
                existing.amount_atomic, amount_atomic,
                "IDEMPOTENCY_CONFLICT"
            );
            return existing;
        }
        assert_eq!(
            loan.revision.to_string(),
            expected_revision,
            "BASKET_REVISION_CHANGED"
        );
        assert_eq!(loan.state, LoanState::Active, "LOAN_NOT_ACTIVE");
        loan.accrue(Self::now());
        assert!(Self::now() < loan.matures_at, "LOAN_DUE");
        self.reserve_native_release(&mut loan, &leg_id, amount_atomic, &transfer_id, true)
    }

    #[payable]
    pub fn commit_replacement(
        &mut self,
        operation_id: String,
        loan_id: String,
        incoming_topup_id: String,
        outgoing_leg_id: String,
        outgoing_amount_atomic: U128,
    ) -> Replacement {
        Self::one_yocto();
        valid_id(&operation_id);
        let loan = self.loan(&loan_id);
        assert_eq!(
            env::predecessor_account_id(),
            loan.offer.borrower,
            "BORROWER_REQUIRED"
        );
        if let Some(existing) = self.replacements.get(&operation_id) {
            assert!(
                existing.loan_id == loan_id
                    && existing.incoming_topup_id == incoming_topup_id
                    && existing.outgoing_leg_id == outgoing_leg_id
                    && existing.outgoing_amount_atomic == outgoing_amount_atomic,
                "IDEMPOTENCY_CONFLICT"
            );
            return existing;
        }
        assert_eq!(loan.state, LoanState::Active, "LOAN_NOT_ACTIVE");
        let incoming = self
            .get_topup(incoming_topup_id.clone())
            .expect("TOPUP_NOT_FOUND");
        assert!(
            incoming.loan_id == loan_id && !incoming.accepted,
            "INCOMING_ALREADY_USED"
        );
        assert!(
            incoming.leg.leg_id != outgoing_leg_id && outgoing_amount_atomic.0 > 0,
            "INVALID_REPLACEMENT"
        );
        let before = env::storage_usage();
        let replacement = Replacement {
            operation_id: operation_id.clone(),
            loan_id,
            incoming_topup_id,
            outgoing_leg_id,
            outgoing_amount_atomic,
            transfer_id: None,
        };
        self.replacements.insert(&operation_id, &replacement);
        self.charge_storage(&loan.offer.borrower, before);
        replacement
    }

    #[payable]
    pub fn finalize_replacement(
        &mut self,
        operation_id: String,
        transfer_id: String,
        expected_revision: String,
    ) -> Transfer {
        Self::one_yocto();
        let mut replacement = self
            .replacements
            .get(&operation_id)
            .expect("REPLACEMENT_NOT_FOUND");
        let mut loan = self.loan(&replacement.loan_id);
        assert_eq!(
            env::predecessor_account_id(),
            loan.offer.borrower,
            "BORROWER_REQUIRED"
        );
        if let Some(id) = &replacement.transfer_id {
            let old = self
                .transfers
                .get(id)
                .expect("REPLACEMENT_TRANSFER_NOT_FOUND");
            if id == &transfer_id {
                return old;
            }
            assert!(
                old.finalized && old.outcome == crate::state::TransferOutcome::Failed,
                "REPLACEMENT_OUTFLOW_UNRESOLVED"
            );
        }
        assert_eq!(
            loan.revision.to_string(),
            expected_revision,
            "BASKET_REVISION_CHANGED"
        );
        let incoming = self
            .get_topup(replacement.incoming_topup_id.clone())
            .expect("TOPUP_NOT_FOUND");
        assert!(
            incoming.accepted
                && loan
                    .locks
                    .iter()
                    .any(|l| l.leg.leg_id == incoming.leg.leg_id
                        && l.locked_atomic.0 >= incoming.leg.amount_atomic.0
                        && l.reserved_atomic.0 == 0),
            "INCOMING_NOT_VERIFIED"
        );
        assert_eq!(loan.state, LoanState::Active, "LOAN_NOT_ACTIVE");
        loan.accrue(Self::now());
        assert!(Self::now() < loan.matures_at, "LOAN_DUE");
        let transfer = self.reserve_native_release(
            &mut loan,
            &replacement.outgoing_leg_id,
            replacement.outgoing_amount_atomic,
            &transfer_id,
            true,
        );
        replacement.transfer_id = Some(transfer_id);
        self.replacements.insert(&operation_id, &replacement);
        transfer
    }

    pub fn get_topup(&self, operation_id: String) -> Option<TopUp> {
        self.topups.get(&operation_id).map(|mut topup| {
            topup.accepted = self
                .loan(&topup.loan_id)
                .locks
                .iter()
                .any(|l| l.leg.leg_id == topup.leg.leg_id && l.accepted);
            topup
        })
    }
    pub fn get_replacement(&self, operation_id: String) -> Option<Replacement> {
        self.replacements.get(&operation_id)
    }
}

impl Coordinator {
    pub(crate) fn reserve_native_release(
        &mut self,
        loan: &mut Loan,
        leg_id: &str,
        amount: U128,
        transfer_id: &str,
        check_risk: bool,
    ) -> Transfer {
        assert!(loan.active_outflow.is_none(), "OUTFLOW_UNRESOLVED");
        assert!(
            self.transfers.get(&transfer_id.to_owned()).is_none(),
            "TRANSFER_EXISTS"
        );
        let lock = loan
            .locks
            .iter_mut()
            .find(|l| l.leg.leg_id == leg_id)
            .expect("LEG_NOT_FOUND");
        assert!(
            matches!(lock.leg.custody, crate::state::Custody::Near),
            "NATIVE_LEG_REQUIRED"
        );
        assert!(
            amount.0 > 0 && lock.locked_atomic.0 - lock.reserved_atomic.0 >= amount.0,
            "COLLATERAL_UNAVAILABLE"
        );
        lock.reserved_atomic.0 += amount.0;
        let recipient = lock.leg.release_recipient.clone();
        let owner = match &lock.purpose {
            crate::state::LockPurpose::Collateral => loan.offer.borrower.clone(),
            crate::state::LockPurpose::Payment { payer, .. } => payer.clone(),
        };
        assert_eq!(
            env::predecessor_account_id(),
            owner,
            "CUSTODY_OWNER_REQUIRED"
        );
        if check_risk {
            self.assert_safe_withdrawal(loan);
        }
        let before = env::storage_usage();
        let transfer = self.new_transfer(
            transfer_id.to_owned(),
            TransferKind::CollateralRelease,
            owner.clone(),
            loan.loan_id.clone(),
            leg_id.to_owned(),
            recipient,
            amount,
        );
        loan.active_outflow = Some(transfer_id.to_owned());
        loan.revision += 1;
        self.native_custody_total -= amount.0;
        self.loans.insert(&loan.loan_id, loan);
        self.transfers.insert(&transfer.transfer_id, &transfer);
        self.charge_storage(&owner, before);
        events::emit(
            &self.config.deployment_id,
            "CollateralChangeCommitted",
            &loan.loan_id,
            loan.revision,
            json!({"transfer_id": transfer.transfer_id, "leg_id": leg_id, "amount_atomic": amount}),
        );
        self.send_transfer(&transfer, false);
        transfer
    }
}

#[near]
impl Coordinator {
    #[payable]
    pub fn prepare_remote_replacement(
        &mut self,
        operation_id: String,
        remote_operation_id: String,
        expected_revision: String,
        deadline: u64,
    ) -> crate::operation::RemoteOperation {
        Self::one_yocto();
        let mut replacement = self
            .replacements
            .get(&operation_id)
            .expect("REPLACEMENT_NOT_FOUND");
        let loan = self.loan(&replacement.loan_id);
        assert_eq!(
            env::predecessor_account_id(),
            loan.offer.borrower,
            "BORROWER_REQUIRED"
        );
        if let Some(id) = &replacement.transfer_id {
            let old = self.remote_operation(id);
            if id == &remote_operation_id {
                return old;
            }
            assert!(
                matches!(
                    old.state,
                    crate::operation::RemoteState::Invalidated
                        | crate::operation::RemoteState::Cancelled
                ),
                "REPLACEMENT_OUTFLOW_UNRESOLVED"
            );
        }
        let topup = self
            .get_topup(replacement.incoming_topup_id.clone())
            .expect("TOPUP_NOT_FOUND");
        assert!(
            topup.accepted
                && loan.locks.iter().any(|l| l.leg.leg_id == topup.leg.leg_id
                    && l.locked_atomic.0 >= topup.leg.amount_atomic.0
                    && l.reserved_atomic.0 == 0),
            "INCOMING_NOT_VERIFIED"
        );
        let operation = self.prepare_remote_release(
            remote_operation_id.clone(),
            replacement.loan_id.clone(),
            replacement.outgoing_leg_id.clone(),
            replacement.outgoing_amount_atomic,
            expected_revision,
            deadline,
        );
        let before = env::storage_usage();
        replacement.transfer_id = Some(remote_operation_id);
        self.replacements.insert(&operation_id, &replacement);
        self.charge_storage(&loan.offer.borrower, before);
        operation
    }
    #[payable]
    pub fn prepare_bitcoin_replacement(
        &mut self,
        operation_id: String,
        spend_id: String,
        max_fee_atomic: U128,
        expected_revision: String,
    ) -> crate::collateral::bitcoin::BitcoinSpend {
        Self::one_yocto();
        let mut replacement = self
            .replacements
            .get(&operation_id)
            .expect("REPLACEMENT_NOT_FOUND");
        let loan = self.loan(&replacement.loan_id);
        assert_eq!(
            env::predecessor_account_id(),
            loan.offer.borrower,
            "BORROWER_REQUIRED"
        );
        if let Some(id) = &replacement.transfer_id {
            let old = self
                .bitcoin_spends
                .get(id)
                .expect("BITCOIN_SPEND_NOT_FOUND");
            if id == &spend_id {
                return old;
            }
            assert!(
                matches!(
                    old.state,
                    crate::collateral::bitcoin::BitcoinSpendState::Invalidated
                        | crate::collateral::bitcoin::BitcoinSpendState::Cancelled
                ),
                "REPLACEMENT_OUTFLOW_UNRESOLVED"
            );
        }
        let topup = self
            .get_topup(replacement.incoming_topup_id.clone())
            .expect("TOPUP_NOT_FOUND");
        assert!(
            topup.accepted
                && loan.locks.iter().any(|l| l.leg.leg_id == topup.leg.leg_id
                    && l.locked_atomic.0 >= topup.leg.amount_atomic.0
                    && l.reserved_atomic.0 == 0),
            "INCOMING_NOT_VERIFIED"
        );
        let operation = self.prepare_bitcoin_release(
            spend_id.clone(),
            replacement.loan_id.clone(),
            replacement.outgoing_leg_id.clone(),
            replacement.outgoing_amount_atomic,
            max_fee_atomic,
            expected_revision,
        );
        let before = env::storage_usage();
        replacement.transfer_id = Some(spend_id);
        self.replacements.insert(&operation_id, &replacement);
        self.charge_storage(&loan.offer.borrower, before);
        operation
    }
}
