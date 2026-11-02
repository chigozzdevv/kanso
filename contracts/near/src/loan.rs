use near_sdk::{
    json_types::{U128, U64},
    near,
};

use crate::{math, Coordinator, CoordinatorExt};

#[near(serializers = [json])]
pub struct LoanSummary {
    pub loan_id: String,
    pub debt_state: String,
    pub debt_atomic: U128,
    pub principal_atomic: U128,
    pub interest_atomic: U128,
    pub fees_atomic: U128,
    pub borrowing_capacity_atomic: Option<U128>,
    pub liquidation_value_atomic: Option<U128>,
    pub secured_recovery_atomic: U128,
    pub health_ppm: Option<U128>,
    pub price_status: String,
    pub started_at: Option<u64>,
    pub matures_at: Option<u64>,
    pub custody_resolved: bool,
    pub revision: U64,
}

#[near]
impl Coordinator {
    pub fn loan_summary(&self, loan_id: String) -> LoanSummary {
        let mut loan = self.loan(&loan_id);
        loan.accrue(Self::now());
        let mut price_status = "valid";
        for lock in loan.locks.iter().filter(|l| {
            matches!(l.purpose, crate::state::LockPurpose::Collateral) && l.locked_atomic.0 > 0
        }) {
            match self.asset_prices.get(&lock.leg.asset_id) {
                None => price_status = "missing",
                Some(price)
                    if Self::now() < price.published_at
                        || Self::now() - price.published_at > self.config.max_price_age_seconds =>
                {
                    if price_status != "missing" {
                        price_status = "stale";
                    }
                }
                _ => {}
            }
        }
        let values = (price_status == "valid").then(|| {
            (
                self.basket_capacity(&loan, false),
                self.risk(&loan).liquidation_value_atomic.0,
            )
        });
        let debt = loan.debt();
        LoanSummary {
            loan_id: loan_id.clone(),
            debt_state: self.debt_state(loan_id),
            debt_atomic: U128(debt),
            principal_atomic: loan.principal_outstanding_atomic,
            interest_atomic: U128(loan.interest_due()),
            fees_atomic: loan.fees_due_atomic,
            borrowing_capacity_atomic: values.map(|value| U128(value.0)),
            liquidation_value_atomic: values.map(|value| U128(value.1)),
            secured_recovery_atomic: U128(self.committed_settlement_output(&loan).min(debt)),
            health_ppm: if debt == 0 {
                None
            } else {
                values.map(|value| U128(math::mul_div_floor(value.1, 1_000_000, debt)))
            },
            price_status: price_status.into(),
            started_at: (loan.started_at > 0).then_some(loan.started_at),
            matures_at: (loan.matures_at > 0).then_some(loan.matures_at),
            custody_resolved: loan.custody_resolved(),
            revision: U64(loan.revision),
        }
    }
}
