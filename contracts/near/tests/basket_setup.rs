mod common;

use common::*;
use kanso_coordinator::{
    math::NEAR_SCALE,
    state::{BasketLeg, LoanState, SetupState},
};
use near_sdk::json_types::U128;

#[test]
fn successful_locks_survive_an_incomplete_basket() {
    let mut fixture = Fixture::new();
    let mut offer = fixture.offer("loan");
    offer.legs.push(BasketLeg {
        asset_id: "near".into(),
        custody: kanso_coordinator::state::Custody::Near,
        leg_id: "second".to_owned(),
        owner: account("borrower.near"),
        amount_atomic: U128(NEAR_SCALE),
        release_recipient: account("borrower.near"),
    });
    call_as("borrower.near", NOW, 1);
    fixture.contract.accept_offer(offer);
    call_as("borrower.near", NOW, 100 * NEAR_SCALE);
    let loan = fixture
        .contract
        .lock_native("loan".to_owned(), "near".to_owned());
    assert_eq!(loan.setup_state, SetupState::Locking);
    assert!(loan.locks[0].accepted);
    assert!(!loan.locks[1].accepted);
    call_as("borrower.near", NOW, NEAR_SCALE);
    let loan = fixture
        .contract
        .lock_native("loan".to_owned(), "second".to_owned());
    assert_eq!(loan.setup_state, SetupState::Ready);
    assert_eq!(loan.locks[0].locked_atomic.0, 100 * NEAR_SCALE);
}

#[test]
fn expired_setup_releases_liquidity_and_preserves_late_deposit_recovery() {
    let mut fixture = Fixture::new();
    fixture.reserve("loan");
    call_as("payer.near", NOW + 600, 1);
    let loan = fixture.contract.abort_setup("loan".to_owned());
    assert_eq!(loan.state, LoanState::Cancelled);
    assert_eq!(loan.setup_state, SetupState::Aborted);
    assert_eq!(
        fixture.contract.pool_available_cash("pool".to_owned()).0,
        1_000_000_000
    );
    call_as("borrower.near", NOW + 700, 100 * NEAR_SCALE);
    let loan = fixture
        .contract
        .lock_native("loan".to_owned(), "near".to_owned());
    assert_eq!(loan.state, LoanState::Cancelled);
    assert_eq!(loan.setup_state, SetupState::Aborting);
    call_as("borrower.near", NOW + 700, 1);
    fixture
        .contract
        .release_collateral("loan".to_owned(), "near".to_owned(), "release".to_owned());
    callback_result(&mut fixture.contract, "release", NOW + 700, true);
    fixture.contract.finalize_transfer("release".to_owned());
    assert_eq!(
        fixture.contract.get_loan("loan".to_owned()).setup_state,
        SetupState::Aborted
    );
}

#[test]
#[should_panic(expected = "POOL_CAPACITY_CHANGED")]
fn competing_acceptances_cannot_reserve_the_same_cash() {
    let mut fixture = Fixture::new();
    let mut offer = fixture.offer("first");
    offer.principal_atomic = U128(600_000_000);
    offer.legs[0].amount_atomic = U128(1000 * NEAR_SCALE);
    call_as("borrower.near", NOW, 1);
    fixture.contract.accept_offer(offer.clone());
    offer.offer_id = "second".to_owned();
    fixture.contract.accept_offer(offer);
}

#[test]
#[should_panic(expected = "LOCK_NOT_VERIFIED")]
fn partial_basket_cannot_fund() {
    let mut fixture = Fixture::new();
    fixture.reserve("loan");
    call_as("borrower.near", NOW, 1);
    fixture
        .contract
        .fund_loan("loan".to_owned(), "fund".to_owned());
}

#[test]
#[should_panic(expected = "IDEMPOTENCY_CONFLICT")]
fn accepted_offer_cannot_change_under_the_same_identity() {
    let mut fixture = Fixture::new();
    fixture.reserve("loan");
    let mut offer = fixture.offer("loan");
    offer.principal_atomic = U128(1);
    call_as("borrower.near", NOW, 1);
    fixture.contract.accept_offer(offer);
}

#[test]
#[should_panic(expected = "DISBURSEMENT_UNRESOLVED")]
fn timeout_does_not_cancel_an_unknown_payout() {
    let mut fixture = Fixture::new();
    fixture.ready("loan");
    call_as("borrower.near", NOW, 1);
    fixture
        .contract
        .fund_loan("loan".to_owned(), "fund".to_owned());
    call_as("borrower.near", NOW + 1000, 1);
    fixture.contract.abort_setup("loan".to_owned());
}

#[test]
#[should_panic(expected = "SETUP_EXPIRED")]
fn expired_reservation_cannot_fund_even_when_all_locks_are_present() {
    let mut fixture = Fixture::new();
    fixture.ready("loan");
    call_as("borrower.near", NOW + 600, 1);
    fixture
        .contract
        .fund_loan("loan".to_owned(), "fund".to_owned());
}

#[test]
#[should_panic(expected = "DEBT_NOT_CLEARED")]
fn borrower_cannot_release_collateral_while_debt_is_active() {
    let mut fixture = Fixture::new();
    fixture.funded("loan");
    call_as("borrower.near", NOW, 1);
    fixture
        .contract
        .release_collateral("loan".to_owned(), "near".to_owned(), "release".to_owned());
}

#[test]
#[should_panic(expected = "PRICE_STALE")]
fn funding_rechecks_price_freshness() {
    let mut fixture = Fixture::new();
    fixture.ready("loan");
    call_as("borrower.near", NOW + 301, 1);
    fixture
        .contract
        .fund_loan("loan".to_owned(), "fund".to_owned());
}

#[test]
#[should_panic(expected = "SETTLEMENT_TOKEN_REQUIRED")]
fn matching_symbol_does_not_authorize_a_different_token() {
    let mut fixture = Fixture::new();
    call_as("imposter.near", NOW, 0);
    fixture.contract.ft_on_transfer(
        account("lp.near"),
        U128(1_000_000),
        r#"{"kind":"pool_deposit","pool_id":"pool","operation_id":"fake"}"#.to_owned(),
    );
}
