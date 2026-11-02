mod common;

use common::*;
use kanso_coordinator::{
    math::{self, NEAR_SCALE},
    state::{LoanState, SetupState},
};
use near_sdk::{
    json_types::U128,
    test_utils::{get_created_receipts, get_logs},
};

#[test]
fn native_loan_partial_repayment_full_repayment_and_release() {
    let mut fixture = Fixture::new();
    fixture.funded("loan");
    let loan = fixture.contract.get_loan("loan".to_owned());
    assert_eq!(loan.state, LoanState::Active);
    assert_eq!(loan.started_at, NOW);
    assert_eq!(loan.matures_at, NOW + math::YEAR_SECONDS);
    let half_year = NOW + math::YEAR_SECONDS / 2;
    assert_eq!(fixture.repay("loan", "partial", 25_000_000, half_year).0, 0);
    let loan = fixture.contract.get_loan("loan".to_owned());
    assert_eq!(loan.interest_due(), 0);
    assert_eq!(loan.principal_outstanding_atomic.0, 80_000_000);
    let end = NOW + math::YEAR_SECONDS;
    assert_eq!(
        fixture.repay("loan", "full", 100_000_000, end).0,
        16_000_000
    );
    let loan = fixture.contract.get_loan("loan".to_owned());
    assert_eq!(loan.state, LoanState::Repaid);
    assert_eq!(loan.debt(), 0);
    assert_eq!(loan.locks[0].locked_atomic.0, 100 * NEAR_SCALE);
    call_as("borrower.near", end, 1);
    fixture
        .contract
        .release_collateral("loan".to_owned(), "near".to_owned(), "release".to_owned());
    callback_result(&mut fixture.contract, "release", end, true);
    fixture.contract.finalize_transfer("release".to_owned());
    assert!(fixture
        .contract
        .get_loan("loan".to_owned())
        .custody_resolved());
    assert_eq!(
        fixture.contract.get_pool("pool".to_owned()).cash_atomic.0,
        1_009_000_000
    );
}

#[test]
fn payout_and_finalization_are_idempotent() {
    let mut fixture = Fixture::new();
    fixture.ready("loan");
    call_as("borrower.near", NOW, 1);
    fixture
        .contract
        .fund_loan("loan".to_owned(), "fund".to_owned());
    assert_eq!(get_created_receipts().len(), 3);
    call_as("borrower.near", NOW, 1);
    fixture
        .contract
        .fund_loan("loan".to_owned(), "fund".to_owned());
    assert!(get_created_receipts().is_empty());
    assert_eq!(fixture.contract.get_loan("loan".to_owned()).debt(), 0);
    callback_result(&mut fixture.contract, "fund", NOW, true);
    call_as("payer.near", NOW + 10, 0);
    fixture.contract.finalize_transfer("fund".to_owned());
    let started_at = fixture.contract.get_loan("loan".to_owned()).started_at;
    call_as("payer.near", NOW + 20, 0);
    fixture.contract.finalize_transfer("fund".to_owned());
    assert_eq!(
        fixture.contract.get_loan("loan".to_owned()).started_at,
        started_at
    );
    assert_eq!(
        fixture.contract.get_pool("pool".to_owned()).cash_atomic.0,
        900_000_000
    );
}

#[test]
fn failed_disbursement_restores_only_its_reservation_and_never_accrues_interest() {
    let mut fixture = Fixture::new();
    fixture.ready("loan");
    call_as("borrower.near", NOW, 1);
    fixture
        .contract
        .fund_loan("loan".to_owned(), "fund".to_owned());
    callback_result(&mut fixture.contract, "fund", NOW + 100, false);
    fixture.contract.finalize_transfer("fund".to_owned());
    let loan = fixture.contract.get_loan("loan".to_owned());
    assert_eq!(loan.debt(), 0);
    assert_eq!(loan.started_at, 0);
    assert_eq!(loan.setup_state, SetupState::Ready);
    let pool = fixture.contract.get_pool("pool".to_owned());
    assert_eq!(pool.cash_atomic.0, 1_000_000_000);
    assert_eq!(pool.reserved_atomic.0, 100_000_000);
    assert_eq!(pool.in_flight_atomic.0, 0);
    call_as("borrower.near", NOW + 100, 1);
    fixture.contract.abort_setup("loan".to_owned());
    assert_eq!(
        fixture
            .contract
            .get_pool("pool".to_owned())
            .reserved_atomic
            .0,
        0
    );
}

#[test]
fn duplicate_token_receipt_cannot_reduce_debt_twice() {
    let mut fixture = Fixture::new();
    fixture.funded("loan");
    fixture.repay("loan", "payment", 10_000_000, NOW);
    let logs = get_logs();
    let event: serde_json::Value =
        serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert!(event["data"][0]["event_id"]
        .as_str()
        .unwrap()
        .contains("RepaymentApplied"));
    assert_eq!(
        fixture.repay("loan", "payment", 10_000_000, NOW).0,
        10_000_000
    );
    assert_eq!(
        fixture.contract.get_loan("loan".to_owned()).debt(),
        90_000_000
    );
    assert!(get_logs().is_empty());
}

#[test]
fn policy_changes_preserve_already_accepted_terms() {
    let mut fixture = Fixture::new();
    fixture.ready("loan");
    call_as("lp.near", NOW, 1);
    let mut next = policy();
    next.version = 2;
    next.apr_bps = 2000;
    next.grace_seconds = 120;
    fixture.contract.update_pool_policy("pool".to_owned(), next);
    call_as("borrower.near", NOW, 1);
    fixture
        .contract
        .fund_loan("loan".to_owned(), "fund".to_owned());
    callback_result(&mut fixture.contract, "fund", NOW, true);
    fixture.contract.finalize_transfer("fund".to_owned());
    let loan = fixture.contract.get_loan("loan".to_owned());
    assert_eq!(loan.offer.apr_bps, 1000);
    assert_eq!(loan.policy.grace_seconds, 60);
}

#[test]
fn fees_are_separate_from_the_exact_payout_and_paid_before_interest() {
    let mut fixture = Fixture::new();
    call_as("lp.near", NOW, 1);
    let mut policy = policy();
    policy.version = 2;
    policy.origination_fee_atomic = U128(10_000_000);
    fixture
        .contract
        .update_pool_policy("pool".to_owned(), policy);
    let mut offer = fixture.offer("loan");
    offer.policy_version = 2;
    offer.origination_fee_atomic = U128(10_000_000);
    call_as("borrower.near", NOW, 1);
    fixture.contract.accept_offer(offer);
    call_as("borrower.near", NOW, 100 * NEAR_SCALE);
    fixture
        .contract
        .lock_native("loan".to_owned(), "near".to_owned());
    call_as("borrower.near", NOW, 1);
    let transfer = fixture
        .contract
        .fund_loan("loan".to_owned(), "fund".to_owned());
    assert_eq!(transfer.amount_atomic.0, 100_000_000);
    callback_result(&mut fixture.contract, "fund", NOW, true);
    fixture.contract.finalize_transfer("fund".to_owned());
    fixture.repay("loan", "fee", 5_000_000, NOW);
    let loan = fixture.contract.get_loan("loan".to_owned());
    assert_eq!(loan.fees_due_atomic.0, 5_000_000);
    assert_eq!(loan.principal_outstanding_atomic.0, 100_000_000);
}

#[test]
fn maturity_and_grace_do_not_reset_interest_or_roll_the_loan() {
    let mut fixture = Fixture::new();
    fixture.funded("loan");
    call_as("borrower.near", NOW + math::YEAR_SECONDS, 0);
    assert_eq!(fixture.contract.debt_state("loan".to_owned()), "due");
    call_as("borrower.near", NOW + math::YEAR_SECONDS + 60, 0);
    assert_eq!(fixture.contract.debt_state("loan".to_owned()), "defaulted");
    assert!(fixture.contract.get_loan("loan".to_owned()).interest_due() > 10_000_000);
}

#[test]
fn accrual_partitioning_preserves_fractional_interest() {
    for principal in [1, 7, 999_999, u128::MAX / 10_000] {
        for rate in [1, 333, 10_000] {
            let mut accrued = 0;
            let mut remainder = 0;
            for _ in 0..365 {
                let next = math::interest(principal, rate, 86_400, remainder);
                accrued += next.0;
                remainder = next.1;
            }
            assert_eq!(
                (accrued, remainder),
                math::interest(principal, rate, math::YEAR_SECONDS, 0)
            );
        }
    }
    assert_eq!(
        math::mul_div_floor(u128::MAX, u128::MAX, u128::MAX),
        u128::MAX
    );
    assert_eq!(math::mul_div_ceil(10, 10, 3), 34);
}
