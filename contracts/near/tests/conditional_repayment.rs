mod common;
use common::*;
use kanso_coordinator::{
    conditional_repayment::{ConditionalTerms, SpendLimit},
    math::NEAR_SCALE,
    settlement::{SettlementKind, SettlementPlan},
    state::Price,
};
use near_sdk::json_types::U128;
fn terms(enabled: bool) -> ConditionalTerms {
    ConditionalTerms {
        enabled,
        trigger_health_ppm: 1_500_000,
        target_health_ppm: 2_000_000,
        max_total_repayment_atomic: U128(60_000_000),
        max_collateral_spend: vec![SpendLimit {
            asset_id: "near".into(),
            max_total_atomic: U128(30 * NEAR_SCALE),
        }],
        max_execution_cost_bps: 500,
        max_execution_cost_atomic: U128(1_000_000),
        expires_at: None,
    }
}
fn prepare(f: &mut Fixture) {
    f.funded("loan");
    call_as("borrower.near", NOW, 1);
    f.contract
        .set_conditional_repayment("loan".into(), 0, terms(true));
    call_as("oracle.near", NOW, 0);
    f.contract.publish_price(Price {
        price_atomic: U128(2_000_000),
        confidence_bps: 0,
        published_at: NOW,
        sequence: 2,
    });
    let revision = f.contract.get_loan("loan".into()).revision.to_string();
    call_as("payer.near", NOW, 1);
    f.contract.quote_settlement(SettlementPlan {
        operation_id: "conditional".into(),
        loan_id: "loan".into(),
        expected_revision: revision,
        leg_id: "near".into(),
        input_atomic: U128(20 * NEAR_SCALE),
        net_output_atomic: U128(40_000_000),
        execution_cost_atomic: U128(0),
        max_source_fee_atomic: U128(0),
        solver: account("payer.near"),
        source_recipient: account("payer.near"),
        remote_recipient: vec![],
        expires_at: NOW + 300,
        kind: SettlementKind::Conditional,
        conditional_version: 1,
    });
    call_as("usdc.near", NOW, 0);
    f.contract.ft_on_transfer(
        account("payer.near"),
        U128(40_000_000),
        r#"{"kind":"solver_escrow","operation_id":"conditional"}"#.into(),
    );
    call_as("payer.near", NOW, 1);
    f.contract
        .commit_settlement("conditional".into(), "delivery".into());
}
#[test]
fn pause_and_reenable_preserve_lifetime_consumption_and_committed_reservations() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let auth = f.contract.get_conditional_repayment("loan".into()).unwrap();
    assert_eq!(auth.reserved_repayment_atomic.0, 40_000_000);
    call_as("borrower.near", NOW, 1);
    let paused = f
        .contract
        .set_conditional_repayment("loan".into(), 1, terms(false));
    assert_eq!(paused.reserved_repayment_atomic.0, 40_000_000);
    callback_result(&mut f.contract, "delivery", NOW, true);
    f.contract.finalize_transfer("delivery".into());
    f.contract.apply_settlement("conditional".into());
    let auth = f.contract.get_conditional_repayment("loan".into()).unwrap();
    assert_eq!(auth.consumed_repayment_atomic.0, 40_000_000);
    assert_eq!(auth.reserved_repayment_atomic.0, 0);
    assert_eq!(auth.spend[0].consumed_atomic.0, 20 * NEAR_SCALE);
    call_as("borrower.near", NOW, 1);
    let enabled = f
        .contract
        .set_conditional_repayment("loan".into(), 2, terms(true));
    assert_eq!(enabled.consumed_repayment_atomic.0, 40_000_000);
    assert_eq!(enabled.spend[0].consumed_atomic.0, 20 * NEAR_SCALE);
}
#[test]
#[should_panic(expected = "REPAYMENT_CAP_BELOW_USAGE")]
fn lowering_limits_cannot_erase_an_inflight_reservation() {
    let mut f = Fixture::new();
    prepare(&mut f);
    call_as("borrower.near", NOW, 1);
    let mut t = terms(false);
    t.max_total_repayment_atomic = U128(39_999_999);
    f.contract.set_conditional_repayment("loan".into(), 1, t);
}
#[test]
#[should_panic(expected = "CANNOT_DROP_USAGE_HISTORY")]
fn new_versions_cannot_drop_spent_asset_history() {
    let mut f = Fixture::new();
    prepare(&mut f);
    callback_result(&mut f.contract, "delivery", NOW, true);
    f.contract.finalize_transfer("delivery".into());
    f.contract.apply_settlement("conditional".into());
    call_as("borrower.near", NOW, 1);
    let mut t = terms(true);
    t.max_collateral_spend[0].asset_id = "btc".into();
    f.contract.set_conditional_repayment("loan".into(), 1, t);
}
#[test]
fn absence_is_distinct_from_a_paused_authorization() {
    let mut f = Fixture::new();
    f.funded("loan");
    assert!(f
        .contract
        .get_conditional_repayment("loan".into())
        .is_none());
    call_as("borrower.near", NOW, 1);
    let a = f
        .contract
        .set_conditional_repayment("loan".into(), 0, terms(false));
    assert!(!a.terms.enabled);
}
