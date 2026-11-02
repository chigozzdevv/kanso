mod common;
#[path = "common/remote.rs"]
mod remote;
use common::*;
use kanso_coordinator::{
    conditional_repayment::{ConditionalTerms, SpendLimit},
    math::NEAR_SCALE,
    settlement::{SettlementKind, SettlementPlan},
};
use near_sdk::{
    json_types::U128,
    serde_json::{self, json},
};

#[test]
fn coordinator_wire_types_match_shared_fixtures() {
    let mut f = Fixture::new();
    f.funded("loan");
    let manifest = remote::register(&mut f, "base");
    call_as("borrower.near", NOW, 1);
    let authorization = f.contract.set_conditional_repayment(
        "loan".into(),
        0,
        ConditionalTerms {
            enabled: true,
            trigger_health_ppm: 1_200_000,
            target_health_ppm: 1_300_000,
            max_total_repayment_atomic: U128(100_000_000),
            max_collateral_spend: vec![SpendLimit {
                asset_id: "near".into(),
                max_total_atomic: U128(20 * NEAR_SCALE),
            }],
            max_execution_cost_bps: 100,
            max_execution_cost_atomic: U128(1_000_000),
            expires_at: Some(NOW + 600),
        },
    );
    let mut leg = f.contract.get_loan("loan".into()).locks[0].leg.clone();
    leg.leg_id = "incoming".into();
    let topup = f.contract.commit_topup("topup".into(), "loan".into(), leg);
    let replacement = f.contract.commit_replacement(
        "replace".into(),
        "loan".into(),
        "topup".into(),
        "near".into(),
        U128(NEAR_SCALE),
    );
    let loan = f.contract.get_loan("loan".into());
    call_as("payer.near", NOW, 1);
    let settlement = f.contract.quote_settlement(SettlementPlan {
        operation_id: "sale".into(),
        loan_id: "loan".into(),
        expected_revision: loan.revision.to_string(),
        leg_id: "near".into(),
        input_atomic: U128(NEAR_SCALE),
        net_output_atomic: U128(5_000_000),
        execution_cost_atomic: U128(0),
        max_source_fee_atomic: U128(0),
        solver: account("payer.near"),
        source_recipient: account("payer.near"),
        remote_recipient: vec![],
        expires_at: NOW + 300,
        kind: SettlementKind::Repayment,
        conditional_version: 0,
    });
    let signature = remote::signature(&remote::key(2), &[1; 32]);
    let mpc_signature =
        near_mpc_contract_interface::types::SignatureResponse::Secp256k1(signature.clone());
    let ed25519_signature = near_mpc_contract_interface::types::SignatureResponse::Ed25519 {
        signature: [42; 64].into(),
    };
    let read_proof = remote::lock_proof(&f, &manifest, "loan");
    let actual = json!({"k256_signature":signature,"mpc_signature":mpc_signature,"ed25519_signature":ed25519_signature,"read_proof":read_proof,"manifest":manifest,"loan":loan,"authorization":authorization,"topup":topup,"replacement":replacement,"settlement":settlement,"risk":f.contract.basket_risk("loan".into())});
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coordinator-wire.json");
    if std::env::var_os("KANSO_UPDATE_FIXTURES").is_some() {
        std::fs::write(
            &path,
            format!("{}\n", serde_json::to_string_pretty(&actual).unwrap()),
        )
        .unwrap();
    }
    let expected: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(actual, expected);
}
