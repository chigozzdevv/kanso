mod common;
use common::*;
use kanso_coordinator::{
    config::{Network, TESTNET_USDC},
    controls::PauseFlags,
    governance::UPGRADE_DELAY_SECONDS,
    Coordinator,
};
use near_sdk::{env, json_types::U128};

fn pause(f: &mut Fixture) {
    call_as("owner.near", NOW, 1);
    f.contract.set_pause_flags(PauseFlags {
        origination: true,
        collateral_withdrawals: true,
        settlements: true,
    });
}

fn close_default_pool(f: &mut Fixture) {
    if f.contract.get_recovery_policy().is_none() {
        call_as("owner.near", NOW, 1);
        f.contract
            .configure_recovery(kanso_coordinator::recovery::RecoveryPolicy {
                public_keys: vec![ed25519_dalek::SigningKey::from_bytes(&[11; 32])
                    .verifying_key()
                    .to_bytes()
                    .to_vec()],
                threshold: 1,
            });
    }
    call_as("lp.near", NOW, 1);
    let shares = f
        .contract
        .get_position("pool".into(), account("lp.near"))
        .shares;
    f.contract
        .request_withdrawal("retire".into(), "pool".into(), shares);
    f.contract
        .claim_withdrawal("retire".into(), "retire_transfer".into());
    callback_result(&mut f.contract, "retire_transfer", NOW, true);
    call_as("relayer.near", NOW, 0);
    f.contract.finalize_transfer("retire_transfer".into());
    call_as("lp.near", NOW, 1);
    f.contract.close_pool("pool".into());
}

#[test]
fn empty_pool_closes_after_its_lp_receives_the_withdrawal() {
    let mut f = Fixture::new();
    assert_eq!(f.contract.get_pool_count(), 1);
    close_default_pool(&mut f);
    assert_eq!(f.contract.get_pool_count(), 0);
    let p = f.contract.get_position("pool".into(), account("lp.near"));
    assert_eq!(p.shares.0, 0);
    assert_eq!(p.reserved_shares.0, 0);
}

#[test]
#[should_panic(expected = "POOL_NOT_EMPTY")]
fn a_pool_with_cash_and_lp_claims_cannot_be_deleted() {
    let mut f = Fixture::new();
    call_as("lp.near", NOW, 1);
    f.contract.close_pool("pool".into());
}

#[test]
#[should_panic(expected = "MANAGER_REQUIRED")]
fn the_owner_cannot_delete_someone_elses_pool() {
    let mut f = Fixture::new();
    call_as("owner.near", NOW, 1);
    f.contract.close_pool("pool".into());
}

#[test]
fn circle_migration_requires_closed_pools_and_accepts_only_the_new_token() {
    let mut f = Fixture::with_network(Network::Testnet);
    close_default_pool(&mut f);
    pause(&mut f);
    let config = f.contract.migrate_testnet_usdc();
    assert_eq!(config.settlement_token.as_str(), TESTNET_USDC);
    assert_eq!(config.settlement_decimals, 6);
    assert_eq!(config.owner, account("owner.near"));
    call_as("lp.near", NOW, 1);
    f.contract.create_pool("usdc".into(), policy());
    call_as(TESTNET_USDC, NOW, 0);
    assert_eq!(
        f.contract
            .ft_on_transfer(
                account("lp.near"),
                U128(20_000_000),
                r#"{"kind":"pool_deposit","pool_id":"usdc","operation_id":"circle_deposit"}"#
                    .into()
            )
            .0,
        0
    );
    assert_eq!(f.contract.get_pool("usdc".into()).cash_atomic.0, 20_000_000);
    assert_eq!(
        f.contract
            .get_position("usdc".into(), account("lp.near"))
            .shares
            .0,
        20_000_000
    );
    call_as("owner.near", NOW, 1);
    assert_eq!(
        f.contract.migrate_testnet_usdc().settlement_token.as_str(),
        TESTNET_USDC
    );
}

#[test]
#[should_panic(expected = "POOLS_REMAIN")]
fn migration_cannot_relabel_existing_pool_balances() {
    let mut f = Fixture::with_network(Network::Testnet);
    pause(&mut f);
    f.contract.migrate_testnet_usdc();
}

#[test]
#[should_panic(expected = "MIGRATION_REQUIRES_PAUSE")]
fn migration_cannot_run_while_operations_are_open() {
    let mut f = Fixture::with_network(Network::Testnet);
    close_default_pool(&mut f);
    call_as("owner.near", NOW, 1);
    f.contract.migrate_testnet_usdc();
}

#[test]
#[should_panic(expected = "OWNER_REQUIRED")]
fn migration_is_owner_only() {
    let mut f = Fixture::with_network(Network::Testnet);
    call_as("borrower.near", NOW, 1);
    f.contract.migrate_testnet_usdc();
}

#[test]
#[should_panic(expected = "TESTNET_REQUIRED")]
fn the_circle_testnet_address_cannot_be_set_on_other_networks() {
    let mut f = Fixture::new();
    call_as("owner.near", NOW, 1);
    f.contract.migrate_testnet_usdc();
}

#[test]
#[should_panic(expected = "SETTLEMENT_TOKEN_REQUIRED")]
fn the_retired_token_cannot_credit_the_circle_pool() {
    let mut f = Fixture::with_network(Network::Testnet);
    close_default_pool(&mut f);
    pause(&mut f);
    f.contract.migrate_testnet_usdc();
    call_as("lp.near", NOW, 1);
    f.contract.create_pool("usdc".into(), policy());
    call_as("usdc.near", NOW, 0);
    f.contract.ft_on_transfer(
        account("lp.near"),
        U128(1_000_000),
        r#"{"kind":"pool_deposit","pool_id":"usdc","operation_id":"old_deposit"}"#.into(),
    );
}

#[test]
fn a_closed_pool_does_not_leave_a_manager_transfer_for_a_replacement() {
    let mut f = Fixture::new();
    call_as("lp.near", NOW, 1);
    f.contract
        .propose_pool_manager("pool".into(), account("next.near"));
    close_default_pool(&mut f);
    call_as("borrower.near", NOW, 1);
    f.contract.create_pool("pool".into(), policy());
    assert!(f.contract.get_pending_pool_manager("pool".into()).is_none());
}

#[test]
fn upgrade_backfills_the_two_legacy_pools_without_resetting_the_root_state() {
    let mut f = Fixture::with_network(Network::Testnet);
    close_default_pool(&mut f);
    call_as("lp.near", NOW, 1);
    f.contract.create_pool("test-usdc".into(), policy());
    f.contract.create_pool("live-verification".into(), policy());
    env::storage_remove(b"\0kanso:pool-count:v1");
    call_as("owner.near", NOW, 1);
    f.contract
        .schedule_upgrade(vec![7; 32], NOW + UPGRADE_DELAY_SECONDS);
    env::state_write(&f.contract);
    call_as("kanso.near", NOW + UPGRADE_DELAY_SECONDS, 0);
    let c = Coordinator::migrate(vec![7; 32], 1);
    assert_eq!(c.get_pool_count(), 2);
    assert_eq!(c.get_config().settlement_token, account("usdc.near"));
    assert_eq!(c.get_upgrade_status().minimum_delay_seconds, 60);
}

fn escrow_after_pool_closure() -> Fixture {
    use kanso_coordinator::settlement::{SettlementKind, SettlementPlan};
    let mut f = Fixture::with_network(Network::Testnet);
    let mut offer = f.offer("cancelled");
    offer.network = Network::Testnet;
    call_as("borrower.near", NOW, 1);
    f.contract.accept_offer(offer);
    f.contract.abort_setup("cancelled".into());
    close_default_pool(&mut f);
    call_as("payer.near", NOW, 1);
    f.contract.quote_settlement(SettlementPlan {
        operation_id: "unused_quote".into(),
        loan_id: "cancelled".into(),
        expected_revision: "2".into(),
        leg_id: "near".into(),
        input_atomic: U128(1),
        net_output_atomic: U128(100_000),
        execution_cost_atomic: U128(0),
        max_source_fee_atomic: U128(0),
        solver: account("payer.near"),
        source_recipient: account("payer.near"),
        remote_recipient: vec![],
        expires_at: NOW + 300,
        kind: SettlementKind::Repayment,
        conditional_version: 0,
    });
    call_as("usdc.near", NOW, 0);
    f.contract.ft_on_transfer(
        account("payer.near"),
        U128(100_000),
        r#"{"kind":"solver_escrow","operation_id":"unused_quote"}"#.into(),
    );
    f
}

#[test]
#[should_panic(expected = "SETTLEMENT_LIABILITIES_REMAIN")]
fn closed_pools_do_not_allow_a_token_switch_while_solver_escrow_remains() {
    let mut f = escrow_after_pool_closure();
    pause(&mut f);
    f.contract.migrate_testnet_usdc();
}

#[test]
#[should_panic(expected = "SETTLEMENT_LIABILITIES_REMAIN")]
fn an_unclaimed_refund_also_blocks_the_token_switch() {
    let mut f = escrow_after_pool_closure();
    call_as("payer.near", NOW, 1);
    f.contract.cancel_settlement("unused_quote".into());
    pause(&mut f);
    f.contract.migrate_testnet_usdc();
}

#[test]
fn returning_the_last_refund_allows_the_token_switch() {
    let mut f = escrow_after_pool_closure();
    call_as("payer.near", NOW, 1);
    let refund_id = f
        .contract
        .cancel_settlement("unused_quote".into())
        .refund_id
        .unwrap();
    f.contract
        .claim_refund(refund_id.clone(), "refund_transfer".into());
    callback_result(&mut f.contract, "refund_transfer", NOW, true);
    call_as("relayer.near", NOW, 0);
    f.contract.finalize_transfer("refund_transfer".into());
    assert!(f.contract.get_refund(refund_id).unwrap().paid);
    pause(&mut f);
    assert_eq!(
        f.contract.migrate_testnet_usdc().settlement_token.as_str(),
        TESTNET_USDC
    );
    assert_eq!(f.contract.get_loan("cancelled".into()).loan_id, "cancelled");
}
