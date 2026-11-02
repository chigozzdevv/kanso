use near_sdk::{env, json_types::U128, near, serde_json::json, AccountId};

use crate::{
    config::valid_id,
    events, math,
    state::{Pool, PoolPolicy, Position, Transfer, TransferKind, Withdrawal, WithdrawalState},
    Coordinator, CoordinatorExt,
};

const POOL_COUNT_KEY: &[u8] = b"\0kanso:pool-count:v1";

#[near]
impl Coordinator {
    #[payable]
    pub fn create_pool(&mut self, pool_id: String, policy: PoolPolicy) -> Pool {
        Self::one_yocto();
        valid_id(&pool_id);
        assert!(self.pools.get(&pool_id).is_none(), "POOL_EXISTS");
        assert_eq!(policy.version, 1, "INVALID_POLICY_VERSION");
        self.validate_policy(&policy);
        let owner = env::predecessor_account_id();
        let before = env::storage_usage();
        let pool = Pool {
            pool_id: pool_id.clone(),
            manager: owner.clone(),
            policy,
            cash_atomic: U128(0),
            reserved_atomic: U128(0),
            in_flight_atomic: U128(0),
            total_shares: U128(0),
            pending_withdrawal: false,
            recognized_loss_atomic: U128(0),
            loan_ids: Vec::new(),
            revision: 1,
        };
        self.pools.insert(&pool_id, &pool);
        Self::write_pool_count(
            Self::pool_count()
                .checked_add(1)
                .expect("POOL_COUNT_OVERFLOW"),
        );
        self.charge_storage(&owner, before);
        events::emit(
            &self.config.deployment_id,
            "PoolCreated",
            &pool_id,
            pool.revision,
            json!({"pool_id": pool_id, "manager": owner, "revision": pool.revision.to_string()}),
        );
        pool
    }

    #[payable]
    pub fn close_pool(&mut self, pool_id: String) {
        Self::one_yocto();
        let pool = self.pool(&pool_id);
        assert_eq!(
            env::predecessor_account_id(),
            pool.manager,
            "MANAGER_REQUIRED"
        );
        assert!(
            pool.cash_atomic.0 == 0
                && pool.reserved_atomic.0 == 0
                && pool.in_flight_atomic.0 == 0
                && pool.total_shares.0 == 0
                && !pool.pending_withdrawal
                && pool.loan_ids.is_empty(),
            "POOL_NOT_EMPTY"
        );
        self.pools.remove(&pool_id);
        crate::governance::clear_pool_manager(&pool_id);
        Self::write_pool_count(
            Self::pool_count()
                .checked_sub(1)
                .expect("POOL_COUNT_UNDERFLOW"),
        );
        events::emit(
            &self.config.deployment_id,
            "PoolClosed",
            &pool_id,
            pool.revision + 1,
            json!({"pool_id": pool_id}),
        );
    }

    #[payable]
    pub fn migrate_testnet_usdc(&mut self) -> crate::config::Config {
        Self::one_yocto();
        self.assert_owner();
        assert_eq!(
            self.config.network,
            crate::config::Network::Testnet,
            "TESTNET_REQUIRED"
        );
        let token: AccountId = crate::config::TESTNET_USDC.parse().unwrap();
        if self.config.settlement_token == token {
            return self.config.clone();
        }
        assert!(
            self.controls.origination
                && self.controls.settlements
                && self.controls.collateral_withdrawals,
            "MIGRATION_REQUIRES_PAUSE"
        );
        assert_eq!(Self::pool_count(), 0, "POOLS_REMAIN");
        assert!(
            self.escrow_total == 0 && self.refund_total == 0,
            "SETTLEMENT_LIABILITIES_REMAIN"
        );
        let previous_token = self.config.settlement_token.clone();
        self.config.settlement_token = token;
        self.config.settlement_decimals = 6;
        self.controls_revision += 1;
        events::emit(
            &self.config.deployment_id,
            "SettlementTokenChanged",
            &self.config.deployment_id,
            self.controls_revision,
            json!({"previous_token": previous_token, "settlement_token": self.config.settlement_token, "decimals": 6}),
        );
        self.config.clone()
    }

    #[payable]
    pub fn update_pool_policy(&mut self, pool_id: String, policy: PoolPolicy) -> Pool {
        Self::one_yocto();
        let mut pool = self.pool(&pool_id);
        assert_eq!(
            env::predecessor_account_id(),
            pool.manager,
            "MANAGER_REQUIRED"
        );
        assert_eq!(
            policy.version,
            pool.policy
                .version
                .checked_add(1)
                .expect("VERSION_OVERFLOW"),
            "INVALID_POLICY_VERSION"
        );
        self.validate_policy(&policy);
        pool.policy = policy;
        pool.revision += 1;
        self.pools.insert(&pool_id, &pool);
        events::emit(
            &self.config.deployment_id,
            "PoolPolicyUpdated",
            &pool_id,
            pool.revision,
            json!({"pool_id": pool_id, "policy_version": pool.policy.version, "revision": pool.revision.to_string()}),
        );
        pool
    }

    pub fn get_pool(&self, pool_id: String) -> Pool {
        self.pool(&pool_id)
    }

    pub fn get_pool_count(&self) -> u64 {
        Self::pool_count()
    }

    pub fn pool_nav(&self, pool_id: String) -> U128 {
        U128(self.nav(&self.pool(&pool_id)))
    }

    pub fn pool_available_cash(&self, pool_id: String) -> U128 {
        U128(self.available_cash(&self.pool(&pool_id)))
    }

    pub fn get_position(&self, pool_id: String, account_id: AccountId) -> Position {
        self.positions
            .get(&(pool_id, account_id))
            .unwrap_or_default()
    }

    pub fn get_withdrawal(&self, withdrawal_id: String) -> Option<Withdrawal> {
        self.withdrawals.get(&withdrawal_id)
    }

    #[payable]
    pub fn request_withdrawal(
        &mut self,
        withdrawal_id: String,
        pool_id: String,
        shares: U128,
    ) -> Withdrawal {
        Self::one_yocto();
        valid_id(&withdrawal_id);
        let owner = env::predecessor_account_id();
        if let Some(existing) = self.withdrawals.get(&withdrawal_id) {
            assert!(
                existing.owner == owner && existing.pool_id == pool_id && existing.shares == shares,
                "IDEMPOTENCY_CONFLICT"
            );
            return existing;
        }
        let mut position = self.get_position(pool_id.clone(), owner.clone());
        assert!(
            shares.0 > 0 && position.shares.0 - position.reserved_shares.0 >= shares.0,
            "INSUFFICIENT_SHARES"
        );
        let before = env::storage_usage();
        position.reserved_shares.0 += shares.0;
        let withdrawal = Withdrawal {
            withdrawal_id: withdrawal_id.clone(),
            pool_id: pool_id.clone(),
            owner: owner.clone(),
            shares,
            state: WithdrawalState::Requested,
        };
        self.positions.insert(&(pool_id, owner.clone()), &position);
        self.withdrawals.insert(&withdrawal_id, &withdrawal);
        self.charge_storage(&owner, before);
        events::emit(
            &self.config.deployment_id,
            "WithdrawalRequested",
            &withdrawal_id,
            0,
            json!({"withdrawal_id": withdrawal_id, "shares": shares}),
        );
        withdrawal
    }

    #[payable]
    pub fn cancel_withdrawal(&mut self, withdrawal_id: String) -> Withdrawal {
        Self::one_yocto();
        let mut withdrawal = self
            .withdrawals
            .get(&withdrawal_id)
            .expect("WITHDRAWAL_NOT_FOUND");
        assert_eq!(
            env::predecessor_account_id(),
            withdrawal.owner,
            "OWNER_REQUIRED"
        );
        if withdrawal.state == WithdrawalState::Cancelled {
            return withdrawal;
        }
        assert!(
            withdrawal.state == WithdrawalState::Requested,
            "WITHDRAWAL_COMMITTED"
        );
        let key = (withdrawal.pool_id.clone(), withdrawal.owner.clone());
        let mut position = self.positions.get(&key).expect("POSITION_NOT_FOUND");
        position.reserved_shares.0 -= withdrawal.shares.0;
        withdrawal.state = WithdrawalState::Cancelled;
        self.positions.insert(&key, &position);
        self.withdrawals.insert(&withdrawal_id, &withdrawal);
        events::emit(
            &self.config.deployment_id,
            "WithdrawalCancelled",
            &withdrawal_id,
            0,
            json!({"withdrawal_id": withdrawal_id, "shares": withdrawal.shares}),
        );
        withdrawal
    }

    #[payable]
    pub fn claim_withdrawal(&mut self, withdrawal_id: String, transfer_id: String) -> Transfer {
        Self::one_yocto();
        let mut withdrawal = self
            .withdrawals
            .get(&withdrawal_id)
            .expect("WITHDRAWAL_NOT_FOUND");
        let owner = env::predecessor_account_id();
        assert_eq!(owner, withdrawal.owner, "OWNER_REQUIRED");
        if let Some(existing) = self.transfers.get(&transfer_id) {
            self.check_transfer_identity(
                &existing,
                TransferKind::LpWithdrawal,
                &owner,
                &withdrawal_id,
                "",
            );
            return existing;
        }
        assert!(
            withdrawal.state == WithdrawalState::Requested,
            "WITHDRAWAL_UNAVAILABLE"
        );
        let mut pool = self.pool(&withdrawal.pool_id);
        assert!(!pool.pending_withdrawal, "POOL_WITHDRAWAL_PENDING");
        let amount = math::mul_div_floor(withdrawal.shares.0, self.nav(&pool), pool.total_shares.0);
        assert!(
            amount > 0 && amount <= self.available_cash(&pool),
            "WITHDRAWAL_LIQUIDITY_UNAVAILABLE"
        );
        let before = env::storage_usage();
        let transfer = self.new_transfer(
            transfer_id,
            TransferKind::LpWithdrawal,
            owner.clone(),
            withdrawal_id.clone(),
            String::new(),
            owner.clone(),
            U128(amount),
        );
        withdrawal.state = WithdrawalState::Pending;
        pool.pending_withdrawal = true;
        pool.cash_atomic.0 -= amount;
        pool.in_flight_atomic.0 += amount;
        pool.revision += 1;
        self.withdrawals.insert(&withdrawal_id, &withdrawal);
        self.pools.insert(&pool.pool_id, &pool);
        self.transfers.insert(&transfer.transfer_id, &transfer);
        self.charge_storage(&owner, before);
        self.send_transfer(&transfer, true);
        transfer
    }
}

impl Coordinator {
    pub(crate) fn write_pool_count(count: u64) {
        env::storage_write(POOL_COUNT_KEY, &count.to_le_bytes());
    }

    pub(crate) fn pool_count() -> u64 {
        let bytes = env::storage_read(POOL_COUNT_KEY).expect("POOL_REGISTRY_UNINITIALIZED");
        u64::from_le_bytes(bytes.try_into().expect("INVALID_POOL_COUNT"))
    }

    pub(crate) fn migrate_pool_registry(&self) {
        if env::storage_has_key(POOL_COUNT_KEY) {
            return;
        }
        // Version 1's public testnet has exactly these two pools; the upgrade preflight checks the complete storage prefix.
        assert_eq!(
            self.config.network,
            crate::config::Network::Testnet,
            "LEGACY_TESTNET_REQUIRED"
        );
        let count = ["test-usdc", "live-verification"]
            .into_iter()
            .filter(|id| self.pools.get(&id.to_string()).is_some())
            .count();
        assert_eq!(count, 2, "LEGACY_POOLS_MISSING");
        Self::write_pool_count(count as u64);
    }

    fn validate_policy(&self, policy: &PoolPolicy) {
        assert!(
            !policy.eligible_assets.is_empty() && policy.eligible_assets.len() <= 11,
            "INVALID_ASSET_POLICY"
        );
        for (i, asset) in policy.eligible_assets.iter().enumerate() {
            valid_id(asset);
            assert!(
                !policy.eligible_assets[..i].contains(asset),
                "DUPLICATE_ASSET"
            );
        }
        assert!(
            policy.min_conditional_trigger_health_ppm > 1_000_000
                && policy.max_liquidation_surplus_atomic.0 <= policy.max_principal_atomic.0,
            "INVALID_RECOVERY_BOUNDS"
        );
        assert!(
            policy.asset_caps.len() == policy.eligible_assets.len(),
            "INVALID_ASSET_CAPS"
        );
        for asset in &policy.eligible_assets {
            assert_eq!(
                policy
                    .asset_caps
                    .iter()
                    .filter(|c| c.asset_id == *asset && c.max_collateral_value_atomic.0 > 0)
                    .count(),
                1,
                "INVALID_ASSET_CAPS"
            );
        }
        assert!(
            policy.max_outstanding_principal_atomic.0 >= policy.max_principal_atomic.0,
            "INVALID_POOL_EXPOSURE_CAP"
        );
        assert!(policy.apr_bps <= 10_000, "INVALID_APR");
        assert!(
            policy.withdrawal_health_ppm > 1_000_000
                && policy.recovery_health_ppm >= policy.withdrawal_health_ppm,
            "INVALID_HEALTH_TARGETS"
        );
        assert!(
            policy.max_execution_cost_bps < 10_000 && policy.max_slippage_bps < 10_000,
            "INVALID_EXECUTION_COST"
        );
        assert!(
            policy.min_principal_atomic.0 > 0
                && policy.min_principal_atomic.0 <= policy.max_principal_atomic.0,
            "INVALID_PRINCIPAL_BOUNDS"
        );
        assert!(
            policy.max_duration_seconds > 0
                && policy.max_duration_seconds <= math::YEAR_SECONDS * 10,
            "INVALID_DURATION"
        );
        assert!(
            policy.setup_duration_seconds > 0 && policy.setup_duration_seconds <= 2_592_000,
            "INVALID_SETUP_DURATION"
        );
        assert!(
            policy.grace_seconds <= math::YEAR_SECONDS
                && policy.interest_buffer_seconds <= policy.max_duration_seconds,
            "INVALID_INTEREST_TERMS"
        );
        assert!(
            policy.ltv_bps > 0
                && policy.ltv_bps <= self.config.max_ltv_bps
                && policy.ltv_bps < policy.liquidation_threshold_bps
                && policy.liquidation_threshold_bps <= self.config.max_liquidation_threshold_bps,
            "INVALID_RISK_POLICY"
        );
    }

    pub(crate) fn nav(&self, pool: &Pool) -> u128 {
        let receivables: u128 = pool
            .loan_ids
            .iter()
            .map(|id| {
                let mut loan = self.loan(id);
                loan.accrue(Self::now());
                loan.debt()
            })
            .sum();
        pool.cash_atomic.0 + pool.in_flight_atomic.0 + receivables
    }

    pub(crate) fn available_cash(&self, pool: &Pool) -> u128 {
        pool.cash_atomic
            .0
            .checked_sub(pool.reserved_atomic.0)
            .expect("POOL_RESERVE_INVARIANT")
            .saturating_sub(pool.policy.min_liquidity_atomic.0)
    }
}
