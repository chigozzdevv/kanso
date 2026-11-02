mod common;
use common::*;
use kanso_coordinator::{
    math::NEAR_SCALE,
    settlement::{SettlementKind, SettlementPlan, SettlementState},
    state::{LoanState, Price, TransferOutcome},
};
use near_sdk::json_types::U128;

fn quote(f: &mut Fixture, id: &str, input: u128, output: u128, kind: SettlementKind) {
    let revision = f.contract.get_loan("loan".into()).revision.to_string();
    call_as("payer.near", NOW, 1);
    f.contract.quote_settlement(SettlementPlan {
        operation_id: id.into(),
        loan_id: "loan".into(),
        expected_revision: revision,
        leg_id: "near".into(),
        input_atomic: U128(input),
        net_output_atomic: U128(output),
        execution_cost_atomic: U128(0),
        max_source_fee_atomic: U128(0),
        solver: account("payer.near"),
        source_recipient: account("payer.near"),
        remote_recipient: vec![],
        expires_at: NOW + 300,
        kind,
        conditional_version: 0,
    });
}
fn escrow(f: &mut Fixture, id: &str, amount: u128) {
    call_as("usdc.near", NOW, 0);
    assert_eq!(
        f.contract
            .ft_on_transfer(
                account("payer.near"),
                U128(amount),
                format!(r#"{{"kind":"solver_escrow","operation_id":"{id}"}}"#)
            )
            .0,
        0
    );
}
fn commit(f: &mut Fixture, id: &str) {
    call_as("borrower.near", NOW, 1);
    f.contract
        .commit_settlement(id.into(), format!("deliver_{id}"));
}
fn delivered(f: &mut Fixture, id: &str, success: bool) {
    let transfer = format!("deliver_{id}");
    callback_result(&mut f.contract, &transfer, NOW, success);
    f.contract.finalize_transfer(transfer);
}

#[test]
fn funded_sale_applies_once_and_returns_surplus_to_borrower() {
    let mut f = Fixture::new();
    f.funded("loan");
    quote(
        &mut f,
        "sale",
        24 * NEAR_SCALE,
        120_000_000,
        SettlementKind::Repayment,
    );
    escrow(&mut f, "sale", 120_000_000);
    assert_eq!(f.contract.pool_nav("pool".into()).0, 1_000_000_000);
    commit(&mut f, "sale");
    assert_eq!(f.contract.get_loan("loan".into()).debt(), 100_000_000);
    delivered(&mut f, "sale", true);
    let result = f.contract.apply_settlement("sale".into());
    assert_eq!(result.applied_atomic.0, 100_000_000);
    assert_eq!(
        f.contract.apply_settlement("sale".into()).applied_atomic,
        result.applied_atomic
    );
    let loan = f.contract.get_loan("loan".into());
    assert_eq!(loan.state, LoanState::Repaid);
    assert_eq!(loan.locks[0].locked_atomic.0, 76 * NEAR_SCALE);
    let refund_id = result.refund_id.clone().unwrap();
    let refund = f.contract.get_refund(refund_id.clone()).unwrap();
    assert_eq!(refund.owner, account("borrower.near"));
    assert_eq!(refund.amount_atomic.0, 20_000_000);
    assert_eq!(
        f.contract.settlement_liabilities(),
        (U128(0), U128(20_000_000))
    );
    call_as("borrower.near", NOW, 1);
    f.contract.claim_refund(refund_id.clone(), "refund1".into());
    callback_result(&mut f.contract, "refund1", NOW, false);
    f.contract.finalize_transfer("refund1".into());
    assert!(!f.contract.get_refund(refund_id.clone()).unwrap().paid);
    call_as("borrower.near", NOW, 1);
    f.contract.claim_refund(refund_id.clone(), "refund2".into());
    callback_result(&mut f.contract, "refund2", NOW, true);
    f.contract.finalize_transfer("refund2".into());
    assert_eq!(f.contract.settlement_liabilities(), (U128(0), U128(0)));
}

#[test]
#[should_panic(expected = "ESCROW_NOT_FUNDED")]
fn source_cannot_leave_before_solver_has_paid() {
    let mut f = Fixture::new();
    f.funded("loan");
    quote(
        &mut f,
        "sale",
        NEAR_SCALE / 5,
        1_000_000,
        SettlementKind::Repayment,
    );
    commit(&mut f, "sale");
}

#[test]
#[should_panic(expected = "SOURCE_DELIVERY_UNVERIFIED")]
fn a_submitted_transfer_cannot_reduce_debt() {
    let mut f = Fixture::new();
    f.funded("loan");
    quote(
        &mut f,
        "sale",
        NEAR_SCALE / 5,
        1_000_000,
        SettlementKind::Repayment,
    );
    escrow(&mut f, "sale", 1_000_000);
    commit(&mut f, "sale");
    f.contract.apply_settlement("sale".into());
}

#[test]
#[should_panic(expected = "COMMITTED_SPEND_UNRESOLVED")]
fn timeout_cannot_refund_executable_delivery() {
    let mut f = Fixture::new();
    f.funded("loan");
    quote(
        &mut f,
        "sale",
        NEAR_SCALE / 5,
        1_000_000,
        SettlementKind::Repayment,
    );
    escrow(&mut f, "sale", 1_000_000);
    commit(&mut f, "sale");
    call_as("payer.near", NOW + 301, 1);
    f.contract.cancel_settlement("sale".into());
}

#[test]
fn proven_delivery_failure_restores_custody_and_solver_can_refund() {
    let mut f = Fixture::new();
    f.funded("loan");
    quote(
        &mut f,
        "sale",
        NEAR_SCALE / 5,
        1_000_000,
        SettlementKind::Repayment,
    );
    escrow(&mut f, "sale", 1_000_000);
    commit(&mut f, "sale");
    delivered(&mut f, "sale", false);
    let loan = f.contract.get_loan("loan".into());
    assert_eq!(loan.locks[0].locked_atomic.0, 100 * NEAR_SCALE);
    assert_eq!(loan.locks[0].reserved_atomic.0, 0);
    assert!(loan.active_outflow.is_none());
    call_as("payer.near", NOW, 1);
    assert_eq!(
        f.contract.cancel_settlement("sale".into()).state,
        SettlementState::Cancelled
    );
    assert_eq!(
        f.contract
            .get_refund(
                f.contract
                    .get_settlement("sale".into())
                    .unwrap()
                    .refund_id
                    .unwrap()
            )
            .unwrap()
            .owner,
        account("payer.near")
    );
}

#[test]
fn full_default_recovery_recognizes_real_pool_loss() {
    let mut f = Fixture::new();
    let mut offer = f.offer("loan");
    offer.duration_seconds = 1;
    call_as("borrower.near", NOW, 1);
    f.contract.accept_offer(offer);
    call_as("borrower.near", NOW, 100 * NEAR_SCALE);
    f.contract.lock_native("loan".into(), "near".into());
    call_as("borrower.near", NOW, 1);
    f.contract.fund_loan("loan".into(), "fund".into());
    callback_result(&mut f.contract, "fund", NOW, true);
    f.contract.finalize_transfer("fund".into());
    let now = NOW + 62;
    call_as("oracle.near", now, 0);
    f.contract.publish_price(Price {
        price_atomic: U128(500_000),
        confidence_bps: 0,
        published_at: now,
        sequence: 2,
    });
    let revision = f.contract.get_loan("loan".into()).revision.to_string();
    call_as("payer.near", now, 1);
    f.contract.quote_settlement(SettlementPlan {
        operation_id: "recovery".into(),
        loan_id: "loan".into(),
        expected_revision: revision,
        leg_id: "near".into(),
        input_atomic: U128(100 * NEAR_SCALE),
        net_output_atomic: U128(50_000_000),
        execution_cost_atomic: U128(0),
        max_source_fee_atomic: U128(0),
        solver: account("payer.near"),
        source_recipient: account("payer.near"),
        remote_recipient: vec![],
        expires_at: now + 300,
        kind: SettlementKind::Liquidation,
        conditional_version: 0,
    });
    call_as("usdc.near", now, 0);
    f.contract.ft_on_transfer(
        account("payer.near"),
        U128(50_000_000),
        r#"{"kind":"solver_escrow","operation_id":"recovery"}"#.into(),
    );
    call_as("payer.near", now, 1);
    f.contract
        .commit_settlement("recovery".into(), "deliver".into());
    callback_result(&mut f.contract, "deliver", now, true);
    f.contract.finalize_transfer("deliver".into());
    f.contract.apply_settlement("recovery".into());
    let loan = f.contract.get_loan("loan".into());
    let loss = loan.debt();
    let nav = f.contract.pool_nav("pool".into()).0;
    call_as("lp.near", now, 1);
    let loan = f
        .contract
        .recognize_loss("loan".into(), loan.revision.to_string());
    assert_eq!(loan.state, LoanState::WrittenOff);
    assert_eq!(loan.written_off_atomic.0, loss);
    assert_eq!(f.contract.pool_nav("pool".into()).0, nav - loss);
    assert_eq!(
        f.contract.get_pool("pool".into()).recognized_loss_atomic.0,
        loss
    );
    assert_eq!(
        f.contract.get_transfer("deliver".into()).unwrap().outcome,
        TransferOutcome::Succeeded
    );
}

#[test]
fn partial_liquidation_uses_the_remaining_basket_and_actual_repayment() {
    let mut f = Fixture::new();
    f.funded("loan");
    call_as("oracle.near", NOW, 0);
    f.contract.publish_price(Price {
        price_atomic: U128(1_400_000),
        confidence_bps: 0,
        published_at: NOW,
        sequence: 2,
    });
    assert_eq!(f.contract.basket_risk("loan".into()).health_ppm.0, 980_000);
    quote(
        &mut f,
        "partial_recovery",
        40 * NEAR_SCALE,
        56_000_000,
        SettlementKind::Liquidation,
    );
    escrow(&mut f, "partial_recovery", 56_000_000);
    assert_eq!(
        f.contract
            .basket_risk("loan".into())
            .secured_recovery_atomic
            .0,
        0
    );
    call_as("payer.near", NOW, 1);
    f.contract
        .commit_settlement("partial_recovery".into(), "deliver_partial_recovery".into());
    let pending = f.contract.basket_risk("loan".into());
    assert_eq!(pending.secured_recovery_atomic.0, 56_000_000);
    assert_eq!(pending.health_ppm.0, 1_148_000);
    assert_eq!(pending.debt_atomic.0, 100_000_000);
    delivered(&mut f, "partial_recovery", true);
    f.contract.apply_settlement("partial_recovery".into());
    let loan = f.contract.get_loan("loan".into());
    assert_eq!(loan.debt(), 44_000_000);
    assert_eq!(loan.locks[0].locked_atomic.0, 60 * NEAR_SCALE);
    assert_eq!(
        f.contract.basket_risk("loan".into()).health_ppm.0,
        1_336_363
    );
    assert_eq!(
        f.contract
            .basket_risk("loan".into())
            .secured_recovery_atomic
            .0,
        0
    );
}

#[test]
#[should_panic(expected = "QUOTE_BELOW_ORACLE_BOUND")]
fn default_does_not_authorize_a_sale_below_the_oracle_bound() {
    let mut f = Fixture::new();
    f.funded("loan");
    let now = NOW + 31_536_061;
    call_as("oracle.near", now, 0);
    f.contract.publish_price(Price {
        price_atomic: U128(5_000_000),
        confidence_bps: 0,
        published_at: now,
        sequence: 2,
    });
    let rev = f.contract.get_loan("loan".into()).revision.to_string();
    call_as("payer.near", now, 1);
    f.contract.quote_settlement(SettlementPlan {
        operation_id: "bad_sale".into(),
        loan_id: "loan".into(),
        expected_revision: rev,
        leg_id: "near".into(),
        input_atomic: U128(100 * NEAR_SCALE),
        net_output_atomic: U128(1),
        execution_cost_atomic: U128(0),
        max_source_fee_atomic: U128(0),
        solver: account("payer.near"),
        source_recipient: account("payer.near"),
        remote_recipient: vec![],
        expires_at: now + 300,
        kind: SettlementKind::Liquidation,
        conditional_version: 0,
    });
    call_as("usdc.near", now, 0);
    f.contract.ft_on_transfer(
        account("payer.near"),
        U128(1),
        r#"{"kind":"solver_escrow","operation_id":"bad_sale"}"#.into(),
    );
    call_as("payer.near", now, 1);
    f.contract
        .commit_settlement("bad_sale".into(), "bad_delivery".into());
}

#[test]
fn another_defaulted_leg_can_be_recovered_while_a_previous_delivery_is_unknown() {
    let mut f = Fixture::new();
    let mut offer = f.offer("loan");
    offer.duration_seconds = 1;
    let mut second = offer.legs[0].clone();
    second.leg_id = "second".into();
    offer.legs.push(second);
    call_as("borrower.near", NOW, 1);
    f.contract.accept_offer(offer);
    for leg in ["near", "second"] {
        call_as("borrower.near", NOW, 100 * NEAR_SCALE);
        f.contract.lock_native("loan".into(), leg.into());
    }
    call_as("borrower.near", NOW, 1);
    f.contract.fund_loan("loan".into(), "fund".into());
    callback_result(&mut f.contract, "fund", NOW, true);
    f.contract.finalize_transfer("fund".into());
    let now = NOW + 62;
    call_as("oracle.near", now, 0);
    f.contract.publish_price(Price {
        price_atomic: U128(500_000),
        confidence_bps: 0,
        published_at: now,
        sequence: 2,
    });
    for (id, leg) in [("first", "near"), ("second", "second")] {
        let rev = f.contract.get_loan("loan".into()).revision.to_string();
        call_as("payer.near", now, 1);
        f.contract.quote_settlement(SettlementPlan {
            operation_id: id.into(),
            loan_id: "loan".into(),
            expected_revision: rev,
            leg_id: leg.into(),
            input_atomic: U128(100 * NEAR_SCALE),
            net_output_atomic: U128(50_000_000),
            execution_cost_atomic: U128(0),
            max_source_fee_atomic: U128(0),
            solver: account("payer.near"),
            source_recipient: account("payer.near"),
            remote_recipient: vec![],
            expires_at: now + 300,
            kind: SettlementKind::Liquidation,
            conditional_version: 0,
        });
        call_as("usdc.near", now, 0);
        f.contract.ft_on_transfer(
            account("payer.near"),
            U128(50_000_000),
            format!(r#"{{"kind":"solver_escrow","operation_id":"{id}"}}"#),
        );
        call_as("payer.near", now, 1);
        f.contract
            .commit_settlement(id.into(), format!("deliver_{id}"));
    }
    let pending = f.contract.get_loan("loan".into());
    assert_eq!(pending.active_outflow.as_deref(), Some("first"));
    assert_eq!(pending.recovery_outflows, vec!["second"]);
    callback_result(&mut f.contract, "deliver_second", now, true);
    f.contract.finalize_transfer("deliver_second".into());
    f.contract.apply_settlement("second".into());
    let loan = f.contract.get_loan("loan".into());
    assert_eq!(loan.active_outflow.as_deref(), Some("first"));
    assert!(loan.recovery_outflows.is_empty());
    assert_eq!(loan.locks[0].reserved_atomic.0, 100 * NEAR_SCALE);
    callback_result(&mut f.contract, "deliver_first", now, false);
    f.contract.finalize_transfer("deliver_first".into());
    let loan = f.contract.get_loan("loan".into());
    assert!(loan.active_outflow.is_none());
    assert_eq!(loan.locks[0].locked_atomic.0, 100 * NEAR_SCALE);
    assert_eq!(loan.locks[1].locked_atomic.0, 0);
}

#[test]
#[should_panic(expected = "LIQUIDATION_REPAYMENT_LIMIT")]
fn parallel_liquidations_cannot_each_reserve_the_full_debt() {
    let mut f = Fixture::new();
    let mut offer = f.offer("loan");
    offer.duration_seconds = 1;
    let mut second = offer.legs[0].clone();
    second.leg_id = "second".into();
    offer.legs.push(second);
    call_as("borrower.near", NOW, 1);
    f.contract.accept_offer(offer);
    for leg in ["near", "second"] {
        call_as("borrower.near", NOW, 100 * NEAR_SCALE);
        f.contract.lock_native("loan".into(), leg.into());
    }
    call_as("borrower.near", NOW, 1);
    f.contract.fund_loan("loan".into(), "fund".into());
    callback_result(&mut f.contract, "fund", NOW, true);
    f.contract.finalize_transfer("fund".into());
    let now = NOW + 62;
    call_as("oracle.near", now, 0);
    f.contract.publish_price(Price {
        price_atomic: U128(600_000),
        confidence_bps: 0,
        published_at: now,
        sequence: 2,
    });
    for (id, leg) in [("first", "near"), ("second", "second")] {
        let rev = f.contract.get_loan("loan".into()).revision.to_string();
        call_as("payer.near", now, 1);
        f.contract.quote_settlement(SettlementPlan {
            operation_id: id.into(),
            loan_id: "loan".into(),
            expected_revision: rev,
            leg_id: leg.into(),
            input_atomic: U128(100 * NEAR_SCALE),
            net_output_atomic: U128(60_000_000),
            execution_cost_atomic: U128(0),
            max_source_fee_atomic: U128(0),
            solver: account("payer.near"),
            source_recipient: account("payer.near"),
            remote_recipient: vec![],
            expires_at: now + 300,
            kind: SettlementKind::Liquidation,
            conditional_version: 0,
        });
        call_as("usdc.near", now, 0);
        f.contract.ft_on_transfer(
            account("payer.near"),
            U128(60_000_000),
            format!(r#"{{"kind":"solver_escrow","operation_id":"{id}"}}"#),
        );
        call_as("payer.near", now, 1);
        f.contract
            .commit_settlement(id.into(), format!("deliver_{id}"));
    }
}
