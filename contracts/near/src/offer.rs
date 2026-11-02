use near_sdk::{env, json_types::U128, near, serde_json::json};

use crate::{
    config::valid_id,
    encoding, events, math,
    state::{Loan, LoanState, Lock, Offer, SetupState, MAX_POOL_LOANS},
    Coordinator, CoordinatorExt,
};

#[near]
impl Coordinator {
    #[payable]
    pub fn accept_offer(&mut self, offer: Offer) -> Loan {
        Self::one_yocto();
        let borrower = env::predecessor_account_id();
        assert_eq!(borrower, offer.borrower, "BORROWER_REQUIRED");
        valid_id(&offer.offer_id);
        let hash = env::sha256(encoding::encode_offer(&offer));
        if let Some(existing) = self.loans.get(&offer.offer_id) {
            assert_eq!(existing.offer_hash, hash, "IDEMPOTENCY_CONFLICT");
            return existing;
        }
        assert!(!self.controls.origination, "ORIGINATION_PAUSED");
        assert_eq!(
            offer.deployment_id, self.config.deployment_id,
            "DEPLOYMENT_MISMATCH"
        );
        assert_eq!(offer.network, self.config.network, "NETWORK_MISMATCH");
        assert_ne!(
            offer.payout_account,
            env::current_account_id(),
            "INVALID_PAYOUT_ACCOUNT"
        );
        let mut pool = self.pool(&offer.pool_id);
        assert!(pool.loan_ids.len() < MAX_POOL_LOANS, "POOL_LOAN_LIMIT");
        let policy = &pool.policy;
        assert_eq!(
            offer.policy_version, policy.version,
            "POLICY_VERSION_CHANGED"
        );
        assert_eq!(offer.apr_bps, policy.apr_bps, "INVALID_APR");
        assert_eq!(
            offer.origination_fee_atomic, policy.origination_fee_atomic,
            "INVALID_FEE"
        );
        assert!(
            offer.principal_atomic.0 >= policy.min_principal_atomic.0
                && offer.principal_atomic.0 <= policy.max_principal_atomic.0,
            "INVALID_PRINCIPAL"
        );
        assert!(
            offer.duration_seconds > 0 && offer.duration_seconds <= policy.max_duration_seconds,
            "INVALID_DURATION"
        );
        let now = Self::now();
        assert!(
            now < offer.expires_at && offer.expires_at <= offer.setup_deadline,
            "OFFER_EXPIRED"
        );
        assert!(
            offer.setup_deadline
                <= now
                    .checked_add(policy.setup_duration_seconds)
                    .expect("TIME_OVERFLOW"),
            "INVALID_SETUP_DEADLINE"
        );
        assert!(
            !offer.legs.is_empty() && offer.legs.len() <= 16,
            "INVALID_BASKET"
        );
        assert!(
            offer.min_price_atomic.0 > 0 && offer.min_price_atomic.0 <= offer.max_price_atomic.0,
            "INVALID_PRICE_BOUNDS"
        );
        if offer
            .legs
            .iter()
            .any(|leg| matches!(leg.custody, crate::state::Custody::Near))
        {
            let price = self.conservative_price();
            assert!(
                price >= offer.min_price_atomic.0 && price <= offer.max_price_atomic.0,
                "PRICE_OUT_OF_BOUNDS"
            );
        }

        for (index, leg) in offer.legs.iter().enumerate() {
            valid_id(&leg.leg_id);
            self.validate_leg(leg, true);
            assert!(
                policy.eligible_assets.contains(&leg.asset_id),
                "ASSET_NOT_ELIGIBLE"
            );
            assert_eq!(leg.owner, borrower, "SOURCE_OWNER_MISMATCH");
            assert_ne!(
                leg.release_recipient,
                env::current_account_id(),
                "INVALID_RELEASE_RECIPIENT"
            );
            assert!(leg.amount_atomic.0 > 0, "INVALID_COLLATERAL_AMOUNT");
            assert!(
                !offer.legs[..index]
                    .iter()
                    .any(|previous| previous.leg_id == leg.leg_id),
                "DUPLICATE_LEG"
            );
        }
        let capacity = self.weighted_capacity(
            offer.legs.iter().map(|leg| (leg, leg.amount_atomic.0)),
            policy,
            false,
        );
        let buffer = math::interest(
            offer.principal_atomic.0,
            offer.apr_bps,
            policy.interest_buffer_seconds,
            0,
        );
        let obligation = offer.principal_atomic.0
            + offer.origination_fee_atomic.0
            + buffer.0
            + u128::from(buffer.1 > 0);
        assert!(capacity >= obligation, "INSUFFICIENT_CAPACITY");
        assert!(
            self.available_cash(&pool) >= offer.principal_atomic.0,
            "POOL_CAPACITY_CHANGED"
        );
        let existing_principal: u128 = pool
            .loan_ids
            .iter()
            .map(|id| {
                let loan = self.loan(id);
                if loan.state == LoanState::PendingFunding {
                    loan.offer.principal_atomic.0
                } else {
                    loan.principal_outstanding_atomic.0
                }
            })
            .sum();
        assert!(
            existing_principal + offer.principal_atomic.0
                <= policy.max_outstanding_principal_atomic.0,
            "POOL_EXPOSURE_LIMIT"
        );
        let before = env::storage_usage();
        pool.reserved_atomic.0 += offer.principal_atomic.0;
        pool.loan_ids.push(offer.offer_id.clone());
        pool.revision += 1;
        let loan = Loan {
            loan_id: offer.offer_id.clone(),
            offer_hash: hash.clone(),
            policy: pool.policy.clone(),
            state: LoanState::PendingFunding,
            setup_state: SetupState::Reserved,
            locks: offer
                .legs
                .iter()
                .map(|leg| Lock {
                    purpose: crate::state::LockPurpose::Collateral,
                    agreement: hash.clone(),
                    leg: leg.clone(),
                    locked_atomic: U128(0),
                    reserved_atomic: U128(0),
                    accepted: false,
                    receipt_verified: false,
                    remote_nonce: 0,
                })
                .collect(),
            offer,
            principal_outstanding_atomic: U128(0),
            interest_atomic: U128(0),
            interest_remainder: 0,
            fees_due_atomic: U128(0),
            started_at: 0,
            last_accrued_at: 0,
            matures_at: 0,
            active_outflow: None,
            recovery_outflows: vec![],
            written_off_atomic: U128(0),
            revision: 1,
        };
        self.pools.insert(&pool.pool_id, &pool);
        self.loans.insert(&loan.loan_id, &loan);
        self.charge_storage(&borrower, before);
        events::emit(
            &self.config.deployment_id,
            "OfferAccepted",
            &loan.loan_id,
            loan.revision,
            json!({"loan_id": loan.loan_id, "revision": loan.revision.to_string(), "principal_atomic": loan.offer.principal_atomic}),
        );
        loan
    }

    #[payable]
    pub fn abort_setup(&mut self, loan_id: String) -> Loan {
        Self::one_yocto();
        let mut loan = self.loan(&loan_id);
        assert!(
            env::predecessor_account_id() == loan.offer.borrower
                || Self::now() >= loan.offer.setup_deadline,
            "BORROWER_REQUIRED"
        );
        if loan.state == LoanState::Cancelled {
            return loan;
        }
        assert_eq!(loan.state, LoanState::PendingFunding, "LOAN_ALREADY_FUNDED");
        assert_ne!(
            loan.setup_state,
            SetupState::Funding,
            "DISBURSEMENT_UNRESOLVED"
        );
        let mut pool = self.pool(&loan.offer.pool_id);
        pool.reserved_atomic.0 -= loan.offer.principal_atomic.0;
        pool.loan_ids.retain(|id| id != &loan_id);
        pool.revision += 1;
        loan.state = LoanState::Cancelled;
        loan.setup_state = if loan.custody_resolved() {
            SetupState::Aborted
        } else {
            SetupState::Aborting
        };
        loan.revision += 1;
        self.pools.insert(&pool.pool_id, &pool);
        self.loans.insert(&loan_id, &loan);
        events::emit(
            &self.config.deployment_id,
            "SetupAborted",
            &loan_id,
            loan.revision,
            json!({"loan_id": loan_id, "revision": loan.revision.to_string()}),
        );
        loan
    }

    pub fn get_loan(&self, loan_id: String) -> Loan {
        let mut loan = self.loan(&loan_id);
        loan.accrue(Self::now());
        loan
    }

    pub fn debt_state(&self, loan_id: String) -> String {
        let loan = self.loan(&loan_id);
        match loan.state {
            LoanState::PendingFunding => "pending_funding",
            LoanState::Cancelled => "cancelled",
            LoanState::Repaid => "repaid",
            LoanState::WrittenOff => "written_off",
            LoanState::Active
                if Self::now() >= loan.matures_at.saturating_add(loan.policy.grace_seconds) =>
            {
                "defaulted"
            }
            LoanState::Active if Self::now() >= loan.matures_at => "due",
            LoanState::Active => "active",
        }
        .to_owned()
    }
}
