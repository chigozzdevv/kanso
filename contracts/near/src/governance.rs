use crate::{events, Coordinator, CoordinatorExt};
use near_sdk::{
    env, json_types::Base64VecU8, near, serde_json::json, AccountId, Gas, NearToken, Promise,
};

pub const UPGRADE_DELAY_SECONDS: u64 = 60;
pub const STATE_VERSION: u32 = 1;
const GOVERNANCE_KEY: &[u8] = b"\0kanso:governance:v1";
const UPGRADE_CODE_KEY: &[u8] = b"\0kanso:upgrade-code:v1";

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Governance {
    pub pending_owner: Option<AccountId>,
    pub pending_upgrade: Option<UpgradeProposal>,
    pub last_upgrade_hash: Option<Vec<u8>>,
    pub revision: u64,
}
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub struct UpgradeProposal {
    pub code_hash: Vec<u8>,
    pub execute_after: u64,
    pub from_state_version: u32,
}
#[near(serializers = [json])]
pub struct UpgradeStatus {
    pub state_version: u32,
    pub minimum_delay_seconds: u64,
    pub governance: Governance,
    pub staged_bytes: u32,
}

// Keep governance metadata separate so adding upgrade controls preserves the existing root state.
fn read_governance() -> Governance {
    env::storage_read(GOVERNANCE_KEY)
        .map(|bytes| near_sdk::borsh::from_slice(&bytes).expect("INVALID_GOVERNANCE_STATE"))
        .unwrap_or_default()
}
fn write_governance(g: &Governance) {
    env::storage_write(GOVERNANCE_KEY, &near_sdk::borsh::to_vec(g).unwrap());
}
fn manager_key(pool_id: &str) -> Vec<u8> {
    [b"\0kanso:manager:v1:".as_slice(), pool_id.as_bytes()].concat()
}

pub(crate) fn clear_pool_manager(pool_id: &str) {
    env::storage_remove(&manager_key(pool_id));
}

#[near]
impl Coordinator {
    pub fn get_upgrade_status(&self) -> UpgradeStatus {
        UpgradeStatus {
            state_version: STATE_VERSION,
            minimum_delay_seconds: UPGRADE_DELAY_SECONDS,
            governance: read_governance(),
            staged_bytes: env::storage_read(UPGRADE_CODE_KEY).map_or(0, |v| v.len() as u32),
        }
    }
    #[payable]
    pub fn propose_owner(&mut self, new_owner: AccountId) {
        Self::one_yocto();
        self.assert_owner();
        assert_ne!(new_owner, self.config.owner, "OWNER_UNCHANGED");
        assert_ne!(new_owner, env::current_account_id(), "INVALID_OWNER");
        let before = env::storage_usage();
        let mut g = read_governance();
        g.pending_owner = Some(new_owner.clone());
        g.revision += 1;
        write_governance(&g);
        self.charge_storage(&self.config.owner.clone(), before);
        events::emit(
            &self.config.deployment_id,
            "OwnerProposed",
            "governance",
            g.revision,
            json!({"new_owner":new_owner}),
        );
    }
    #[payable]
    pub fn accept_owner(&mut self) {
        Self::one_yocto();
        let mut g = read_governance();
        let new_owner = g.pending_owner.take().expect("OWNER_TRANSFER_NOT_PENDING");
        assert_eq!(
            env::predecessor_account_id(),
            new_owner,
            "PROPOSED_OWNER_REQUIRED"
        );
        self.config.owner = new_owner.clone();
        g.pending_upgrade = None;
        env::storage_remove(UPGRADE_CODE_KEY);
        g.revision += 1;
        write_governance(&g);
        events::emit(
            &self.config.deployment_id,
            "OwnerAccepted",
            "governance",
            g.revision,
            json!({"owner":new_owner}),
        );
    }
    #[payable]
    pub fn cancel_owner_transfer(&mut self) {
        Self::one_yocto();
        self.assert_owner();
        let mut g = read_governance();
        g.pending_owner = None;
        g.revision += 1;
        write_governance(&g);
    }
    #[payable]
    pub fn schedule_upgrade(&mut self, code_hash: Vec<u8>, execute_after: u64) -> UpgradeProposal {
        Self::one_yocto();
        self.assert_owner();
        assert!(
            code_hash.len() == 32 && code_hash.iter().any(|b| *b != 0),
            "INVALID_CODE_HASH"
        );
        let proposal = UpgradeProposal {
            code_hash,
            execute_after,
            from_state_version: STATE_VERSION,
        };
        let mut g = read_governance();
        if let Some(existing) = g.pending_upgrade {
            assert_eq!(existing, proposal, "UPGRADE_ALREADY_PENDING");
            return existing;
        }
        assert!(
            execute_after
                >= Self::now()
                    .checked_add(UPGRADE_DELAY_SECONDS)
                    .expect("TIME_OVERFLOW"),
            "UPGRADE_DELAY_REQUIRED"
        );
        assert!(
            execute_after <= Self::now().checked_add(2_592_000).expect("TIME_OVERFLOW"),
            "UPGRADE_TOO_FAR"
        );
        let before = env::storage_usage();
        g.pending_upgrade = Some(proposal.clone());
        g.revision += 1;
        write_governance(&g);
        self.charge_storage(&self.config.owner.clone(), before);
        events::emit(
            &self.config.deployment_id,
            "UpgradeScheduled",
            "governance",
            g.revision,
            json!({"proposal":proposal}),
        );
        proposal
    }
    #[payable]
    pub fn cancel_upgrade(&mut self, code_hash: Vec<u8>) {
        Self::one_yocto();
        self.assert_owner();
        let mut g = read_governance();
        assert_eq!(
            g.pending_upgrade
                .as_ref()
                .expect("UPGRADE_NOT_PENDING")
                .code_hash,
            code_hash,
            "CODE_HASH_MISMATCH"
        );
        g.pending_upgrade = None;
        env::storage_remove(UPGRADE_CODE_KEY);
        g.revision += 1;
        write_governance(&g);
        events::emit(
            &self.config.deployment_id,
            "UpgradeCancelled",
            "governance",
            g.revision,
            json!({"code_hash":code_hash}),
        );
    }
    #[payable]
    pub fn stage_upgrade_chunk(
        &mut self,
        code_hash: Vec<u8>,
        offset: u32,
        chunk: Base64VecU8,
    ) -> u32 {
        Self::one_yocto();
        self.assert_owner();
        let proposal = read_governance()
            .pending_upgrade
            .expect("UPGRADE_NOT_PENDING");
        assert_eq!(proposal.code_hash, code_hash, "CODE_HASH_MISMATCH");
        assert!(
            !chunk.0.is_empty() && chunk.0.len() <= 128_000,
            "INVALID_UPGRADE_CHUNK"
        );
        let before = env::storage_usage();
        let mut code = env::storage_read(UPGRADE_CODE_KEY).unwrap_or_default();
        let start = offset as usize;
        let end = start.checked_add(chunk.0.len()).expect("CHUNK_OVERFLOW");
        if start < code.len() {
            assert!(
                code.get(start..end) == Some(chunk.0.as_slice()),
                "CHUNK_CONFLICT"
            );
            return code.len() as u32;
        }
        assert_eq!(start, code.len(), "UPGRADE_CHUNK_ORDER");
        assert!(end <= 4_000_000, "UPGRADE_TOO_LARGE");
        code.extend_from_slice(&chunk.0);
        assert!(code.starts_with(b"\0asm"), "INVALID_WASM");
        env::storage_write(UPGRADE_CODE_KEY, &code);
        self.charge_storage(&self.config.owner.clone(), before);
        end as u32
    }
    #[payable]
    pub fn execute_upgrade(&mut self, code: Option<Base64VecU8>) -> Promise {
        Self::one_yocto();
        self.assert_owner();
        let proposal = read_governance()
            .pending_upgrade
            .expect("UPGRADE_NOT_PENDING");
        assert!(Self::now() >= proposal.execute_after, "UPGRADE_TIMELOCK");
        let code = code.map(|v| v.0).unwrap_or_else(|| {
            env::storage_read(UPGRADE_CODE_KEY).expect("UPGRADE_CODE_NOT_STAGED")
        });
        assert!(
            code.len() <= 4_000_000 && code.starts_with(b"\0asm"),
            "INVALID_WASM"
        );
        assert_eq!(env::sha256(&code), proposal.code_hash, "CODE_HASH_MISMATCH");
        assert!(
            env::prepaid_gas() >= Gas::from_tgas(200),
            "UPGRADE_GAS_REQUIRED"
        );
        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call(
                "migrate",
                near_sdk::serde_json::to_vec(&json!({
                    "expected_code_hash": proposal.code_hash,
                    "from_state_version": proposal.from_state_version,
                }))
                .unwrap(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(100),
            )
    }
    #[init(ignore_state)]
    #[private]
    pub fn migrate(expected_code_hash: Vec<u8>, from_state_version: u32) -> Self {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "PRIVATE_MIGRATION"
        );
        assert_eq!(
            from_state_version, STATE_VERSION,
            "UNSUPPORTED_STATE_VERSION"
        );
        let mut g = read_governance();
        let proposal = g.pending_upgrade.take().expect("UPGRADE_NOT_PENDING");
        assert_eq!(proposal.code_hash, expected_code_hash, "CODE_HASH_MISMATCH");
        assert_eq!(
            proposal.from_state_version, from_state_version,
            "STATE_VERSION_MISMATCH"
        );
        assert!(Self::now() >= proposal.execute_after, "UPGRADE_TIMELOCK");
        let state: Self = env::state_read().expect("STATE_MISSING");
        state.migrate_pool_registry();
        g.last_upgrade_hash = Some(expected_code_hash);
        env::storage_remove(UPGRADE_CODE_KEY);
        g.revision += 1;
        write_governance(&g);
        events::emit(
            &state.config.deployment_id,
            "UpgradeCompleted",
            "governance",
            g.revision,
            json!({"code_hash":g.last_upgrade_hash,"state_version":STATE_VERSION}),
        );
        state
    }
    pub fn get_pending_pool_manager(&self, pool_id: String) -> Option<AccountId> {
        self.pool(&pool_id);
        env::storage_read(&manager_key(&pool_id))
            .map(|v| near_sdk::borsh::from_slice(&v).expect("INVALID_MANAGER_TRANSFER"))
    }
    #[payable]
    pub fn propose_pool_manager(&mut self, pool_id: String, new_manager: AccountId) {
        Self::one_yocto();
        let pool = self.pool(&pool_id);
        assert_eq!(
            env::predecessor_account_id(),
            pool.manager,
            "MANAGER_REQUIRED"
        );
        assert_ne!(new_manager, pool.manager, "MANAGER_UNCHANGED");
        let before = env::storage_usage();
        env::storage_write(
            &manager_key(&pool_id),
            &near_sdk::borsh::to_vec(&new_manager).unwrap(),
        );
        self.charge_storage(&pool.manager, before);
    }
    #[payable]
    pub fn accept_pool_manager(
        &mut self,
        pool_id: String,
        expected_revision: String,
    ) -> crate::state::Pool {
        Self::one_yocto();
        let mut pool = self.pool(&pool_id);
        let manager = self
            .get_pending_pool_manager(pool_id.clone())
            .expect("MANAGER_TRANSFER_NOT_PENDING");
        assert_eq!(
            env::predecessor_account_id(),
            manager,
            "PROPOSED_MANAGER_REQUIRED"
        );
        assert_eq!(
            pool.revision.to_string(),
            expected_revision,
            "POOL_REVISION_CHANGED"
        );
        env::storage_remove(&manager_key(&pool_id));
        pool.manager = manager;
        pool.revision += 1;
        self.pools.insert(&pool_id, &pool);
        events::emit(
            &self.config.deployment_id,
            "PoolManagerAccepted",
            &pool_id,
            pool.revision,
            json!({"manager":pool.manager}),
        );
        pool
    }
    #[payable]
    pub fn cancel_pool_manager_transfer(&mut self, pool_id: String) {
        Self::one_yocto();
        let pool = self.pool(&pool_id);
        assert_eq!(
            env::predecessor_account_id(),
            pool.manager,
            "MANAGER_REQUIRED"
        );
        env::storage_remove(&manager_key(&pool_id));
    }
}
impl Coordinator {
    pub(crate) fn assert_owner(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.config.owner,
            "OWNER_REQUIRED"
        );
    }
}
