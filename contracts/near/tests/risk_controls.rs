mod common;
use common::*;
use kanso_coordinator::{controls::PauseFlags, math::NEAR_SCALE, state::AssetCap};
use near_sdk::json_types::U128;

#[test]
#[should_panic(expected = "INSUFFICIENT_CAPACITY")]
fn splitting_an_asset_across_legs_cannot_bypass_its_pool_cap() {
    let mut f = Fixture::new();
    let mut p = policy();
    p.version = 2;
    p.asset_caps = vec![AssetCap {
        asset_id: "near".into(),
        max_collateral_value_atomic: U128(100_000_000),
    }];
    call_as("lp.near", NOW, 1);
    f.contract.update_pool_policy("pool".into(), p);
    let mut offer = f.offer("loan");
    offer.policy_version = 2;
    let mut second = offer.legs[0].clone();
    second.leg_id = "second".into();
    offer.legs.push(second);
    call_as("borrower.near", NOW, 1);
    f.contract.accept_offer(offer);
}
#[test]
#[should_panic(expected = "POOL_EXPOSURE_LIMIT")]
fn pending_offers_count_against_the_outstanding_principal_limit() {
    let mut f = Fixture::new();
    let mut p = policy();
    p.version = 2;
    p.max_outstanding_principal_atomic = U128(150_000_000);
    p.max_principal_atomic = U128(150_000_000);
    call_as("lp.near", NOW, 1);
    f.contract.update_pool_policy("pool".into(), p);
    for id in ["first", "second"] {
        let mut offer = f.offer(id);
        offer.policy_version = 2;
        call_as("borrower.near", NOW, 1);
        f.contract.accept_offer(offer);
    }
}
#[test]
fn global_pause_preserves_repayment_release_and_idempotent_acceptance() {
    let mut f = Fixture::new();
    let terms = f.offer("loan");
    f.funded("loan");
    call_as("owner.near", NOW, 1);
    f.contract.set_pause_flags(PauseFlags {
        origination: true,
        collateral_withdrawals: true,
        settlements: true,
    });
    call_as("borrower.near", NOW, 1);
    f.contract.accept_offer(terms);
    assert_eq!(f.repay("loan", "close", 100_000_000, NOW).0, 0);
    call_as("borrower.near", NOW, 1);
    f.contract
        .release_collateral("loan".into(), "near".into(), "release".into());
    callback_result(&mut f.contract, "release", NOW, true);
    f.contract.finalize_transfer("release".into());
    assert_eq!(
        f.contract.get_loan("loan".into()).locks[0].locked_atomic.0,
        0
    );
}
#[test]
#[should_panic(expected = "COLLATERAL_WITHDRAWALS_PAUSED")]
fn global_pause_blocks_new_excess_withdrawals() {
    let mut f = Fixture::new();
    f.funded("loan");
    let rev = f.contract.get_loan("loan".into()).revision.to_string();
    call_as("owner.near", NOW, 1);
    f.contract.set_pause_flags(PauseFlags {
        origination: false,
        collateral_withdrawals: true,
        settlements: false,
    });
    call_as("borrower.near", NOW, 1);
    f.contract.withdraw_excess(
        "loan".into(),
        "near".into(),
        U128(NEAR_SCALE),
        "withdraw".into(),
        rev,
    );
}
