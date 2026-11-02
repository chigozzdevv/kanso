mod basket;
pub mod bitcoin_light_client;
mod callbacks;
pub mod collateral;
pub mod conditional_repayment;
pub mod config;
pub mod controls;
pub mod encoding;
mod events;
pub mod governance;
mod liquidation;
mod loan;
pub mod manifest;
pub mod math;
pub mod mpc;
mod offer;
pub mod operation;
mod oracle;
mod pool;
pub mod recovery;
mod repayment;
pub mod risk;
pub mod settlement;
pub mod state;
pub mod transaction;
mod wallet_payment;

use near_sdk::{
    collections::LookupMap, env, json_types::U128, near, AccountId, NearToken, PanicOnDefault,
};

use config::Config;
use state::{Loan, PaymentReceipt, Pool, Position, Price, Transfer, Withdrawal};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Coordinator {
    config: Config,
    controls: controls::PauseFlags,
    controls_revision: u64,
    pools: LookupMap<String, Pool>,
    positions: LookupMap<(String, AccountId), Position>,
    loans: LookupMap<String, Loan>,
    transfers: LookupMap<String, Transfer>,
    withdrawals: LookupMap<String, Withdrawal>,
    payments: LookupMap<(AccountId, String), PaymentReceipt>,
    storage_credits: LookupMap<AccountId, u128>,
    total_storage_credit: u128,
    native_custody_total: u128,
    conditionals: LookupMap<String, conditional_repayment::ConditionalAuthorization>,
    settlements: LookupMap<String, settlement::Settlement>,
    refunds: LookupMap<String, settlement::Refund>,
    topups: LookupMap<String, basket::TopUp>,
    replacements: LookupMap<String, basket::Replacement>,
    manifests: LookupMap<(String, u32), manifest::ChainManifest>,
    manifest_versions: LookupMap<String, u32>,
    asset_prices: LookupMap<String, Price>,
    asset_origins: LookupMap<String, Vec<u8>>,
    bitcoin_keys: LookupMap<String, Vec<u8>>,
    bitcoin_utxos: LookupMap<String, collateral::bitcoin::BitcoinUtxo>,
    bitcoin_spends: LookupMap<String, collateral::bitcoin::BitcoinSpend>,
    bitcoin_recoveries: LookupMap<String, collateral::bitcoin::BitcoinRecovery>,
    remote_operations: LookupMap<String, operation::RemoteOperation>,
    verified_controllers: LookupMap<(String, u32), bool>,
    signing_resources: LookupMap<String, String>,
    account_nonce_next: LookupMap<String, u64>,
    remote_resources: LookupMap<String, String>,
    recovery_policy: Option<recovery::RecoveryPolicy>,
    transfer_count: u64,
    escrow_total: u128,
    refund_total: u128,
}

#[near]
impl Coordinator {
    #[init]
    pub fn new(config: Config) -> Self {
        config.validate();
        assert_eq!(
            env::predecessor_account_id(),
            config.owner,
            "OWNER_REQUIRED"
        );
        Self::write_pool_count(0);
        Self {
            config,
            controls: controls::PauseFlags::default(),
            controls_revision: 0,
            pools: LookupMap::new(b"p"),
            positions: LookupMap::new(b"s"),
            loans: LookupMap::new(b"l"),
            transfers: LookupMap::new(b"t"),
            withdrawals: LookupMap::new(b"w"),
            payments: LookupMap::new(b"r"),
            storage_credits: LookupMap::new(b"c"),
            total_storage_credit: 0,
            native_custody_total: 0,
            conditionals: LookupMap::new(b"ca".to_vec()),
            settlements: LookupMap::new(b"se".to_vec()),
            refunds: LookupMap::new(b"rf".to_vec()),
            topups: LookupMap::new(b"tu".to_vec()),
            replacements: LookupMap::new(b"rp".to_vec()),
            manifests: LookupMap::new(b"cm".to_vec()),
            manifest_versions: LookupMap::new(b"cv".to_vec()),
            asset_prices: LookupMap::new(b"ap".to_vec()),
            asset_origins: LookupMap::new(b"ao".to_vec()),
            bitcoin_keys: LookupMap::new(b"bk".to_vec()),
            bitcoin_utxos: LookupMap::new(b"bu".to_vec()),
            bitcoin_spends: LookupMap::new(b"bs".to_vec()),
            bitcoin_recoveries: LookupMap::new(b"br".to_vec()),
            remote_operations: LookupMap::new(b"ro".to_vec()),
            verified_controllers: LookupMap::new(b"vk".to_vec()),
            signing_resources: LookupMap::new(b"sr".to_vec()),
            account_nonce_next: LookupMap::new(b"an".to_vec()),
            remote_resources: LookupMap::new(b"rr".to_vec()),
            recovery_policy: None,
            transfer_count: 0,
            escrow_total: 0,
            refund_total: 0,
        }
    }

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) -> U128 {
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let before = env::storage_usage();
        let existing = self.storage_credits.get(&account).unwrap_or(0);
        self.storage_credits.insert(&account, &existing);
        let cost =
            u128::from(env::storage_usage() - before) * env::storage_byte_cost().as_yoctonear();
        let deposit = env::attached_deposit().as_yoctonear();
        assert!(deposit > cost, "INSUFFICIENT_STORAGE_DEPOSIT");
        let credit = existing + deposit - cost;
        self.storage_credits.insert(&account, &credit);
        self.total_storage_credit += deposit - cost;
        U128(credit)
    }

    pub fn storage_balance(&self, account_id: AccountId) -> U128 {
        U128(self.storage_credits.get(&account_id).unwrap_or(0))
    }
}

impl Coordinator {
    fn now() -> u64 {
        env::block_timestamp() / 1_000_000_000
    }

    fn charge_storage(&mut self, account: &AccountId, before: u64) {
        let growth = env::storage_usage().saturating_sub(before);
        let cost = u128::from(growth) * env::storage_byte_cost().as_yoctonear();
        let credit = self.storage_credits.get(account).unwrap_or(0);
        assert!(credit >= cost, "STORAGE_CREDIT_REQUIRED");
        self.storage_credits.insert(account, &(credit - cost));
        self.total_storage_credit -= cost;
        self.assert_native_backing();
    }

    fn assert_native_backing(&self) {
        let required = u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear()
            + self.total_storage_credit
            + self.native_custody_total
            + self.config.operational_reserve_atomic.0;
        assert!(
            env::account_balance().as_yoctonear() >= required,
            "NATIVE_RESERVE_LOW"
        );
    }

    fn pool(&self, pool_id: &str) -> Pool {
        self.pools.get(&pool_id.to_owned()).expect("POOL_NOT_FOUND")
    }

    fn loan(&self, loan_id: &str) -> Loan {
        self.loans.get(&loan_id.to_owned()).expect("LOAN_NOT_FOUND")
    }

    fn one_yocto() {
        assert_eq!(
            env::attached_deposit(),
            NearToken::from_yoctonear(1),
            "ONE_YOCTO_REQUIRED"
        );
    }
}
