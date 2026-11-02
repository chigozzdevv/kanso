#![allow(dead_code)]
use super::*;
use k256::ecdsa::SigningKey;
use kanso_coordinator::{
    manifest::{ChainFamily, ChainManifest},
    mpc::ReadProof,
    state::{BasketLeg, Custody, Price},
};
use near_mpc_contract_interface::types::*;
use near_sdk::{env, testing_env, PromiseResult};

pub fn key(byte: u8) -> SigningKey {
    SigningKey::from_bytes((&[byte; 32]).into()).unwrap()
}
pub fn public_key(key: &SigningKey) -> Vec<u8> {
    key.verifying_key().to_encoded_point(false).as_bytes()[1..].to_vec()
}
pub fn signature(key: &SigningKey, digest: &[u8]) -> K256Signature {
    let (signature, id) = key.sign_prehash_recoverable(digest).unwrap();
    let bytes = signature.to_bytes();
    let mut point = [0; 33];
    point[0] = 2 + (id.to_byte() & 1);
    point[1..].copy_from_slice(&bytes[..32]);
    K256Signature {
        big_r: K256AffinePoint {
            affine_point: point,
        },
        s: K256Scalar {
            scalar: bytes[32..].try_into().unwrap(),
        },
        recovery_id: id.to_byte(),
    }
}
pub fn proof(
    manifest: &ChainManifest,
    value: ExtractedValue,
    extractor: EvmExtractor,
) -> ReadProof {
    let request = EvmRpcRequest {
        tx_id: EvmTxId([9; 32]),
        extractors: vec![extractor].try_into().unwrap(),
        finality: EvmFinality::Finalized,
    };
    let request = match manifest.chain_id.as_str() {
        "base" => ForeignChainRpcRequest::Base(request),
        "arbitrum" => ForeignChainRpcRequest::Arbitrum(request),
        "bnb" => ForeignChainRpcRequest::Bnb(request),
        "polygon" => ForeignChainRpcRequest::Polygon(request),
        "avalanche" => ForeignChainRpcRequest::Avalanche(request),
        _ => ForeignChainRpcRequest::HyperEvm(request),
    };
    let payload = ForeignTxSignPayload::V1(ForeignTxSignPayloadV1 {
        request,
        values: vec![value],
    });
    let signature = signature(&key(2), &payload.compute_msg_hash().unwrap().0);
    ReadProof { payload, signature }
}
pub fn manifest(chain: &str) -> ChainManifest {
    let controller = public_key(&key(3));
    let hash = env::keccak256(&controller);
    ChainManifest {
        chain_id: chain.into(),
        version: 1,
        family: ChainFamily::Evm,
        network_fingerprint: match chain {
            "base" => "84532",
            "arbitrum" => "421614",
            "bnb" => "97",
            "polygon" => "80002",
            "avalanche" => "43113",
            _ => "998",
        }
        .into(),
        vault: vec![7; 20],
        controller: hash[12..].to_vec(),
        controller_public_key: controller,
        asset_id: chain.into(),
        asset_address: vec![],
        decimals: 18,
        max_collateral_atomic: U128(1_000_000_000_000_000_000_000_000),
        ltv_bps: 5000,
        liquidation_threshold_bps: 7000,
        mpc_account: account("mpc.near"),
        read_domain: 2,
        read_public_key: public_key(&key(2)),
        sign_domain: 0,
        derivation_path: format!("kanso/test/{chain}"),
        minimum_confirmations: 1,
        initial_account_nonce: 0,
        max_gas: 500_000,
        max_fee_per_gas: U128(1_000_000_000_000),
        max_network_cost_atomic: U128(1_000_000_000_000_000_000),
        capability_evidence_hash: vec![8; 32],
        new_locks_enabled: true,
        signing_enabled: true,
    }
}
pub fn register(f: &mut Fixture, chain: &str) -> ChainManifest {
    let m = manifest(chain);
    call_as("owner.near", NOW, 1);
    f.contract.register_chain_manifest(m.clone());
    callback_key(f, &m);
    call_as("oracle.near", NOW, 0);
    f.contract.publish_asset_price(
        chain.into(),
        Price {
            price_atomic: U128(2_000_000_000),
            confidence_bps: 0,
            published_at: NOW,
            sequence: 1,
        },
    );
    let mut policy = f.contract.get_pool("pool".into()).policy;
    policy.version += 1;
    policy.eligible_assets.push(chain.into());
    policy.asset_caps.push(kanso_coordinator::state::AssetCap {
        asset_id: chain.into(),
        max_collateral_value_atomic: U128(1_000_000_000_000),
    });
    call_as("lp.near", NOW, 1);
    f.contract.update_pool_policy("pool".into(), policy);
    m
}
pub fn leg(chain: &str) -> BasketLeg {
    BasketLeg {
        asset_id: chain.into(),
        custody: Custody::Remote {
            chain_id: chain.into(),
            manifest_version: 1,
            lock_id: vec![11; 32],
            source_owner: vec![12; 20],
            release_recipient: vec![12; 20],
            min_price_atomic: U128(1_000_000_000),
            max_price_atomic: U128(3_000_000_000),
        },
        leg_id: chain.into(),
        owner: account("borrower.near"),
        amount_atomic: U128(1_000_000_000_000_000_000),
        release_recipient: account("borrower.near"),
    }
}
pub fn word(value: &[u8]) -> Vec<u8> {
    let mut w = vec![0; 32 - value.len()];
    w.extend_from_slice(value);
    w
}
pub fn lock_proof(f: &Fixture, m: &ChainManifest, loan_id: &str) -> ReadProof {
    lock_proof_amount(f, m, loan_id, 1_000_000_000_000_000_000)
}
pub fn lock_proof_amount(f: &Fixture, m: &ChainManifest, loan_id: &str, amount: u128) -> ReadProof {
    let loan = f.contract.get_loan(loan_id.into());
    let mut data = env::sha256(b"sandbox_tests");
    data.extend_from_slice(&env::sha256(m.chain_id.as_bytes()));
    data.extend_from_slice(&word(&[12; 20]));
    data.extend_from_slice(&word(&[12; 20]));
    data.extend_from_slice(&[0; 32]);
    data.extend_from_slice(&word(&amount.to_be_bytes()));
    data.extend_from_slice(&[0; 32]);
    let topics=vec![Hash256(env::keccak256(b"LockAccepted(bytes32,bytes32,bytes32,bytes32,bytes32,address,address,address,uint128,uint8)").try_into().unwrap()),Hash256([11;32]),Hash256(loan.offer_hash.try_into().unwrap()),Hash256(env::sha256(b"borrower.near").try_into().unwrap())];
    proof(
        m,
        ExtractedValue::EvmExtractedValue(EvmExtractedValue::Log(EvmLog {
            removed: false,
            log_index: 0,
            transaction_index: 0,
            transaction_hash: Hash256([9; 32]),
            block_hash: Hash256([10; 32]),
            block_number: 100,
            address: Hash160(m.vault.clone().try_into().unwrap()),
            data: format!("0x{}", hex::encode(data)),
            topics,
        })),
        EvmExtractor::Log { log_index: 0 },
    )
}
pub fn callback_key(f: &mut Fixture, m: &ChainManifest) {
    let key = PublicKey::Secp256k1(Secp256k1PublicKey(
        m.controller_public_key.as_slice().try_into().unwrap(),
    ));
    testing_env!(
        context("kanso.near", NOW, 0).build(),
        near_sdk::test_vm_config(),
        near_parameters::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![PromiseResult::Successful(
            near_sdk::serde_json::to_vec(&key).unwrap()
        )]
    );
    assert!(f
        .contract
        .record_controller_key(m.chain_id.clone(), m.version));
}

pub fn delivery_proof(
    op: &kanso_coordinator::operation::RemoteOperation,
    remaining: u128,
    invalidated: bool,
) -> ReadProof {
    let c = &op.command;
    let mut data = env::sha256(b"sandbox_tests");
    data.extend(if invalidated {
        vec![0; 32]
    } else {
        c.settlement_id.clone()
    });
    data.extend(word(&if invalidated {
        vec![0; 20]
    } else {
        c.recipient.clone()
    }));
    data.extend(word(
        &if invalidated {
            0_u128
        } else {
            c.amount_atomic.0
        }
        .to_be_bytes(),
    ));
    data.extend(word(&remaining.to_be_bytes()));
    data.extend(word(&c.nonce.to_be_bytes()));
    data.extend(word(&[if invalidated { 2 } else { c.kind }]));
    let id = if invalidated {
        env::sha256(format!("invalidate:{}", op.operation_id).as_bytes())
    } else {
        c.operation_id.clone()
    };
    let topics = vec![Hash256(env::keccak256(b"CommandExecuted(bytes32,bytes32,bytes32,bytes32,bytes32,address,uint128,uint128,uint64,uint8)").try_into().unwrap()), Hash256(id.try_into().unwrap()), Hash256(c.lock_id.clone().try_into().unwrap()),Hash256(c.agreement.clone().try_into().unwrap())];
    proof(
        &op.manifest,
        ExtractedValue::EvmExtractedValue(EvmExtractedValue::Log(EvmLog {
            removed: false,
            log_index: 0,
            transaction_index: 0,
            transaction_hash: Hash256([9; 32]),
            block_hash: Hash256([10; 32]),
            block_number: 101,
            address: Hash160(op.manifest.vault.clone().try_into().unwrap()),
            data: format!("0x{}", hex::encode(data)),
            topics,
        })),
        EvmExtractor::Log { log_index: 0 },
    )
}
