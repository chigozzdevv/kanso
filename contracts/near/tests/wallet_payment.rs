mod common;
use common::*;
use kanso_coordinator::{
    math::NEAR_SCALE,
    settlement::{SettlementKind, SettlementPlan},
    state::{BasketLeg, Custody},
};
use near_sdk::json_types::U128;
#[test]
fn wallet_payment_does_not_increase_credit_and_surplus_belongs_to_the_payer() {
    let mut f = Fixture::new();
    f.funded("loan");
    let before = f.contract.borrowing_capacity("loan".into());
    let leg_id =
        f.contract
            .wallet_payment_leg_id("loan".into(), account("payer.near"), "payment".into());
    call_as("payer.near", NOW, 1);
    f.contract.create_wallet_payment(
        "loan".into(),
        "payment".into(),
        BasketLeg {
            leg_id: leg_id.clone(),
            asset_id: "near".into(),
            custody: Custody::Near,
            owner: account("payer.near"),
            amount_atomic: U128(24 * NEAR_SCALE),
            release_recipient: account("payer.near"),
        },
    );
    call_as("payer.near", NOW, 24 * NEAR_SCALE);
    let loan = f.contract.lock_native("loan".into(), leg_id.clone());
    assert_eq!(f.contract.borrowing_capacity("loan".into()), before);
    call_as("payer.near", NOW, 1);
    f.contract.quote_settlement(SettlementPlan {
        operation_id: "payment_sale".into(),
        loan_id: "loan".into(),
        expected_revision: loan.revision.to_string(),
        leg_id: leg_id.clone(),
        input_atomic: U128(24 * NEAR_SCALE),
        net_output_atomic: U128(120_000_000),
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
        U128(120_000_000),
        r#"{"kind":"solver_escrow","operation_id":"payment_sale"}"#.into(),
    );
    call_as("payer.near", NOW, 1);
    f.contract
        .commit_settlement("payment_sale".into(), "source_delivery".into());
    callback_result(&mut f.contract, "source_delivery", NOW, true);
    f.contract.finalize_transfer("source_delivery".into());
    f.contract.apply_settlement("payment_sale".into());
    let refund = f
        .contract
        .get_refund(
            f.contract
                .get_settlement("payment_sale".into())
                .unwrap()
                .refund_id
                .unwrap(),
        )
        .unwrap();
    assert_eq!(refund.owner, account("payer.near"));
    assert_eq!(refund.amount_atomic.0, 20_000_000);
    assert_eq!(
        f.contract.get_loan("loan".into()).locks[0].locked_atomic.0,
        100 * NEAR_SCALE
    );
}
#[test]
fn unused_native_payment_is_refundable_while_the_loan_is_active() {
    let mut f = Fixture::new();
    f.funded("loan");
    let leg_id =
        f.contract
            .wallet_payment_leg_id("loan".into(), account("payer.near"), "unused".into());
    call_as("payer.near", NOW, 1);
    f.contract.create_wallet_payment(
        "loan".into(),
        "unused".into(),
        BasketLeg {
            leg_id: leg_id.clone(),
            asset_id: "near".into(),
            custody: Custody::Near,
            owner: account("payer.near"),
            amount_atomic: U128(NEAR_SCALE),
            release_recipient: account("payer.near"),
        },
    );
    call_as("payer.near", NOW, NEAR_SCALE);
    f.contract.lock_native("loan".into(), leg_id.clone());
    call_as("payer.near", NOW, 1);
    let transfer =
        f.contract
            .refund_native_wallet_payment("loan".into(), leg_id, "refund_payment".into());
    assert_eq!(transfer.recipient, account("payer.near"));
    callback_result(&mut f.contract, "refund_payment", NOW, false);
    f.contract.finalize_transfer("refund_payment".into());
    assert_eq!(
        f.contract.get_loan("loan".into()).locks[1].locked_atomic.0,
        NEAR_SCALE
    );
}
