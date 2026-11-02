use crate::{
    events,
    state::{Loan, LoanState},
    Coordinator, CoordinatorExt,
};
use near_sdk::{env, json_types::U128, near, serde_json::json};

#[near]
impl Coordinator {
    #[payable]
    pub fn recognize_loss(&mut self, loan_id: String, expected_revision: String) -> Loan {
        Self::one_yocto();
        let mut loan = self.loan(&loan_id);
        let mut pool = self.pool(&loan.offer.pool_id);
        assert_eq!(
            env::predecessor_account_id(),
            pool.manager,
            "MANAGER_REQUIRED"
        );
        if loan.state == LoanState::WrittenOff {
            return loan;
        }
        assert_eq!(
            loan.revision.to_string(),
            expected_revision,
            "BASKET_REVISION_CHANGED"
        );
        assert_eq!(loan.state, LoanState::Active, "LOAN_NOT_ACTIVE");
        assert!(
            Self::now() >= loan.matures_at.saturating_add(loan.policy.grace_seconds),
            "LOAN_NOT_DEFAULTED"
        );
        assert!(
            loan.locks
                .iter()
                .filter(|l| matches!(l.purpose, crate::state::LockPurpose::Collateral))
                .all(|l| l.locked_atomic.0 == 0 && l.reserved_atomic.0 == 0)
                && loan.active_outflow.is_none(),
            "RECOVERY_NOT_EXHAUSTED"
        );
        loan.accrue(Self::now());
        let loss = loan.debt();
        assert!(loss > 0, "NO_LOSS");
        loan.written_off_atomic = U128(loss);
        loan.principal_outstanding_atomic = U128(0);
        loan.interest_atomic = U128(0);
        loan.interest_remainder = 0;
        loan.fees_due_atomic = U128(0);
        loan.state = LoanState::WrittenOff;
        loan.revision += 1;
        pool.recognized_loss_atomic.0 += loss;
        pool.loan_ids.retain(|id| id != &loan_id);
        pool.revision += 1;
        self.loans.insert(&loan_id, &loan);
        self.pools.insert(&pool.pool_id, &pool);
        events::emit(
            &self.config.deployment_id,
            "LossRecognized",
            &loan_id,
            loan.revision,
            json!({"loan_id": loan_id, "pool_id": pool.pool_id, "loss_atomic": U128(loss)}),
        );
        loan
    }
}
