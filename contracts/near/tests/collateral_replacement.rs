mod common;
use common::*;
use kanso_coordinator::{math::NEAR_SCALE, state::BasketLeg};
use near_sdk::json_types::U128;

#[test]
fn replacement_requires_incoming_and_preserves_debt_and_maturity() {
    let mut f = Fixture::new();
    f.funded("loan");
    let original = f.contract.get_loan("loan".into());
    call_as("borrower.near", NOW, 1);
    f.contract.commit_topup(
        "topup".into(),
        "loan".into(),
        BasketLeg {
            asset_id: "near".into(),
            custody: kanso_coordinator::state::Custody::Near,
            leg_id: "incoming".into(),
            owner: account("borrower.near"),
            amount_atomic: U128(100 * NEAR_SCALE),
            release_recipient: account("borrower.near"),
        },
    );
    f.contract.commit_replacement(
        "replace".into(),
        "loan".into(),
        "topup".into(),
        "near".into(),
        U128(100 * NEAR_SCALE),
    );
    call_as("borrower.near", NOW, 100 * NEAR_SCALE);
    let topped = f.contract.lock_native_topup("topup".into());
    call_as("borrower.near", NOW, 1);
    f.contract.finalize_replacement(
        "replace".into(),
        "release".into(),
        topped.revision.to_string(),
    );
    callback_result(&mut f.contract, "release", NOW, true);
    f.contract.finalize_transfer("release".into());
    let loan = f.contract.get_loan("loan".into());
    assert_eq!(loan.debt(), original.debt());
    assert_eq!(loan.matures_at, original.matures_at);
    assert_eq!(loan.locks[0].locked_atomic.0, 0);
    assert_eq!(loan.locks[1].locked_atomic.0, 100 * NEAR_SCALE);
}

#[test]
#[should_panic(expected = "INCOMING_NOT_VERIFIED")]
fn replacement_never_releases_before_incoming_lock() {
    let mut f = Fixture::new();
    f.funded("loan");
    call_as("borrower.near", NOW, 1);
    f.contract.commit_topup(
        "topup".into(),
        "loan".into(),
        BasketLeg {
            asset_id: "near".into(),
            custody: kanso_coordinator::state::Custody::Near,
            leg_id: "incoming".into(),
            owner: account("borrower.near"),
            amount_atomic: U128(100 * NEAR_SCALE),
            release_recipient: account("borrower.near"),
        },
    );
    f.contract.commit_replacement(
        "replace".into(),
        "loan".into(),
        "topup".into(),
        "near".into(),
        U128(100 * NEAR_SCALE),
    );
    f.contract.finalize_replacement(
        "replace".into(),
        "release".into(),
        f.contract.get_loan("loan".into()).revision.to_string(),
    );
}

#[test]
#[should_panic(expected = "UNSAFE_COLLATERAL_WITHDRAWAL")]
fn withdrawal_checks_the_basket_after_removing_collateral() {
    let mut f = Fixture::new();
    f.funded("loan");
    let loan = f.contract.get_loan("loan".into());
    call_as("borrower.near", NOW, 1);
    f.contract.withdraw_excess(
        "loan".into(),
        "near".into(),
        U128(80 * NEAR_SCALE),
        "release".into(),
        loan.revision.to_string(),
    );
}

#[test]
#[should_panic(expected = "BASKET_REVISION_CHANGED")]
fn stale_parallel_withdrawal_cannot_reuse_its_snapshot() {
    let mut f = Fixture::new();
    f.funded("loan");
    let revision = f.contract.get_loan("loan".into()).revision.to_string();
    call_as("borrower.near", NOW, 1);
    f.contract.withdraw_excess(
        "loan".into(),
        "near".into(),
        U128(NEAR_SCALE),
        "first".into(),
        revision.clone(),
    );
    f.contract.withdraw_excess(
        "loan".into(),
        "near".into(),
        U128(NEAR_SCALE),
        "second".into(),
        revision,
    );
}
