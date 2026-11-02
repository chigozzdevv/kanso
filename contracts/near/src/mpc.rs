use crate::{
    manifest::{ChainFamily, ChainManifest},
    Coordinator, CoordinatorExt,
};
use near_mpc_contract_interface::types::{ForeignTxSignPayload, K256Signature};
use near_sdk::{env, near};

#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct ReadProof {
    pub payload: ForeignTxSignPayload,
    pub signature: K256Signature,
}

pub fn verify_read(manifest: &ChainManifest, proof: &ReadProof) {
    let hash = proof
        .payload
        .compute_msg_hash()
        .expect("INVALID_PROOF_ENCODING");
    let recovered = env::ecrecover(
        &hash.0,
        &proof.signature.to_ecrecover_bytes(),
        proof.signature.recovery_id,
        true,
    )
    .expect("INVALID_MPC_SIGNATURE");
    assert_eq!(
        recovered.as_slice(),
        manifest.read_public_key.as_slice(),
        "MPC_SIGNER_MISMATCH"
    );
    let near_mpc_contract_interface::types::ForeignTxSignPayload::V1(payload) = &proof.payload;
    use near_mpc_contract_interface::types::{
        EvmFinality, ForeignChainRpcRequest as R, StarknetFinality, SuiFinality, SvmFinality,
    };
    let evm = match (&manifest.family, &payload.request) {
        (ChainFamily::Evm, R::Base(r)) if manifest.chain_id == "base" => Some(r),
        (ChainFamily::Evm, R::Arbitrum(r)) if manifest.chain_id == "arbitrum" => Some(r),
        (ChainFamily::Evm, R::Bnb(r)) if manifest.chain_id == "bnb" => Some(r),
        (ChainFamily::Evm, R::Polygon(r)) if manifest.chain_id == "polygon" => Some(r),
        (ChainFamily::Evm, R::Avalanche(r)) if manifest.chain_id == "avalanche" => Some(r),
        (ChainFamily::Evm, R::HyperEvm(r)) if manifest.chain_id == "hyperevm" => Some(r),
        (ChainFamily::Solana, R::Solana(r)) => {
            assert_eq!(r.finality, SvmFinality::Finalized, "INSUFFICIENT_FINALITY");
            None
        }
        (ChainFamily::Sui, R::Sui(r)) => {
            assert_eq!(
                r.finality,
                SuiFinality::Checkpointed,
                "INSUFFICIENT_FINALITY"
            );
            None
        }
        (ChainFamily::Starknet, R::Starknet(r)) => {
            assert_eq!(
                r.finality,
                StarknetFinality::AcceptedOnL1,
                "INSUFFICIENT_FINALITY"
            );
            None
        }
        (ChainFamily::Bitcoin, R::Bitcoin(r)) => {
            assert!(
                r.confirmations.0 >= manifest.minimum_confirmations,
                "INSUFFICIENT_CONFIRMATIONS"
            );
            None
        }
        _ => panic!("PROOF_CHAIN_MISMATCH"),
    };
    if let Some(request) = evm {
        assert_eq!(
            request.finality,
            EvmFinality::Finalized,
            "INSUFFICIENT_FINALITY"
        );
    }
    assert_eq!(payload.values.len(), 1, "ONE_OBSERVATION_REQUIRED");
}

pub fn commitment(family: &ChainFamily, value: &[u8]) -> Vec<u8> {
    let mut hash = env::sha256(value);
    if *family == ChainFamily::Starknet {
        hash[0] &= 3;
    }
    hash
}

pub fn pda(program: &[u8], seeds: &[&[u8]]) -> Vec<u8> {
    assert_eq!(program.len(), 32, "INVALID_PROGRAM");
    for bump in (0..=255_u8).rev() {
        let mut bytes = Vec::new();
        for seed in seeds {
            assert!(seed.len() <= 32, "INVALID_PDA_SEED");
            bytes.extend_from_slice(seed);
        }
        bytes.push(bump);
        bytes.extend_from_slice(program);
        bytes.extend_from_slice(b"ProgramDerivedAddress");
        let address: [u8; 32] = env::sha256(&bytes).try_into().unwrap();
        if curve25519_dalek::edwards::CompressedEdwardsY(address)
            .decompress()
            .is_none()
        {
            return address.to_vec();
        }
    }
    panic!("PDA_NOT_FOUND")
}

#[near_sdk::near]
impl Coordinator {
    #[payable]
    pub fn request_read_attestation(
        &mut self,
        chain_id: String,
        manifest_version: u32,
        payload: ForeignTxSignPayload,
    ) -> near_sdk::Promise {
        let manifest = self.get_chain_manifest(chain_id, Some(manifest_version));
        let hash = payload.compute_msg_hash().expect("INVALID_PROOF_ENCODING");
        let ForeignTxSignPayload::V1(payload) = payload;
        let request = near_mpc_contract_interface::types::VerifyForeignTransactionRequestArgs {
            request: payload.request,
            domain_id: near_mpc_contract_interface::types::DomainId(manifest.read_domain),
            payload_version: near_mpc_contract_interface::types::ForeignTxPayloadVersion::V1,
            expected_payload_hash: Some(hash),
        };
        let bytes = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"request":request}))
            .unwrap();
        assert!(bytes.len() <= 16_384, "READ_REQUEST_TOO_LARGE");
        near_sdk::Promise::new(manifest.mpc_account).function_call(
            "verify_foreign_transaction",
            bytes,
            env::attached_deposit(),
            near_sdk::Gas::from_tgas(100),
        )
    }
}
