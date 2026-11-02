use crate::{config::valid_id, events, math, Coordinator, CoordinatorExt};
use near_sdk::{env, json_types::U128, near, serde_json::json};
#[near(serializers=[borsh,json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct SpendLimit {
    pub asset_id: String,
    pub max_total_atomic: U128,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct SpendUsage {
    pub asset_id: String,
    pub consumed_atomic: U128,
    pub reserved_atomic: U128,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct ConditionalTerms {
    pub enabled: bool,
    pub trigger_health_ppm: u32,
    pub target_health_ppm: u32,
    pub max_total_repayment_atomic: U128,
    pub max_collateral_spend: Vec<SpendLimit>,
    pub max_execution_cost_bps: u16,
    pub max_execution_cost_atomic: U128,
    pub expires_at: Option<u64>,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct ConditionalAuthorization {
    pub version: u32,
    pub initial_terms: ConditionalTerms,
    pub terms: ConditionalTerms,
    pub spend: Vec<SpendUsage>,
    pub consumed_repayment_atomic: U128,
    pub reserved_repayment_atomic: U128,
    pub consumed_cost_atomic: U128,
    pub reserved_cost_atomic: U128,
}
#[near]
impl Coordinator {
    #[payable]
    pub fn set_conditional_repayment(
        &mut self,
        loan_id: String,
        expected_version: u32,
        terms: ConditionalTerms,
    ) -> ConditionalAuthorization {
        Self::one_yocto();
        let loan = self.loan(&loan_id);
        assert_eq!(
            env::predecessor_account_id(),
            loan.offer.borrower,
            "BORROWER_REQUIRED"
        );
        assert!(
            terms.trigger_health_ppm >= loan.policy.min_conditional_trigger_health_ppm
                && terms.target_health_ppm > terms.trigger_health_ppm,
            "INVALID_CONDITIONAL_TARGET"
        );
        assert!(
            terms.max_execution_cost_bps <= loan.policy.max_execution_cost_bps,
            "EXECUTION_COST_LIMIT"
        );
        assert!(
            !terms.max_collateral_spend.is_empty() && terms.max_collateral_spend.len() <= 16,
            "INVALID_SPEND_LIMITS"
        );
        assert!(
            !terms.enabled || terms.expires_at.is_none_or(|expiry| expiry > Self::now()),
            "AUTHORIZATION_EXPIRED"
        );
        let previous = self.conditionals.get(&loan_id);
        assert_eq!(
            previous.as_ref().map_or(0, |a| a.version),
            expected_version,
            "AUTHORIZATION_VERSION_CHANGED"
        );
        let mut a = previous.unwrap_or(ConditionalAuthorization {
            version: 0,
            initial_terms: terms.clone(),
            terms: terms.clone(),
            spend: vec![],
            consumed_repayment_atomic: U128(0),
            reserved_repayment_atomic: U128(0),
            consumed_cost_atomic: U128(0),
            reserved_cost_atomic: U128(0),
        });
        assert!(
            terms.max_total_repayment_atomic.0
                >= a.consumed_repayment_atomic.0 + a.reserved_repayment_atomic.0,
            "REPAYMENT_CAP_BELOW_USAGE"
        );
        assert!(
            terms.max_execution_cost_atomic.0
                >= a.consumed_cost_atomic.0 + a.reserved_cost_atomic.0,
            "COST_CAP_BELOW_USAGE"
        );
        let mut spend = Vec::new();
        for (index, limit) in terms.max_collateral_spend.iter().enumerate() {
            valid_id(&limit.asset_id);
            assert!(
                !terms.max_collateral_spend[..index]
                    .iter()
                    .any(|l| l.asset_id == limit.asset_id),
                "DUPLICATE_ASSET_LIMIT"
            );
            let usage = a
                .spend
                .iter()
                .find(|s| s.asset_id == limit.asset_id)
                .cloned()
                .unwrap_or(SpendUsage {
                    asset_id: limit.asset_id.clone(),
                    consumed_atomic: U128(0),
                    reserved_atomic: U128(0),
                });
            assert!(
                limit.max_total_atomic.0 >= usage.consumed_atomic.0 + usage.reserved_atomic.0,
                "INPUT_CAP_BELOW_USAGE"
            );
            spend.push(usage);
        }
        for usage in &a.spend {
            assert!(
                spend.iter().any(|s| s.asset_id == usage.asset_id)
                    || (usage.consumed_atomic.0 == 0 && usage.reserved_atomic.0 == 0),
                "CANNOT_DROP_USAGE_HISTORY"
            );
        }
        let before = env::storage_usage();
        a.version = expected_version.checked_add(1).expect("VERSION_OVERFLOW");
        a.terms = terms;
        a.spend = spend;
        self.conditionals.insert(&loan_id, &a);
        self.charge_storage(&loan.offer.borrower, before);
        events::emit(
            &self.config.deployment_id,
            "ConditionalAuthorizationUpdated",
            &loan_id,
            u64::from(a.version),
            json!({"loan_id":loan_id,"authorization":a}),
        );
        a
    }
    pub fn get_conditional_repayment(&self, loan_id: String) -> Option<ConditionalAuthorization> {
        self.conditionals.get(&loan_id)
    }
}
impl Coordinator {
    pub(crate) fn reserve_conditional(
        &mut self,
        loan_id: &str,
        version: u32,
        asset: &str,
        input: u128,
        repayment: u128,
        cost: u128,
    ) {
        let mut a = self
            .conditionals
            .get(&loan_id.to_owned())
            .expect("CONDITIONAL_NOT_CONFIGURED");
        assert!(a.terms.enabled, "CONDITIONAL_PAUSED");
        assert_eq!(a.version, version, "AUTHORIZATION_VERSION_CHANGED");
        assert!(
            a.terms.expires_at.is_none_or(|expiry| Self::now() < expiry),
            "AUTHORIZATION_EXPIRED"
        );
        assert!(
            a.consumed_repayment_atomic.0 + a.reserved_repayment_atomic.0 + repayment
                <= a.terms.max_total_repayment_atomic.0,
            "REPAYMENT_BUDGET_EXCEEDED"
        );
        assert!(
            a.consumed_cost_atomic.0 + a.reserved_cost_atomic.0 + cost
                <= a.terms.max_execution_cost_atomic.0,
            "COST_BUDGET_EXCEEDED"
        );
        assert!(
            cost <= math::mul_div_floor(
                repayment + cost,
                u128::from(a.terms.max_execution_cost_bps),
                10_000
            ),
            "EXECUTION_COST_LIMIT"
        );
        let limit = a
            .terms
            .max_collateral_spend
            .iter()
            .find(|l| l.asset_id == asset)
            .expect("ASSET_NOT_AUTHORIZED");
        let usage = a
            .spend
            .iter_mut()
            .find(|s| s.asset_id == asset)
            .expect("ASSET_NOT_AUTHORIZED");
        assert!(
            usage.consumed_atomic.0 + usage.reserved_atomic.0 + input <= limit.max_total_atomic.0,
            "INPUT_BUDGET_EXCEEDED"
        );
        usage.reserved_atomic.0 += input;
        a.reserved_repayment_atomic.0 += repayment;
        a.reserved_cost_atomic.0 += cost;
        self.conditionals.insert(&loan_id.to_owned(), &a);
    }
    pub(crate) fn resolve_conditional(
        &mut self,
        loan_id: &str,
        asset: &str,
        input: u128,
        reserved_repayment: u128,
        cost: u128,
        consumed: Option<(u128, u128, u128)>,
    ) {
        let mut a = self
            .conditionals
            .get(&loan_id.to_owned())
            .expect("CONDITIONAL_NOT_CONFIGURED");
        let usage = a
            .spend
            .iter_mut()
            .find(|s| s.asset_id == asset)
            .expect("ASSET_NOT_AUTHORIZED");
        usage.reserved_atomic.0 -= input;
        a.reserved_repayment_atomic.0 -= reserved_repayment;
        a.reserved_cost_atomic.0 -= cost;
        if let Some((actual_input, repayment, actual_cost)) = consumed {
            assert!(
                actual_input <= input && repayment <= reserved_repayment && actual_cost <= cost,
                "CONDITIONAL_RESERVATION_EXCEEDED"
            );
            usage.consumed_atomic.0 += actual_input;
            a.consumed_repayment_atomic.0 += repayment;
            a.consumed_cost_atomic.0 += actual_cost;
        }
        self.conditionals.insert(&loan_id.to_owned(), &a);
    }
}
