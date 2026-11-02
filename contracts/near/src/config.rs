use near_sdk::{json_types::U128, near, AccountId};

pub const TESTNET_USDC: &str = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Network {
    Sandbox,
    Testnet,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub deployment_id: String,
    pub network: Network,
    pub owner: AccountId,
    pub oracle_account: AccountId,
    pub settlement_token: AccountId,
    pub settlement_decimals: u8,
    pub max_price_age_seconds: u64,
    pub max_confidence_bps: u16,
    pub max_ltv_bps: u16,
    pub max_liquidation_threshold_bps: u16,
    pub operational_reserve_atomic: U128,
}

pub fn valid_id(value: &str) {
    assert!(
        !value.is_empty()
            && value.len() <= 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'),
        "INVALID_IDENTIFIER"
    );
}

impl Config {
    pub fn validate(&self) {
        valid_id(&self.deployment_id);
        assert!(self.settlement_decimals <= 24, "INVALID_DECIMALS");
        assert!(self.max_price_age_seconds > 0, "INVALID_PRICE_AGE");
        assert!(self.max_confidence_bps < 10_000, "INVALID_CONFIDENCE");
        assert!(
            self.max_ltv_bps > 0
                && self.max_ltv_bps < self.max_liquidation_threshold_bps
                && self.max_liquidation_threshold_bps < 10_000,
            "INVALID_RISK_BOUNDS"
        );
        assert!(self.operational_reserve_atomic.0 > 0, "INVALID_RESERVE");
    }
}
