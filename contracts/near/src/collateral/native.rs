use near_sdk::{env, json_types::U128, near, serde_json::json};

use crate::{
    events,
    state::{Loan, LoanState, SetupState, Transfer, TransferKind},
    Coordinator, CoordinatorExt,
};

#[near]
impl Coordinator {
    #[payable]
    pub fn lock_native(&mut self, loan_id: String, leg_id: String) -> Loan {
        let mut loan = self.loan(&loan_id);
        assert!(
            matches!(
                loan.state,
                LoanState::PendingFunding
                    | LoanState::Cancelled
                    | LoanState::Active
                    | LoanState::Repaid
                    | LoanState::WrittenOff
            ),
            "SETUP_NOT_OPEN"
        );
        assert_ne!(
            loan.setup_state,
            SetupState::Funding,
            "DISBURSEMENT_UNRESOLVED"
        );
        let lock = loan
            .locks
            .iter_mut()
            .find(|lock| lock.leg.leg_id == leg_id)
            .expect("LEG_NOT_FOUND");
        assert!(
            matches!(lock.leg.custody, crate::state::Custody::Near),
            "NATIVE_LEG_REQUIRED"
        );
        assert_eq!(
            env::predecessor_account_id(),
            lock.leg.owner,
            "SOURCE_OWNER_REQUIRED"
        );
        assert!(!lock.receipt_verified, "DEPOSIT_ALREADY_ACCEPTED");
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            lock.leg.amount_atomic.0,
            "INCORRECT_DEPOSIT"
        );
        lock.locked_atomic = lock.leg.amount_atomic;
        lock.accepted = true;
        lock.receipt_verified = true;
        self.native_custody_total += lock.locked_atomic.0;
        if matches!(loan.state, LoanState::PendingFunding | LoanState::Cancelled) {
            loan.setup_state =
                if loan.state == LoanState::Cancelled || Self::now() >= loan.offer.setup_deadline {
                    if loan.state != LoanState::Cancelled {
                        SetupState::Locking
                    } else {
                        SetupState::Aborting
                    }
                } else if loan.locks.iter().all(|lock| lock.accepted) {
                    SetupState::Ready
                } else {
                    SetupState::Locking
                };
        }
        loan.revision += 1;
        self.loans.insert(&loan_id, &loan);
        self.assert_native_backing();
        events::emit(
            &self.config.deployment_id,
            "CollateralLockAccepted",
            &loan_id,
            loan.revision,
            json!({"loan_id": loan_id, "leg_id": leg_id, "amount_atomic": U128(env::attached_deposit().as_yoctonear()), "revision": loan.revision.to_string()}),
        );
        loan
    }

    #[payable]
    pub fn release_collateral(
        &mut self,
        loan_id: String,
        leg_id: String,
        transfer_id: String,
    ) -> Transfer {
        Self::one_yocto();
        let mut loan = self.loan(&loan_id);
        let owner = env::predecessor_account_id();
        assert_eq!(owner, loan.offer.borrower, "BORROWER_REQUIRED");
        if let Some(existing) = self.transfers.get(&transfer_id) {
            self.check_transfer_identity(
                &existing,
                TransferKind::CollateralRelease,
                &owner,
                &loan_id,
                &leg_id,
            );
            return existing;
        }
        assert!(
            matches!(
                loan.state,
                LoanState::Repaid | LoanState::Cancelled | LoanState::WrittenOff
            ),
            "DEBT_NOT_CLEARED"
        );
        assert!(loan.active_outflow.is_none(), "OUTFLOW_UNRESOLVED");
        let lock = loan
            .locks
            .iter_mut()
            .find(|lock| lock.leg.leg_id == leg_id)
            .expect("LEG_NOT_FOUND");
        assert!(
            lock.locked_atomic.0 > 0 && lock.reserved_atomic.0 == 0,
            "COLLATERAL_UNAVAILABLE"
        );
        assert!(
            matches!(lock.leg.custody, crate::state::Custody::Near),
            "NATIVE_LEG_REQUIRED"
        );
        assert!(
            matches!(lock.purpose, crate::state::LockPurpose::Collateral),
            "PAYMENT_OWNER_REQUIRED"
        );
        let amount = lock.locked_atomic;
        lock.reserved_atomic = amount;
        let transfer = self.new_transfer(
            transfer_id,
            TransferKind::CollateralRelease,
            owner.clone(),
            loan_id.clone(),
            leg_id,
            lock.leg.release_recipient.clone(),
            amount,
        );
        let before = env::storage_usage();
        loan.active_outflow = Some(transfer.transfer_id.clone());
        loan.revision += 1;
        self.native_custody_total -= amount.0;
        self.loans.insert(&loan_id, &loan);
        self.transfers.insert(&transfer.transfer_id, &transfer);
        self.charge_storage(&owner, before);
        self.send_transfer(&transfer, false);
        transfer
    }
}
