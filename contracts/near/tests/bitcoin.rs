mod common;
#[path = "common/remote.rs"]
mod remote;
use bitcoin::{
    absolute,
    consensus::{deserialize, serialize},
    transaction, Amount, CompressedPublicKey, ScriptBuf, Transaction, TxIn, TxOut,
};
use common::*;
use kanso_coordinator::{
    bitcoin_light_client::{BitcoinInclusionProof, BitcoinProofAction, BitcoinVerifier},
    collateral::bitcoin::{BitcoinRecovery, BitcoinSpend, BitcoinSpendState},
    manifest::ChainFamily,
    settlement::{SettlementKind, SettlementPlan},
    state::{BasketLeg, Custody, Loan, LoanState},
    Coordinator,
};
use near_mpc_contract_interface::types::*;
use near_sdk::{env, json_types::U128, testing_env, PromiseResult};
use remote::{key, public_key, signature};
fn refund_script() -> Vec<u8> {
    let bytes = key(6).verifying_key().to_encoded_point(true);
    ScriptBuf::new_p2wpkh(
        &CompressedPublicKey::from_slice(bytes.as_bytes())
            .unwrap()
            .wpubkey_hash(),
    )
    .into_bytes()
}
fn proof(tx: &Transaction) -> BitcoinInclusionProof {
    BitcoinInclusionProof {
        tx_id: tx.compute_txid().to_string(),
        tx_block_blockhash: "09".repeat(32),
        tx_index: 1,
        merkle_proof: vec!["08".repeat(32)],
        coinbase_tx_id: "08".repeat(32),
        coinbase_merkle_proof: vec![tx.compute_txid().to_string()],
    }
}
fn callback_results(inclusion: PromiseResult, tip: PromiseResult, now: u64) {
    testing_env!(
        context("kanso.near", now, 0).build(),
        near_sdk::test_vm_config(),
        near_parameters::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![inclusion, tip]
    );
}
fn verified(
    contract: &mut Coordinator,
    action: BitcoinProofAction,
    raw: Vec<u8>,
) -> serde_json::Value {
    let payer = env::predecessor_account_id();
    callback_results(
        PromiseResult::Successful(b"true".to_vec()),
        PromiseResult::Successful(
            serde_json::to_vec(
                &serde_json::json!({"block_height":500,"block_header":{"time":NOW}}),
            )
            .unwrap(),
        ),
        NOW,
    );
    let value = contract.complete_bitcoin_verification(action, raw, payer.clone());
    call_as(payer.as_str(), NOW, 1);
    value
}
trait VerifiedBitcoin {
    fn verify_lock(
        &mut self,
        loan: String,
        leg: String,
        proof: BitcoinInclusionProof,
        raw: Vec<u8>,
        vout: u32,
    ) -> Loan;
    fn verify_delivery(
        &mut self,
        op: String,
        proof: BitcoinInclusionProof,
        raw: Vec<u8>,
    ) -> BitcoinSpend;
    fn verify_recovery(
        &mut self,
        id: String,
        loan: String,
        leg: String,
        proof: BitcoinInclusionProof,
        raw: Vec<u8>,
        vout: u32,
    ) -> BitcoinRecovery;
}
impl VerifiedBitcoin for Coordinator {
    fn verify_lock(
        &mut self,
        loan_id: String,
        leg_id: String,
        proof: BitcoinInclusionProof,
        raw: Vec<u8>,
        vout: u32,
    ) -> Loan {
        self.submit_bitcoin_lock(loan_id.clone(), leg_id.clone(), proof, raw.clone(), vout)
            .detach();
        serde_json::from_value(verified(
            self,
            BitcoinProofAction::Lock {
                loan_id,
                leg_id,
                vout,
            },
            raw,
        ))
        .unwrap()
    }
    fn verify_delivery(
        &mut self,
        operation_id: String,
        proof: BitcoinInclusionProof,
        raw: Vec<u8>,
    ) -> BitcoinSpend {
        self.submit_bitcoin_delivery(operation_id.clone(), proof, raw.clone())
            .detach();
        serde_json::from_value(verified(
            self,
            BitcoinProofAction::Delivery { operation_id },
            raw,
        ))
        .unwrap()
    }
    fn verify_recovery(
        &mut self,
        recovery_id: String,
        loan_id: String,
        leg_id: String,
        proof: BitcoinInclusionProof,
        raw: Vec<u8>,
        vout: u32,
    ) -> BitcoinRecovery {
        self.register_bitcoin_recovery(
            recovery_id.clone(),
            loan_id.clone(),
            leg_id.clone(),
            proof,
            raw.clone(),
            vout,
        )
        .detach();
        serde_json::from_value(verified(
            self,
            BitcoinProofAction::Recovery {
                recovery_id,
                loan_id,
                leg_id,
                vout,
            },
            raw,
        ))
        .unwrap()
    }
}
fn deposit_input() -> TxIn {
    let mut input = TxIn::default();
    input.previous_output.vout = 0;
    input
}
fn prepare_setup() -> Fixture {
    let mut f = Fixture::new();
    let mut m = remote::manifest("bitcoin");
    m.family = ChainFamily::Bitcoin;
    m.network_fingerprint = bitcoin::blockdata::constants::genesis_block(bitcoin::Network::Testnet)
        .block_hash()
        .to_string();
    m.vault = vec![];
    m.controller = key(3)
        .verifying_key()
        .to_encoded_point(true)
        .as_bytes()
        .to_vec();
    m.controller_public_key = m.controller.clone();
    m.decimals = 8;
    m.max_network_cost_atomic = U128(10_000);
    m.minimum_confirmations = 3;
    call_as("owner.near", NOW, 1);
    f.contract.register_chain_manifest(m.clone());
    f.contract.register_bitcoin_verifier(
        1,
        BitcoinVerifier {
            account_id: account("btc-client.testnet"),
            network_fingerprint: m.network_fingerprint,
            max_tip_age_seconds: 7200,
        },
    );
    call_as("oracle.near", NOW, 0);
    f.contract.publish_asset_price(
        "bitcoin".into(),
        kanso_coordinator::state::Price {
            price_atomic: U128(50_000_000_000),
            confidence_bps: 0,
            published_at: NOW,
            sequence: 1,
        },
    );
    let mut p = f.contract.get_pool("pool".into()).policy;
    p.version = 2;
    p.eligible_assets.push("bitcoin".into());
    p.asset_caps.push(kanso_coordinator::state::AssetCap {
        asset_id: "bitcoin".into(),
        max_collateral_value_atomic: U128(1_000_000_000_000),
    });
    call_as("lp.near", NOW, 1);
    f.contract.update_pool_policy("pool".into(), p);
    let mut offer = f.offer("loan");
    offer.policy_version = 2;
    offer.legs = vec![BasketLeg {
        asset_id: "bitcoin".into(),
        custody: Custody::Remote {
            chain_id: "bitcoin".into(),
            manifest_version: 1,
            lock_id: vec![11; 32],
            source_owner: refund_script(),
            release_recipient: refund_script(),
            min_price_atomic: U128(40_000_000_000),
            max_price_atomic: U128(60_000_000_000),
        },
        leg_id: "bitcoin".into(),
        owner: account("borrower.near"),
        amount_atomic: U128(1_000_000),
        release_recipient: account("borrower.near"),
    }];
    call_as("borrower.near", NOW, 1);
    f.contract.accept_offer(offer);
    let key = PublicKey::Secp256k1(Secp256k1PublicKey(public_key(&key(5)).try_into().unwrap()));
    testing_env!(
        context("kanso.near", NOW, 0).build(),
        near_sdk::test_vm_config(),
        near_parameters::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![PromiseResult::Successful(
            near_sdk::serde_json::to_vec(&key).unwrap()
        )]
    );
    f.contract
        .record_bitcoin_key("loan".into(), "bitcoin".into());
    f
}
fn prepare() -> Fixture {
    let mut f = prepare_setup();
    let tx = additional_deposit(&f, 1_000_000);
    call_as("borrower.near", NOW, 1);
    f.contract.verify_lock(
        "loan".into(),
        "bitcoin".into(),
        proof(&tx),
        serialize(&tx),
        0,
    );
    call_as("borrower.near", NOW, 1);
    f.contract.fund_loan("loan".into(), "fund".into());
    callback_result(&mut f.contract, "fund", NOW, true);
    f.contract.finalize_transfer("fund".into());
    f
}
fn reserve(f: &mut Fixture) {
    let revision = f.contract.get_loan("loan".into()).revision.to_string();
    call_as("borrower.near", NOW, 1);
    f.contract.prepare_bitcoin_release(
        "release".into(),
        "loan".into(),
        "bitcoin".into(),
        U128(100_000),
        U128(1000),
        revision,
    );
}
fn sign(f: &mut Fixture, op: &str, attempt: &str, fee: u128, cancel: bool) {
    call_as(
        if op == "sale" {
            "payer.near"
        } else {
            "borrower.near"
        },
        NOW,
        1,
    );
    f.contract
        .request_bitcoin_signature(op.into(), attempt.into(), U128(fee), cancel)
        .detach();
    let spend = f.contract.get_bitcoin_spend(op.into()).unwrap();
    let attempt = spend
        .attempts
        .iter()
        .find(|a| a.attempt_id == attempt)
        .unwrap();
    let response = SignatureResponse::Secp256k1(signature(&key(5), &attempt.digest));
    testing_env!(
        context("kanso.near", NOW, 0).build(),
        near_sdk::test_vm_config(),
        near_parameters::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![PromiseResult::Successful(
            near_sdk::serde_json::to_vec(&response).unwrap()
        )]
    );
    f.contract
        .record_bitcoin_signature(op.into(), attempt.attempt_id.clone());
}
#[test]
fn verified_spend_preserves_change_and_supports_bounded_fee_replacement() {
    let mut f = prepare();
    reserve(&mut f);
    sign(&mut f, "release", "first", 500, false);
    sign(&mut f, "release", "rbf", 750, false);
    let spend = f.contract.get_bitcoin_spend("release".into()).unwrap();
    let first: Transaction = deserialize(&spend.attempts[0].raw_unsigned).unwrap();
    let replacement: Transaction = deserialize(&spend.attempts[1].raw_unsigned).unwrap();
    assert_eq!(
        first.input[0].previous_output,
        replacement.input[0].previous_output
    );
    assert_eq!(first.output[0], replacement.output[0]);
    assert_eq!(
        first.output[1].value.to_sat() - replacement.output[1].value.to_sat(),
        250
    );
    let raw = f
        .contract
        .signed_bitcoin_transaction("release".into(), "first".into());
    let tx: Transaction = deserialize(&raw).unwrap();
    assert_eq!(tx.input[0].witness.len(), 2);
    call_as("borrower.near", NOW, 1);
    let result = f
        .contract
        .verify_delivery("release".into(), proof(&tx), raw.clone());
    assert_eq!(result.state, BitcoinSpendState::Delivered);
    let loan = f.contract.get_loan("loan".into());
    assert_eq!(loan.locks[0].locked_atomic.0, 899_500);
    assert_eq!(loan.locks[0].reserved_atomic.0, 0);
    f.contract
        .verify_delivery("release".into(), proof(&tx), raw);
    assert_eq!(f.contract.get_loan("loan".into()).revision, loan.revision);
}
#[test]
fn a_confirmed_conflicting_spend_invalidates_the_original_without_refunding_early() {
    let mut f = prepare();
    reserve(&mut f);
    sign(&mut f, "release", "first", 500, false);
    sign(&mut f, "release", "cancel", 1000, true);
    let raw = f
        .contract
        .signed_bitcoin_transaction("release".into(), "cancel".into());
    let tx: Transaction = deserialize(&raw).unwrap();
    call_as("borrower.near", NOW, 1);
    assert_eq!(
        f.contract
            .verify_delivery("release".into(), proof(&tx), raw)
            .state,
        BitcoinSpendState::Invalidated
    );
    let loan = f.contract.get_loan("loan".into());
    assert_eq!(loan.locks[0].locked_atomic.0, 999_000);
    assert_eq!(loan.locks[0].reserved_atomic.0, 0);
}
#[test]
#[should_panic(expected = "SIGNATURE_UNRESOLVED")]
fn signing_commitment_cannot_be_cancelled_by_a_timeout() {
    let mut f = prepare();
    reserve(&mut f);
    sign(&mut f, "release", "first", 500, false);
    call_as("borrower.near", NOW + 600, 1);
    f.contract.cancel_unsigned_bitcoin_spend("release".into());
}
#[test]
fn unsigned_cancellation_restores_the_same_utxo() {
    let mut f = prepare();
    reserve(&mut f);
    call_as("borrower.near", NOW, 1);
    f.contract.cancel_unsigned_bitcoin_spend("release".into());
    assert_eq!(
        f.contract.get_loan("loan".into()).locks[0]
            .reserved_atomic
            .0,
        0
    );
}
#[test]
fn funded_bitcoin_sale_credits_only_confirmed_output_and_retains_unused_fee() {
    let mut f = prepare();
    let revision = f.contract.get_loan("loan".into()).revision.to_string();
    call_as("payer.near", NOW, 1);
    f.contract.quote_settlement(SettlementPlan {
        operation_id: "settlement".into(),
        loan_id: "loan".into(),
        expected_revision: revision,
        leg_id: "bitcoin".into(),
        input_atomic: U128(201_000),
        net_output_atomic: U128(100_000_000),
        execution_cost_atomic: U128(500_000),
        max_source_fee_atomic: U128(1000),
        solver: account("payer.near"),
        source_recipient: account("payer.near"),
        remote_recipient: refund_script(),
        expires_at: NOW + 300,
        kind: SettlementKind::Repayment,
        conditional_version: 0,
    });
    call_as("usdc.near", NOW, 0);
    f.contract.ft_on_transfer(
        account("payer.near"),
        U128(100_000_000),
        r#"{"kind":"solver_escrow","operation_id":"settlement"}"#.into(),
    );
    call_as("borrower.near", NOW, 1);
    f.contract
        .commit_settlement("settlement".into(), "sale".into());
    sign(&mut f, "sale", "first", 500, false);
    assert_eq!(f.contract.get_loan("loan".into()).debt(), 100_000_000);
    let raw = f
        .contract
        .signed_bitcoin_transaction("sale".into(), "first".into());
    let tx: Transaction = deserialize(&raw).unwrap();
    call_as("payer.near", NOW, 1);
    f.contract.verify_delivery("sale".into(), proof(&tx), raw);
    let result = f.contract.apply_settlement("settlement".into());
    assert_eq!(result.source_spent_atomic.0, 200_500);
    assert_eq!(result.actual_cost_atomic.0, 250_000);
    let loan = f.contract.get_loan("loan".into());
    assert_eq!(loan.state, LoanState::Repaid);
    assert_eq!(loan.locks[0].locked_atomic.0, 799_500);
}

fn additional_deposit(f: &Fixture, amount: u64) -> Transaction {
    Transaction {
        version: transaction::Version::TWO,
        lock_time: absolute::LockTime::ZERO,
        input: vec![deposit_input()],
        output: vec![TxOut {
            value: Amount::from_sat(amount),
            script_pubkey: ScriptBuf::from_bytes(
                f.contract
                    .bitcoin_deposit_script("loan".into(), "bitcoin".into()),
            ),
        }],
    }
}
#[test]
fn extra_bitcoin_output_is_refunded_without_changing_pledged_collateral_or_debt() {
    let mut f = prepare();
    let original = f.contract.get_loan("loan".into());
    let tx = additional_deposit(&f, 200_000);
    call_as("borrower.near", NOW, 1);
    f.contract.verify_recovery(
        "extra".into(),
        "loan".into(),
        "bitcoin".into(),
        proof(&tx),
        serialize(&tx),
        0,
    );
    f.contract
        .prepare_bitcoin_recovery("extra".into(), "refund_extra".into(), U128(1000));
    sign(&mut f, "refund_extra", "first", 500, false);
    sign(&mut f, "refund_extra", "rbf", 750, false);
    let raw = f
        .contract
        .signed_bitcoin_transaction("refund_extra".into(), "rbf".into());
    let refund: Transaction = deserialize(&raw).unwrap();
    assert_eq!(refund.output.len(), 1);
    assert_eq!(refund.output[0].value.to_sat(), 199_250);
    assert_eq!(refund.output[0].script_pubkey.as_bytes(), refund_script());
    call_as("borrower.near", NOW, 1);
    f.contract
        .verify_delivery("refund_extra".into(), proof(&refund), raw.clone());
    f.contract
        .verify_delivery("refund_extra".into(), proof(&refund), raw);
    assert!(
        f.contract
            .get_bitcoin_recovery("extra".into())
            .unwrap()
            .completed
    );
    let loan = f.contract.get_loan("loan".into());
    assert_eq!(loan.revision, original.revision);
    assert_eq!(loan.debt(), original.debt());
    assert_eq!(loan.locks[0].locked_atomic, original.locks[0].locked_atomic);
}
#[test]
#[should_panic(expected = "OUTPOINT_ALREADY_ASSIGNED")]
fn a_pledged_bitcoin_output_cannot_be_reclassified_as_a_refund() {
    let mut f = prepare();
    let tx = additional_deposit(&f, 1_000_000);
    call_as("borrower.near", NOW, 1);
    f.contract.verify_recovery(
        "stolen".into(),
        "loan".into(),
        "bitcoin".into(),
        proof(&tx),
        serialize(&tx),
        0,
    );
}

#[test]
fn proof_submission_waits_for_both_callbacks_and_uses_manifest_confirmations() {
    use near_sdk::mock::MockAction;
    let mut f = prepare();
    reserve(&mut f);
    sign(&mut f, "release", "first", 500, false);
    let raw = f
        .contract
        .signed_bitcoin_transaction("release".into(), "first".into());
    let tx: Transaction = deserialize(&raw).unwrap();
    let proof = proof(&tx);
    let expected = proof.borsh_args(3);
    call_as("borrower.near", NOW, 1);
    let before = serde_json::to_value(f.contract.get_loan("loan".into())).unwrap();
    f.contract
        .submit_bitcoin_delivery("release".into(), proof, raw)
        .detach();
    assert_eq!(
        serde_json::to_value(f.contract.get_loan("loan".into())).unwrap(),
        before
    );
    assert_eq!(
        f.contract
            .get_bitcoin_spend("release".into())
            .unwrap()
            .state,
        BitcoinSpendState::Signed
    );
    let receipts = near_sdk::test_utils::get_created_receipts();
    assert_eq!(receipts.len(), 3);
    assert_eq!(receipts[0].receiver_id, account("btc-client.testnet"));
    assert_eq!(receipts[1].receiver_id, account("btc-client.testnet"));
    let MockAction::FunctionCallWeight {
        method_name, args, ..
    } = &receipts[0].actions[0]
    else {
        panic!("function call required")
    };
    assert_eq!(method_name, b"verify_transaction_inclusion_v2");
    assert_eq!(args, &expected);
    assert_eq!(&expected[expected.len() - 8..], &3_u64.to_le_bytes());
    assert_eq!(receipts[2].receiver_id, account("kanso.near"));
}

#[test]
fn failed_false_malformed_or_stale_proofs_never_resolve_a_spend() {
    let mut f = prepare();
    reserve(&mut f);
    sign(&mut f, "release", "first", 500, false);
    let raw = f
        .contract
        .signed_bitcoin_transaction("release".into(), "first".into());
    let before = serde_json::to_value(f.contract.get_loan("loan".into())).unwrap();
    let tip = |time| {
        PromiseResult::Successful(
            serde_json::to_vec(
                &serde_json::json!({"block_height":500,"block_header":{"time":time}}),
            )
            .unwrap(),
        )
    };
    let cases = vec![
        (PromiseResult::Failed, tip(NOW)),
        (PromiseResult::Successful(b"false".to_vec()), tip(NOW)),
        (PromiseResult::Successful(b"\"true\"".to_vec()), tip(NOW)),
        (
            PromiseResult::Successful(b"true".to_vec()),
            PromiseResult::Failed,
        ),
        (PromiseResult::Successful(b"true".to_vec()), tip(NOW - 7201)),
        (PromiseResult::Successful(b"true".to_vec()), tip(NOW + 7201)),
    ];
    for (inclusion, tip) in cases {
        callback_results(inclusion, tip, NOW);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            f.contract.complete_bitcoin_verification(
                BitcoinProofAction::Delivery {
                    operation_id: "release".into(),
                },
                raw.clone(),
                account("borrower.near"),
            )
        }));
        assert!(result.is_err());
        assert_eq!(
            serde_json::to_value(f.contract.get_loan("loan".into())).unwrap(),
            before
        );
        assert_eq!(
            f.contract
                .get_bitcoin_spend("release".into())
                .unwrap()
                .state,
            BitcoinSpendState::Signed
        );
    }
    call_as("borrower.near", NOW, 1);
    let tx: Transaction = deserialize(&raw).unwrap();
    assert_eq!(
        f.contract
            .verify_delivery("release".into(), proof(&tx), raw)
            .state,
        BitcoinSpendState::Delivered
    );
}

#[test]
fn transaction_bytes_coinbase_and_proof_depth_are_checked_before_scheduling() {
    let f = prepare();
    let tx = additional_deposit(&f, 100_000);
    let raw = serialize(&tx);
    let mut wrong_id = proof(&tx);
    wrong_id.tx_id = "00".repeat(32);
    let mut wrong_depth = proof(&tx);
    wrong_depth.coinbase_merkle_proof.clear();
    let mut wrong_index = proof(&tx);
    wrong_index.tx_index = 2;
    for proof in [wrong_id, wrong_depth, wrong_index] {
        assert!(std::panic::catch_unwind(|| proof.validate_transaction(&raw)).is_err());
    }
    let mut coinbase = tx;
    coinbase.input = vec![TxIn::default()];
    assert!(std::panic::catch_unwind(
        || proof(&coinbase).validate_transaction(&serialize(&coinbase))
    )
    .is_err());
}

#[test]
fn verifier_binding_is_immutable_and_cannot_change_the_historical_network() {
    let mut f = prepare();
    let verifier = f.contract.get_bitcoin_verifier(1).unwrap();
    call_as("owner.near", NOW, 1);
    f.contract.register_bitcoin_verifier(1, verifier.clone());
    for changed in [
        BitcoinVerifier {
            account_id: account("attacker.near"),
            ..verifier.clone()
        },
        BitcoinVerifier {
            network_fingerprint: "00".repeat(32),
            ..verifier.clone()
        },
    ] {
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f
            .contract
            .register_bitcoin_verifier(1, changed)))
        .is_err());
    }
    call_as("borrower.near", NOW, 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f
        .contract
        .register_bitcoin_verifier(1, verifier)))
    .is_err());
}

#[test]
fn replaying_a_deposit_after_spending_cannot_restore_the_old_balance() {
    let mut f = prepare();
    let original = additional_deposit(&f, 1_000_000);
    reserve(&mut f);
    sign(&mut f, "release", "first", 500, false);
    let raw = f
        .contract
        .signed_bitcoin_transaction("release".into(), "first".into());
    let tx: Transaction = deserialize(&raw).unwrap();
    call_as("borrower.near", NOW, 1);
    f.contract
        .verify_delivery("release".into(), proof(&tx), raw);
    let before = serde_json::to_value(f.contract.get_loan("loan".into())).unwrap();
    f.contract.verify_lock(
        "loan".into(),
        "bitcoin".into(),
        proof(&original),
        serialize(&original),
        0,
    );
    assert_eq!(
        serde_json::to_value(f.contract.get_loan("loan".into())).unwrap(),
        before
    );
    let revision = f.contract.get_loan("loan".into()).revision.to_string();
    let next = f.contract.prepare_bitcoin_release(
        "next".into(),
        "loan".into(),
        "bitcoin".into(),
        U128(100_000),
        U128(1000),
        revision,
    );
    assert_eq!(next.input.amount, 899_500);
}

#[test]
fn a_cancelled_setup_can_receive_a_late_verified_deposit_only_for_refund() {
    let mut f = prepare_setup();
    let tx = additional_deposit(&f, 1_000_000);
    let raw = serialize(&tx);
    call_as("borrower.near", NOW, 1);
    f.contract
        .submit_bitcoin_lock("loan".into(), "bitcoin".into(), proof(&tx), raw.clone(), 0)
        .detach();
    f.contract.abort_setup("loan".into());
    let result: Loan = serde_json::from_value(verified(
        &mut f.contract,
        BitcoinProofAction::Lock {
            loan_id: "loan".into(),
            leg_id: "bitcoin".into(),
            vout: 0,
        },
        raw,
    ))
    .unwrap();
    assert_eq!(result.state, LoanState::Cancelled);
    assert_eq!(
        result.setup_state,
        kanso_coordinator::state::SetupState::Aborting
    );
    assert_eq!(result.debt(), 0);
    assert_eq!(result.locks[0].locked_atomic.0, 1_000_000);
    let spend = f.contract.prepare_bitcoin_release(
        "abort_refund".into(),
        "loan".into(),
        "bitcoin".into(),
        U128(999_000),
        U128(1000),
        result.revision.to_string(),
    );
    assert_eq!(spend.recipient_script, refund_script());
}

#[test]
fn an_included_amount_mismatch_cannot_fund_and_remains_refundable() {
    let mut f = prepare_setup();
    let tx = additional_deposit(&f, 900_000);
    call_as("borrower.near", NOW, 1);
    let loan = f.contract.verify_lock(
        "loan".into(),
        "bitcoin".into(),
        proof(&tx),
        serialize(&tx),
        0,
    );
    assert!(loan.locks[0].receipt_verified);
    assert!(!loan.locks[0].accepted);
    assert_eq!(loan.locks[0].locked_atomic.0, 900_000);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f
        .contract
        .fund_loan("loan".into(), "mismatch_fund".into())))
    .is_err());
    f.contract.abort_setup("loan".into());
    let revision = f.contract.get_loan("loan".into()).revision.to_string();
    let spend = f.contract.prepare_bitcoin_release(
        "mismatch_refund".into(),
        "loan".into(),
        "bitcoin".into(),
        U128(899_000),
        U128(1000),
        revision,
    );
    assert_eq!(spend.input.amount, 900_000);
    assert_eq!(spend.recipient_script, refund_script());
}
