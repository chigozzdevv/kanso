mod common;
use common::*;
use kanso_coordinator::{governance::UPGRADE_DELAY_SECONDS, Coordinator};
use near_sdk::{env, json_types::Base64VecU8};

#[test]
fn migration_preserves_loans_pool_shares_reservations_and_owner() {
    let mut f = Fixture::new();
    f.funded("loan");
    call_as("owner.near", NOW + UPGRADE_DELAY_SECONDS, 1);
    let before = near_sdk::serde_json::to_value(f.contract.get_loan("loan".into())).unwrap();
    let pool = near_sdk::serde_json::to_value(f.contract.get_pool("pool".into())).unwrap();
    let position =
        near_sdk::serde_json::to_value(f.contract.get_position("pool".into(), account("lp.near")))
            .unwrap();
    call_as("owner.near", NOW, 1);
    f.contract
        .schedule_upgrade(vec![7; 32], NOW + UPGRADE_DELAY_SECONDS);
    env::state_write(&f.contract);
    call_as("kanso.near", NOW + UPGRADE_DELAY_SECONDS, 0);
    let c = Coordinator::migrate(vec![7; 32], 1);
    assert_eq!(
        near_sdk::serde_json::to_value(c.get_loan("loan".into())).unwrap(),
        before
    );
    assert_eq!(
        near_sdk::serde_json::to_value(c.get_pool("pool".into())).unwrap(),
        pool
    );
    assert_eq!(
        near_sdk::serde_json::to_value(c.get_position("pool".into(), account("lp.near"))).unwrap(),
        position
    );
    assert_eq!(c.get_config().owner, account("owner.near"));
    assert!(c.get_upgrade_status().governance.pending_upgrade.is_none());
    assert_eq!(
        c.get_upgrade_status().governance.last_upgrade_hash,
        Some(vec![7; 32])
    );
}
#[test]
#[should_panic(expected = "OWNER_REQUIRED")]
fn only_owner_can_schedule_upgrade() {
    let mut f = Fixture::new();
    call_as("borrower.near", NOW, 1);
    f.contract
        .schedule_upgrade(vec![7; 32], NOW + UPGRADE_DELAY_SECONDS);
}
#[test]
#[should_panic(expected = "UPGRADE_DELAY_REQUIRED")]
fn upgrade_cannot_skip_delay() {
    let mut f = Fixture::new();
    call_as("owner.near", NOW, 1);
    f.contract.schedule_upgrade(vec![7; 32], NOW);
}
#[test]
#[should_panic(expected = "UPGRADE_TIMELOCK")]
fn upgrade_cannot_execute_early() {
    let mut f = Fixture::new();
    call_as("owner.near", NOW, 1);
    f.contract
        .schedule_upgrade(vec![7; 32], NOW + UPGRADE_DELAY_SECONDS);
    let _ = f
        .contract
        .execute_upgrade(Some(Base64VecU8(b"\0asm".to_vec())));
}
#[test]
#[should_panic(expected = "CODE_HASH_MISMATCH")]
fn upgrade_rejects_different_wasm() {
    let mut f = Fixture::new();
    call_as("owner.near", NOW, 1);
    f.contract
        .schedule_upgrade(vec![7; 32], NOW + UPGRADE_DELAY_SECONDS);
    call_as("owner.near", NOW + UPGRADE_DELAY_SECONDS, 1);
    let _ = f
        .contract
        .execute_upgrade(Some(Base64VecU8(b"\0asm".to_vec())));
}
#[test]
#[should_panic(expected = "PRIVATE_MIGRATION")]
fn migration_cannot_be_called_by_owner() {
    let _f = Fixture::new();
    call_as("owner.near", NOW, 0);
    Coordinator::migrate(vec![7; 32], 1);
}
#[test]
fn owner_handoff_requires_acceptance_and_cancels_old_upgrade() {
    let mut f = Fixture::new();
    call_as("owner.near", NOW, 1);
    f.contract
        .schedule_upgrade(vec![7; 32], NOW + UPGRADE_DELAY_SECONDS);
    f.contract.propose_owner(account("next.near"));
    assert_eq!(f.contract.get_config().owner, account("owner.near"));
    call_as("next.near", NOW, 1);
    f.contract.accept_owner();
    assert_eq!(f.contract.get_config().owner, account("next.near"));
    assert!(f
        .contract
        .get_upgrade_status()
        .governance
        .pending_upgrade
        .is_none());
}
#[test]
#[should_panic(expected = "PROPOSED_OWNER_REQUIRED")]
fn unrelated_account_cannot_accept_ownership() {
    let mut f = Fixture::new();
    call_as("owner.near", NOW, 1);
    f.contract.propose_owner(account("next.near"));
    call_as("borrower.near", NOW, 1);
    f.contract.accept_owner();
}
#[test]
fn pool_manager_handoff_preserves_positions_and_accepted_terms() {
    let mut f = Fixture::new();
    f.funded("loan");
    let terms = f.contract.get_loan("loan".into()).policy;
    let shares = f
        .contract
        .get_position("pool".into(), account("lp.near"))
        .shares;
    call_as("lp.near", NOW, 1);
    f.contract
        .propose_pool_manager("pool".into(), account("next.near"));
    assert_eq!(
        f.contract.get_pool("pool".into()).manager,
        account("lp.near")
    );
    let rev = f.contract.get_pool("pool".into()).revision.to_string();
    call_as("next.near", NOW, 1);
    f.contract.accept_pool_manager("pool".into(), rev);
    let mut policy = policy();
    policy.version = 2;
    policy.apr_bps = 2000;
    f.contract.update_pool_policy("pool".into(), policy);
    assert_eq!(
        f.contract
            .get_position("pool".into(), account("lp.near"))
            .shares,
        shares
    );
    assert_eq!(
        f.contract.get_loan("loan".into()).policy.apr_bps,
        terms.apr_bps
    );
}
#[test]
#[should_panic(expected = "MANAGER_REQUIRED")]
fn protocol_owner_cannot_replace_pool_manager() {
    let mut f = Fixture::new();
    call_as("owner.near", NOW, 1);
    f.contract
        .propose_pool_manager("pool".into(), account("owner.near"));
}
#[test]
fn cancelled_upgrade_has_no_executable_proposal() {
    let mut f = Fixture::new();
    call_as("owner.near", NOW, 1);
    f.contract
        .schedule_upgrade(vec![7; 32], NOW + UPGRADE_DELAY_SECONDS);
    f.contract.cancel_upgrade(vec![7; 32]);
    assert!(f
        .contract
        .get_upgrade_status()
        .governance
        .pending_upgrade
        .is_none());
}

#[test]
fn chunk_retries_are_idempotent_and_cancellation_clears_staged_code() {
    let mut f = Fixture::new();
    call_as("owner.near", NOW, 1);
    f.contract
        .schedule_upgrade(vec![7; 32], NOW + UPGRADE_DELAY_SECONDS);
    let chunk = Base64VecU8(b"\0asm\x01\0\0\0".to_vec());
    assert_eq!(
        f.contract
            .stage_upgrade_chunk(vec![7; 32], 0, chunk.clone()),
        8
    );
    assert_eq!(f.contract.stage_upgrade_chunk(vec![7; 32], 0, chunk), 8);
    assert_eq!(f.contract.get_upgrade_status().staged_bytes, 8);
    f.contract.cancel_upgrade(vec![7; 32]);
    assert_eq!(f.contract.get_upgrade_status().staged_bytes, 0);
}

#[test]
#[should_panic(expected = "UPGRADE_CHUNK_ORDER")]
fn staging_cannot_skip_bytes() {
    let mut f = Fixture::new();
    call_as("owner.near", NOW, 1);
    f.contract
        .schedule_upgrade(vec![7; 32], NOW + UPGRADE_DELAY_SECONDS);
    f.contract
        .stage_upgrade_chunk(vec![7; 32], 1, Base64VecU8(b"\0asm".to_vec()));
}

#[test]
#[should_panic(expected = "CHUNK_CONFLICT")]
fn staging_cannot_replace_previously_uploaded_bytes() {
    let mut f = Fixture::new();
    call_as("owner.near", NOW, 1);
    f.contract
        .schedule_upgrade(vec![7; 32], NOW + UPGRADE_DELAY_SECONDS);
    f.contract
        .stage_upgrade_chunk(vec![7; 32], 0, Base64VecU8(b"\0asm\x01".to_vec()));
    f.contract
        .stage_upgrade_chunk(vec![7; 32], 0, Base64VecU8(b"\0asm\x02".to_vec()));
}

#[test]
#[should_panic(expected = "OWNER_REQUIRED")]
fn only_owner_can_stage_upgrade_code() {
    let mut f = Fixture::new();
    call_as("owner.near", NOW, 1);
    f.contract
        .schedule_upgrade(vec![7; 32], NOW + UPGRADE_DELAY_SECONDS);
    call_as("borrower.near", NOW, 1);
    f.contract
        .stage_upgrade_chunk(vec![7; 32], 0, Base64VecU8(b"\0asm".to_vec()));
}

#[test]
#[should_panic(expected = "CODE_HASH_MISMATCH")]
fn partial_staged_code_cannot_be_deployed() {
    let mut f = Fixture::new();
    call_as("owner.near", NOW, 1);
    f.contract
        .schedule_upgrade(vec![7; 32], NOW + UPGRADE_DELAY_SECONDS);
    f.contract
        .stage_upgrade_chunk(vec![7; 32], 0, Base64VecU8(b"\0asm".to_vec()));
    call_as("owner.near", NOW + UPGRADE_DELAY_SECONDS, 1);
    let _ = f.contract.execute_upgrade(None);
}

#[test]
#[should_panic(expected = "POOL_REVISION_CHANGED")]
fn manager_acceptance_rejects_stale_pool_revision() {
    let mut f = Fixture::new();
    call_as("lp.near", NOW, 1);
    f.contract
        .propose_pool_manager("pool".into(), account("next.near"));
    call_as("next.near", NOW, 1);
    f.contract.accept_pool_manager("pool".into(), "0".into());
}
