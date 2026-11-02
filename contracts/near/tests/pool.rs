mod common;

use common::*;
use kanso_coordinator::{math, state::TransferOutcome};
use near_sdk::json_types::U128;

#[test]
fn share_pricing_includes_interest_accrued_since_the_last_loan_write() {
    let mut fixture = Fixture::new();
    fixture.funded("loan");
    call_as("usdc.near", NOW + math::YEAR_SECONDS, 0);
    assert_eq!(
        fixture.contract.pool_nav("pool".to_owned()).0,
        1_010_000_000
    );
    fixture.contract.ft_on_transfer(
        account("payer.near"),
        U128(100_000_000),
        r#"{"kind":"pool_deposit","pool_id":"pool","operation_id":"second"}"#.to_owned(),
    );
    let position = fixture
        .contract
        .get_position("pool".to_owned(), account("payer.near"));
    assert_eq!(position.shares.0, 99_009_900);
}

#[test]
fn shares_burn_only_after_a_verified_withdrawal_and_exactly_once() {
    let mut fixture = Fixture::new();
    call_as("lp.near", NOW, 1);
    fixture.contract.request_withdrawal(
        "withdraw".to_owned(),
        "pool".to_owned(),
        U128(100_000_000),
    );
    fixture
        .contract
        .claim_withdrawal("withdraw".to_owned(), "payout".to_owned());
    assert_eq!(
        fixture.contract.get_pool("pool".to_owned()).total_shares.0,
        1_000_000_000
    );
    assert_eq!(
        fixture.contract.pool_nav("pool".to_owned()).0,
        1_000_000_000
    );
    callback_result(&mut fixture.contract, "payout", NOW, true);
    let transfer = fixture.contract.finalize_transfer("payout".to_owned());
    assert_eq!(transfer.outcome, TransferOutcome::Succeeded);
    fixture.contract.finalize_transfer("payout".to_owned());
    let pool = fixture.contract.get_pool("pool".to_owned());
    assert_eq!(pool.cash_atomic.0, 900_000_000);
    assert_eq!(pool.total_shares.0, 900_000_000);
    assert_eq!(pool.in_flight_atomic.0, 0);
}

#[test]
fn failed_withdrawal_preserves_shares_and_can_be_cancelled() {
    let mut fixture = Fixture::new();
    call_as("lp.near", NOW, 1);
    fixture.contract.request_withdrawal(
        "withdraw".to_owned(),
        "pool".to_owned(),
        U128(100_000_000),
    );
    fixture
        .contract
        .claim_withdrawal("withdraw".to_owned(), "payout".to_owned());
    callback_result(&mut fixture.contract, "payout", NOW, false);
    fixture.contract.finalize_transfer("payout".to_owned());
    call_as("lp.near", NOW, 1);
    fixture.contract.cancel_withdrawal("withdraw".to_owned());
    let position = fixture
        .contract
        .get_position("pool".to_owned(), account("lp.near"));
    assert_eq!(position.shares.0, 1_000_000_000);
    assert_eq!(position.reserved_shares.0, 0);
    assert_eq!(
        fixture.contract.get_pool("pool".to_owned()).cash_atomic.0,
        1_000_000_000
    );
}

#[test]
#[should_panic(expected = "WITHDRAWAL_LIQUIDITY_UNAVAILABLE")]
fn withdrawal_cannot_spend_cash_reserved_for_an_accepted_offer() {
    let mut fixture = Fixture::new();
    fixture.reserve("loan");
    call_as("lp.near", NOW, 1);
    fixture.contract.request_withdrawal(
        "withdraw".to_owned(),
        "pool".to_owned(),
        U128(1_000_000_000),
    );
    fixture
        .contract
        .claim_withdrawal("withdraw".to_owned(), "payout".to_owned());
}

#[test]
#[should_panic(expected = "TRANSFER_RECONCILING")]
fn finalization_requires_a_recorded_transfer_outcome() {
    let mut fixture = Fixture::new();
    fixture.ready("loan");
    call_as("borrower.near", NOW, 1);
    fixture
        .contract
        .fund_loan("loan".to_owned(), "fund".to_owned());
    fixture.contract.finalize_transfer("fund".to_owned());
}

#[test]
fn stale_prices_do_not_hide_debt_or_block_repayment() {
    let mut fixture = Fixture::new();
    fixture.funded("loan");
    call_as("borrower.near", NOW, 0);
    assert_eq!(
        fixture
            .contract
            .loan_summary("loan".to_owned())
            .health_ppm
            .unwrap()
            .0,
        3_500_000
    );
    call_as("borrower.near", NOW + 301, 0);
    let summary = fixture.contract.loan_summary("loan".to_owned());
    assert_eq!(summary.price_status, "stale");
    assert!(summary.health_ppm.is_none());
    assert!(summary.debt_atomic.0 >= 100_000_000);
    fixture.repay("loan", "repay", 200_000_000, NOW + 301);
    assert_eq!(
        fixture
            .contract
            .loan_summary("loan".to_owned())
            .debt_atomic
            .0,
        0
    );
}
