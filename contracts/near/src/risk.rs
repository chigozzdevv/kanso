use crate::{
    math,
    state::{Loan, LoanState},
    Coordinator, CoordinatorExt,
};
use near_sdk::{json_types::U128, near};

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct RiskSnapshot {
    pub debt_atomic: U128,
    pub borrowing_capacity_atomic: U128,
    pub secured_recovery_atomic: U128,
    pub liquidation_value_atomic: U128,
    pub health_ppm: U128,
    pub defaulted: bool,
    pub revision: String,
}

#[near]
impl Coordinator {
    pub fn basket_risk(&self, loan_id: String) -> RiskSnapshot {
        let mut loan = self.loan(&loan_id);
        loan.accrue(Self::now());
        self.risk(&loan)
    }
}

impl Coordinator {
    pub(crate) fn risk(&self, loan: &Loan) -> RiskSnapshot {
        let capacity = self.basket_capacity(loan, false);
        let secured_recovery = self.committed_settlement_output(loan).min(loan.debt());
        let liquidation = self.basket_capacity(loan, true) + secured_recovery;
        let debt = loan.debt();
        RiskSnapshot {
            debt_atomic: U128(debt),
            borrowing_capacity_atomic: U128(capacity),
            secured_recovery_atomic: U128(secured_recovery),
            liquidation_value_atomic: U128(liquidation),
            health_ppm: U128(if debt == 0 {
                u128::MAX
            } else {
                math::mul_div_floor(liquidation, 1_000_000, debt)
            }),
            defaulted: loan.state == LoanState::Active
                && Self::now() >= loan.matures_at.saturating_add(loan.policy.grace_seconds),
            revision: loan.revision.to_string(),
        }
    }

    // Escrow replaces reserved source collateral in health; it never creates borrowing capacity.
    pub(crate) fn committed_settlement_output(&self, loan: &Loan) -> u128 {
        loan.active_outflow
            .iter()
            .chain(&loan.recovery_outflows)
            .filter_map(|id| self.settlements.get(id))
            .filter(|s| {
                s.plan.loan_id == loan.loan_id
                    && matches!(
                        s.state,
                        crate::settlement::SettlementState::Committed
                            | crate::settlement::SettlementState::Delivered
                    )
            })
            .map(|s| s.escrow_atomic.0)
            .sum()
    }

    pub(crate) fn assert_safe_withdrawal(&self, loan: &Loan) {
        assert!(
            !self.controls.collateral_withdrawals,
            "COLLATERAL_WITHDRAWALS_PAUSED"
        );
        let risk = self.risk(loan);
        let (buffer, remainder) = math::interest(
            loan.principal_outstanding_atomic.0,
            loan.offer.apr_bps,
            loan.policy.interest_buffer_seconds,
            0,
        );
        assert!(
            !risk.defaulted
                && risk.borrowing_capacity_atomic.0
                    >= loan.debt() + buffer + u128::from(remainder > 0)
                && risk.health_ppm.0 >= u128::from(loan.policy.withdrawal_health_ppm),
            "UNSAFE_COLLATERAL_WITHDRAWAL"
        );
    }
}

impl Coordinator {
    pub(crate) fn weighted_capacity<'a>(
        &self,
        legs: impl Iterator<Item = (&'a crate::state::BasketLeg, u128)>,
        policy: &crate::state::PoolPolicy,
        liquidation: bool,
    ) -> u128 {
        let mut groups = std::collections::BTreeMap::<String, (u128, u128)>::new();
        for (leg, amount) in legs {
            let value = self.leg_value(leg, amount);
            let weight = if liquidation {
                policy.liquidation_threshold_bps
            } else {
                policy.ltv_bps
            };
            let weighted = self.leg_capacity(leg, amount, weight, liquidation);
            let entry = groups.entry(leg.asset_id.clone()).or_default();
            entry.0 += value;
            entry.1 += weighted;
        }
        groups
            .into_iter()
            .map(|(asset, (value, weighted))| {
                let cap = policy
                    .asset_caps
                    .iter()
                    .find(|c| c.asset_id == asset)
                    .expect("ASSET_CAP_MISSING")
                    .max_collateral_value_atomic
                    .0;
                if value > cap {
                    math::mul_div_floor(weighted, cap, value)
                } else {
                    weighted
                }
            })
            .sum()
    }
    pub(crate) fn basket_capacity(&self, loan: &Loan, liquidation: bool) -> u128 {
        self.weighted_capacity(
            loan.locks
                .iter()
                .filter(|l| {
                    l.accepted && matches!(l.purpose, crate::state::LockPurpose::Collateral)
                })
                .map(|l| (&l.leg, l.locked_atomic.0 - l.reserved_atomic.0)),
            &loan.policy,
            liquidation,
        )
    }
}
