mod common;
use common::*;
use ed25519_dalek::{Signer, SigningKey};
use kanso_coordinator::{
    recovery::{OutcomeAttestation, OutcomeSignature, RecoveryPolicy},
    state::{LoanState, TransferOutcome},
};
fn setup() -> (Fixture, SigningKey, SigningKey) {
    let mut f = Fixture::new();
    let a = SigningKey::from_bytes(&[11; 32]);
    let b = SigningKey::from_bytes(&[12; 32]);
    call_as("owner.near", NOW, 1);
    f.contract.configure_recovery(RecoveryPolicy {
        public_keys: vec![
            a.verifying_key().to_bytes().to_vec(),
            b.verifying_key().to_bytes().to_vec(),
        ],
        threshold: 2,
    });
    f.ready("loan");
    call_as("borrower.near", NOW, 1);
    f.contract.fund_loan("loan".into(), "fund".into());
    (f, a, b)
}
fn attest(f: &Fixture, a: &SigningKey, b: &SigningKey, success: bool) -> OutcomeAttestation {
    let mut proof = OutcomeAttestation {
        transfer_id: "fund".into(),
        succeeded: success,
        receipt_id: vec![1; 32],
        finalized_block_hash: vec![2; 32],
        finalized_block_height: 100,
        observed_at: NOW,
        signatures: vec![],
    };
    let message = f.contract.recovery_message(proof.clone());
    proof.signatures = vec![
        OutcomeSignature {
            key_index: 0,
            signature: a.sign(&message).to_bytes().to_vec(),
        },
        OutcomeSignature {
            key_index: 1,
            signature: b.sign(&message).to_bytes().to_vec(),
        },
    ];
    proof
}
#[test]
fn interrupted_success_callback_can_be_authenticated_and_finalized_without_a_second_payout() {
    let (mut f, a, b) = setup();
    let proof = attest(&f, &a, &b, true);
    call_as("payer.near", NOW, 0);
    let recovered = f.contract.recover_transfer_outcome(proof.clone());
    assert_eq!(recovered.outcome, TransferOutcome::Succeeded);
    f.contract.finalize_transfer("fund".into());
    f.contract.recover_transfer_outcome(proof);
    assert_eq!(f.contract.get_loan("loan".into()).state, LoanState::Active);
    assert!(f.contract.get_transfer("fund".into()).unwrap().finalized);
}
#[test]
fn interrupted_failure_callback_can_restore_only_the_original_reservation() {
    let (mut f, a, b) = setup();
    let proof = attest(&f, &a, &b, false);
    call_as("payer.near", NOW, 0);
    f.contract.recover_transfer_outcome(proof);
    f.contract.finalize_transfer("fund".into());
    let pool = f.contract.get_pool("pool".into());
    assert_eq!(pool.cash_atomic.0, 1_000_000_000);
    assert_eq!(pool.reserved_atomic.0, 100_000_000);
    assert_eq!(
        f.contract.get_loan("loan".into()).state,
        LoanState::PendingFunding
    );
}
#[test]
#[should_panic(expected = "DUPLICATE_RECOVERY_SIGNER")]
fn one_attestor_cannot_count_twice() {
    let (mut f, a, b) = setup();
    let mut proof = attest(&f, &a, &b, true);
    proof.signatures[1] = proof.signatures[0].clone();
    call_as("payer.near", NOW, 0);
    f.contract.recover_transfer_outcome(proof);
}
#[test]
#[should_panic(expected = "INVALID_RECOVERY_SIGNATURE")]
fn signed_success_cannot_be_changed_into_a_failure() {
    let (mut f, a, b) = setup();
    let mut proof = attest(&f, &a, &b, true);
    proof.succeeded = false;
    call_as("payer.near", NOW, 0);
    f.contract.recover_transfer_outcome(proof);
}
#[test]
#[should_panic(expected = "RECOVERY_POLICY_FROZEN")]
fn an_admin_cannot_replace_attestors_after_a_transfer_is_committed() {
    let (mut f, a, _) = setup();
    call_as("owner.near", NOW, 1);
    f.contract.configure_recovery(RecoveryPolicy {
        public_keys: vec![a.verifying_key().to_bytes().to_vec()],
        threshold: 1,
    });
}

#[test]
#[should_panic(expected = "RECOVERY_NOT_CONFIGURED")]
fn testnet_cannot_commit_a_transfer_without_a_recovery_policy() {
    let mut f = Fixture::with_network(kanso_coordinator::config::Network::Testnet);
    let mut offer = f.offer("loan");
    offer.network = kanso_coordinator::config::Network::Testnet;
    call_as("borrower.near", NOW, 1);
    f.contract.accept_offer(offer);
    call_as(
        "borrower.near",
        NOW,
        100 * kanso_coordinator::math::NEAR_SCALE,
    );
    f.contract.lock_native("loan".into(), "near".into());
    call_as("borrower.near", NOW, 1);
    f.contract.fund_loan("loan".into(), "fund".into());
}
