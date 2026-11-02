use near_sdk::{env, json_types::U128, near};

use crate::{math, state::Price, Coordinator, CoordinatorExt};

#[near]
impl Coordinator {
    pub fn publish_price(&mut self, price: Price) {
        self.publish_asset_price("near".into(), price);
    }

    pub fn publish_asset_price(&mut self, asset_id: String, price: Price) {
        crate::config::valid_id(&asset_id);
        assert_eq!(
            env::predecessor_account_id(),
            self.config.oracle_account,
            "ORACLE_REQUIRED"
        );
        assert!(price.price_atomic.0 > 0, "INVALID_PRICE");
        assert!(
            price.confidence_bps <= self.config.max_confidence_bps,
            "PRICE_CONFIDENCE_LOW"
        );
        assert!(price.published_at <= Self::now(), "PRICE_FROM_FUTURE");
        assert!(
            Self::now() - price.published_at <= self.config.max_price_age_seconds,
            "PRICE_STALE"
        );
        if let Some(previous) = self.asset_prices.get(&asset_id) {
            assert!(price.sequence > previous.sequence, "PRICE_REPLAY");
            assert!(
                price.published_at >= previous.published_at,
                "PRICE_REGRESSION"
            );
        }
        let before = env::storage_usage();
        self.asset_prices.insert(&asset_id, &price);
        self.charge_storage(&self.config.oracle_account.clone(), before);
    }

    pub fn get_asset_price(&self, asset_id: String) -> Option<Price> {
        self.asset_prices.get(&asset_id)
    }

    pub fn get_price(&self) -> Option<Price> {
        self.asset_prices.get(&"near".to_owned())
    }

    pub fn borrowing_capacity(&self, loan_id: String) -> U128 {
        let loan = self.loan(&loan_id);
        U128(self.basket_capacity(&loan, false))
    }
}

impl Coordinator {
    pub(crate) fn conservative_price(&self) -> u128 {
        self.asset_price("near")
    }

    pub(crate) fn asset_price(&self, asset_id: &str) -> u128 {
        let price = self
            .asset_prices
            .get(&asset_id.to_owned())
            .expect("PRICE_MISSING");
        assert!(Self::now() >= price.published_at, "PRICE_FROM_FUTURE");
        assert!(
            Self::now() - price.published_at <= self.config.max_price_age_seconds,
            "PRICE_STALE"
        );
        math::mul_div_floor(
            price.price_atomic.0,
            u128::from(10_000 - price.confidence_bps),
            10_000,
        )
    }
}
