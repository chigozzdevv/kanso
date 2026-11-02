#![allow(dead_code)]

use std::collections::HashMap;

use kanso_coordinator::{
    config::{Config, Network},
    math::NEAR_SCALE,
    state::{BasketLeg, Offer, PoolPolicy, Price},
    Coordinator,
};
use near_parameters::RuntimeFeesConfig;
use near_sdk::{
    json_types::U128, test_utils::VMContextBuilder, testing_env, AccountId, Gas, NearToken,
    PromiseResult,
};

pub const NOW: u64 = 1_700_000_000;

pub fn account(value: &str) -> AccountId {
    value.parse().unwrap()
}

pub fn context(caller: &str, now: u64, deposit: u128) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(account("kanso.near"))
        .signer_account_id(account(caller))
        .predecessor_account_id(account(caller))
        .account_balance(NearToken::from_near(10_000))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300))
        .block_timestamp(now * 1_000_000_000);
    builder
}

pub fn call_as(caller: &str, now: u64, deposit: u128) {
    testing_env!(context(caller, now, deposit).build());
}

pub fn callback_result(contract: &mut Coordinator, transfer_id: &str, now: u64, success: bool) {
    testing_env!(
        context("kanso.near", now, 0).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::default(),
        vec![if success {
            PromiseResult::Successful(b"null".to_vec())
        } else {
            PromiseResult::Failed
        }],
    );
    contract.record_transfer_result(transfer_id.to_owned());
}

pub fn policy() -> PoolPolicy {
    PoolPolicy {
        version: 1,
        apr_bps: 1000,
        origination_fee_atomic: U128(0),
        min_principal_atomic: U128(1),
        max_principal_atomic: U128(1_000_000_000),
        max_duration_seconds: 31_536_000,
        setup_duration_seconds: 600,
        grace_seconds: 60,
        interest_buffer_seconds: 86_400,
        ltv_bps: 5000,
        liquidation_threshold_bps: 7000,
        min_liquidity_atomic: U128(0),
        withdrawal_health_ppm: 1_200_000,
        min_conditional_trigger_health_ppm: 1_100_000,
        max_liquidation_surplus_atomic: U128(1_000_000),
        recovery_health_ppm: 1_300_000,
        max_execution_cost_bps: 500,
        max_slippage_bps: 500,
        max_execution_cost_atomic: U128(10_000_000),
        eligible_assets: vec!["near".into()],
        asset_caps: vec![kanso_coordinator::state::AssetCap {
            asset_id: "near".into(),
            max_collateral_value_atomic: U128(1_000_000_000_000),
        }],
        max_outstanding_principal_atomic: U128(10_000_000_000),
    }
}

pub struct Fixture {
    pub contract: Coordinator,
}

impl Fixture {
    pub fn new() -> Self {
        Self::with_network(Network::Sandbox)
    }

    pub fn with_network(network: Network) -> Self {
        call_as("owner.near", NOW, 0);
        near_sdk::mock::with_mocked_blockchain(|blockchain| {
            blockchain.take_storage();
        });
        let mut contract = Coordinator::new(Config {
            deployment_id: "sandbox_tests".to_owned(),
            network,
            owner: account("owner.near"),
            oracle_account: account("oracle.near"),
            settlement_token: account("usdc.near"),
            settlement_decimals: 6,
            max_price_age_seconds: 300,
            max_confidence_bps: 100,
            max_ltv_bps: 6000,
            max_liquidation_threshold_bps: 8000,
            operational_reserve_atomic: U128(NEAR_SCALE / 10),
        });
        for owner in [
            "lp.near",
            "borrower.near",
            "payer.near",
            "owner.near",
            "oracle.near",
        ] {
            call_as(owner, NOW, NEAR_SCALE);
            contract.storage_deposit(None);
        }
        call_as("lp.near", NOW, 1);
        contract.create_pool("pool".to_owned(), policy());
        call_as("oracle.near", NOW, 0);
        contract.publish_price(Price {
            price_atomic: U128(5_000_000),
            confidence_bps: 0,
            published_at: NOW,
            sequence: 1,
        });
        call_as("usdc.near", NOW, 0);
        contract.ft_on_transfer(
            account("lp.near"),
            U128(1_000_000_000),
            r#"{"kind":"pool_deposit","pool_id":"pool","operation_id":"initial"}"#.to_owned(),
        );
        Self { contract }
    }

    pub fn offer(&self, loan_id: &str) -> Offer {
        Offer {
            deployment_id: "sandbox_tests".to_owned(),
            network: Network::Sandbox,
            offer_id: loan_id.to_owned(),
            pool_id: "pool".to_owned(),
            borrower: account("borrower.near"),
            payout_account: account("borrower.near"),
            policy_version: 1,
            principal_atomic: U128(100_000_000),
            apr_bps: 1000,
            duration_seconds: 31_536_000,
            origination_fee_atomic: U128(0),
            expires_at: NOW + 60,
            setup_deadline: NOW + 600,
            min_price_atomic: U128(4_000_000),
            max_price_atomic: U128(6_000_000),
            legs: vec![BasketLeg {
                asset_id: "near".into(),
                custody: kanso_coordinator::state::Custody::Near,
                leg_id: "near".to_owned(),
                owner: account("borrower.near"),
                amount_atomic: U128(100 * NEAR_SCALE),
                release_recipient: account("borrower.near"),
            }],
        }
    }

    pub fn reserve(&mut self, loan_id: &str) {
        let offer = self.offer(loan_id);
        call_as("borrower.near", NOW, 1);
        self.contract.accept_offer(offer);
    }

    pub fn ready(&mut self, loan_id: &str) {
        self.reserve(loan_id);
        call_as("borrower.near", NOW, 100 * NEAR_SCALE);
        self.contract
            .lock_native(loan_id.to_owned(), "near".to_owned());
    }

    pub fn funded(&mut self, loan_id: &str) {
        self.ready(loan_id);
        call_as("borrower.near", NOW, 1);
        let transfer_id = format!("fund_{loan_id}");
        self.contract
            .fund_loan(loan_id.to_owned(), transfer_id.clone());
        callback_result(&mut self.contract, &transfer_id, NOW, true);
        self.contract.finalize_transfer(transfer_id);
    }

    pub fn repay(&mut self, loan_id: &str, operation_id: &str, amount: u128, now: u64) -> U128 {
        call_as("usdc.near", now, 0);
        self.contract.ft_on_transfer(
            account("payer.near"),
            U128(amount),
            format!(
                r#"{{"kind":"repayment","loan_id":"{loan_id}","operation_id":"{operation_id}"}}"#
            ),
        )
    }
}
