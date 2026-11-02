mod common;
#[path = "common/remote.rs"]
mod remote;
use common::*;
use kanso_coordinator::{
    operation::RemoteState,
    state::{Custody, SetupState},
    transaction::TransactionContext,
};
use near_sdk::{env, json_types::U128};
use remote::*;
#[test]
fn all_six_evm_chain_proofs_cross_the_barrier_and_commit_bounded_transactions() {
    for chain in [
        "base",
        "arbitrum",
        "bnb",
        "polygon",
        "avalanche",
        "hyperevm",
    ] {
        let mut f = Fixture::new();
        let m = register(&mut f, chain);
        let mut offer = f.offer("loan");
        offer.policy_version = 2;
        offer.legs = vec![leg(chain)];
        call_as("borrower.near", NOW, 1);
        f.contract.accept_offer(offer);
        let proof = lock_proof(&f, &m, "loan");
        let loan = f
            .contract
            .submit_remote_lock("loan".into(), chain.into(), proof.clone());
        assert_eq!(loan.setup_state, SetupState::Ready);
        assert_eq!(
            f.contract
                .submit_remote_lock("loan".into(), chain.into(), proof)
                .revision,
            loan.revision
        );
        call_as("borrower.near", NOW, 1);
        f.contract.fund_loan("loan".into(), "fund".into());
        callback_result(&mut f.contract, "fund", NOW, true);
        f.contract.finalize_transfer("fund".into());
        callback_key(&mut f, &m);
        let loan = f.contract.get_loan("loan".into());
        call_as("borrower.near", NOW, 1);
        let op = f.contract.prepare_remote_release(
            "release".into(),
            "loan".into(),
            chain.into(),
            U128(100_000_000_000_000_000),
            loan.revision.to_string(),
            NOW + 300,
        );
        assert_eq!(op.state, RemoteState::Prepared);
        let _ = f.contract.request_remote_signature(
            "release".into(),
            "attempt".into(),
            TransactionContext::Evm {
                nonce: 0,
                gas_limit: 100_000,
                max_fee_per_gas: U128(1_000_000_000),
                max_priority_fee_per_gas: U128(1_000_000),
            },
            false,
        );
        let op = f.contract.get_remote_operation("release".into()).unwrap();
        assert_eq!(op.state, RemoteState::Signing);
        assert_eq!(op.signing_attempts.len(), 1);
        let tx = &op.signing_attempts[0].transaction;
        assert_eq!(tx[0], 2);
        let rlp = rlp::Rlp::new(&tx[1..]);
        assert_eq!(
            rlp.val_at::<u64>(0).unwrap(),
            m.network_fingerprint.parse::<u64>().unwrap()
        );
        assert_eq!(rlp.val_at::<Vec<u8>>(5).unwrap(), m.vault);
        assert_eq!(env::keccak256(tx), op.signing_attempts[0].payload);
        f.contract.submit_remote_signature(
            "release".into(),
            "attempt".into(),
            near_mpc_contract_interface::types::SignatureResponse::Secp256k1(signature(
                &key(3),
                &op.signing_attempts[0].payload,
            )),
        );
        let broadcast = f
            .contract
            .remote_broadcast_transaction("release".into(), "attempt".into());
        assert_eq!(
            rlp::Rlp::new(&broadcast.transaction[1..])
                .item_count()
                .unwrap(),
            12
        );
        call_as("borrower.near", NOW, 1);
        let receipt = delivery_proof(&op, 900_000_000_000_000_000, false);
        assert_eq!(
            f.contract
                .submit_remote_delivery("release".into(), receipt.clone())
                .state,
            RemoteState::Delivered
        );
        let resolved = f.contract.get_loan("loan".into());
        assert_eq!(resolved.locks[0].locked_atomic.0, 900_000_000_000_000_000);
        assert_eq!(resolved.locks[0].reserved_atomic.0, 0);
        assert_eq!(resolved.locks[0].remote_nonce, 1);
        assert!(resolved.active_outflow.is_none());
        f.contract.submit_remote_delivery("release".into(), receipt);
        assert_eq!(
            f.contract.get_loan("loan".into()).revision,
            resolved.revision
        );
    }
}
#[test]
#[should_panic(expected = "MPC_SIGNER_MISMATCH")]
fn a_changed_receipt_has_no_mpc_authority() {
    let mut f = Fixture::new();
    let m = register(&mut f, "base");
    let mut offer = f.offer("loan");
    offer.policy_version = 2;
    offer.legs = vec![leg("base")];
    call_as("borrower.near", NOW, 1);
    f.contract.accept_offer(offer);
    let mut proof = lock_proof(&f, &m, "loan");
    proof.signature.s.scalar[0] ^= 1;
    f.contract
        .submit_remote_lock("loan".into(), "base".into(), proof);
}
#[test]
#[should_panic(expected = "LOCK_COMMITMENT_MISMATCH")]
fn even_an_authentic_mpc_receipt_cannot_bind_the_wrong_refund_owner() {
    let mut f = Fixture::new();
    let m = register(&mut f, "base");
    let mut offer = f.offer("loan");
    offer.policy_version = 2;
    let mut source = leg("base");
    if let Custody::Remote {
        release_recipient, ..
    } = &mut source.custody
    {
        *release_recipient = vec![99; 20];
    }
    offer.legs = vec![source];
    call_as("borrower.near", NOW, 1);
    f.contract.accept_offer(offer);
    let proof = lock_proof(&f, &m, "loan");
    f.contract
        .submit_remote_lock("loan".into(), "base".into(), proof);
}

#[test]
fn incorrect_source_amount_is_recorded_without_credit_and_is_refundable_after_abort() {
    let mut f = Fixture::new();
    let m = register(&mut f, "base");
    let mut offer = f.offer("loan");
    offer.policy_version = 2;
    offer.legs = vec![leg("base")];
    call_as("borrower.near", NOW, 1);
    f.contract.accept_offer(offer);
    let loan = f.contract.submit_remote_lock(
        "loan".into(),
        "base".into(),
        lock_proof_amount(&f, &m, "loan", 2_000_000_000_000_000_000),
    );
    assert!(loan.locks[0].receipt_verified);
    assert!(!loan.locks[0].accepted);
    assert_eq!(loan.setup_state, SetupState::Locking);
    assert_eq!(
        f.contract
            .basket_risk("loan".into())
            .borrowing_capacity_atomic
            .0,
        0
    );
    f.contract.abort_setup("loan".into());
    let revision = f.contract.get_loan("loan".into()).revision.to_string();
    let op = f.contract.prepare_remote_release(
        "refund".into(),
        "loan".into(),
        "base".into(),
        U128(2_000_000_000_000_000_000),
        revision,
        NOW + 300,
    );
    f.contract
        .request_remote_signature(
            "refund".into(),
            "refund_attempt".into(),
            TransactionContext::Evm {
                nonce: 0,
                gas_limit: 100_000,
                max_fee_per_gas: U128(1_000_000_000),
                max_priority_fee_per_gas: U128(1_000_000),
            },
            false,
        )
        .detach();
    f.contract
        .submit_remote_delivery("refund".into(), delivery_proof(&op, 0, false));
    assert_eq!(
        f.contract.get_loan("loan".into()).setup_state,
        SetupState::Aborted
    );
}

#[test]
#[should_panic(expected = "DELIVERY_MISMATCH")]
fn an_authentic_receipt_for_another_recipient_cannot_resolve_a_spend() {
    let mut f = Fixture::new();
    let m = register(&mut f, "base");
    let mut offer = f.offer("loan");
    offer.policy_version = 2;
    offer.legs = vec![leg("base")];
    call_as("borrower.near", NOW, 1);
    f.contract.accept_offer(offer);
    f.contract
        .submit_remote_lock("loan".into(), "base".into(), lock_proof(&f, &m, "loan"));
    f.contract.fund_loan("loan".into(), "fund".into());
    callback_result(&mut f.contract, "fund", NOW, true);
    f.contract.finalize_transfer("fund".into());
    let rev = f.contract.get_loan("loan".into()).revision.to_string();
    call_as("borrower.near", NOW, 1);
    let mut op = f.contract.prepare_remote_release(
        "release".into(),
        "loan".into(),
        "base".into(),
        U128(100_000_000_000_000_000),
        rev,
        NOW + 300,
    );
    f.contract
        .request_remote_signature(
            "release".into(),
            "attempt".into(),
            TransactionContext::Evm {
                nonce: 0,
                gas_limit: 100_000,
                max_fee_per_gas: U128(1_000_000_000),
                max_priority_fee_per_gas: U128(1_000_000),
            },
            false,
        )
        .detach();
    op.command.recipient = vec![99; 20];
    f.contract.submit_remote_delivery(
        "release".into(),
        delivery_proof(&op, 900_000_000_000_000_000, false),
    );
}

fn forged_finality_proof(
    f: &Fixture,
    m: &kanso_coordinator::manifest::ChainManifest,
    wrong_chain: bool,
) -> kanso_coordinator::mpc::ReadProof {
    use near_mpc_contract_interface::types::*;
    let mut p = lock_proof(f, m, "loan");
    let ForeignTxSignPayload::V1(payload) = &mut p.payload;
    let ForeignChainRpcRequest::Base(mut request) = payload.request.clone() else {
        unreachable!()
    };
    if wrong_chain {
        payload.request = ForeignChainRpcRequest::Arbitrum(request);
    } else {
        request.finality = EvmFinality::Latest;
        payload.request = ForeignChainRpcRequest::Base(request);
    }
    p.signature = signature(&key(2), &p.payload.compute_msg_hash().unwrap().0);
    p
}
#[test]
#[should_panic(expected = "INSUFFICIENT_FINALITY")]
fn authentic_but_unfinalized_observations_cannot_accept_a_lock() {
    let mut f = Fixture::new();
    let m = register(&mut f, "base");
    let mut offer = f.offer("loan");
    offer.policy_version = 2;
    offer.legs = vec![leg("base")];
    call_as("borrower.near", NOW, 1);
    f.contract.accept_offer(offer);
    let proof = forged_finality_proof(&f, &m, false);
    f.contract
        .submit_remote_lock("loan".into(), "base".into(), proof);
}
#[test]
#[should_panic(expected = "PROOF_CHAIN_MISMATCH")]
fn an_authentic_receipt_from_another_chain_cannot_accept_a_lock() {
    let mut f = Fixture::new();
    let m = register(&mut f, "base");
    let mut offer = f.offer("loan");
    offer.policy_version = 2;
    offer.legs = vec![leg("base")];
    call_as("borrower.near", NOW, 1);
    f.contract.accept_offer(offer);
    let proof = forged_finality_proof(&f, &m, true);
    f.contract
        .submit_remote_lock("loan".into(), "base".into(), proof);
}
