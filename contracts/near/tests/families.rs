mod common;
#[path = "common/remote.rs"]
mod remote;
use common::*;
use ed25519_dalek::{Signer, SigningKey};
use kanso_coordinator::{
    manifest::{ChainFamily, ChainManifest},
    mpc::{self, ReadProof},
    operation::{RemoteOperation, RemoteState},
    state::{AssetCap, BasketLeg, Custody, Price, SetupState},
    transaction::TransactionContext,
};
use near_mpc_contract_interface::types::*;
use near_sdk::{env, json_types::U128, testing_env, PromiseResult};
use remote::{key, public_key, signature};
fn address(n: u8) -> Vec<u8> {
    let mut v = vec![0; 32];
    v[31] = n;
    v
}
fn configure(f: &mut Fixture, family: ChainFamily) -> (ChainManifest, BasketLeg) {
    let chain = match family {
        ChainFamily::Solana => "solana",
        ChainFamily::Sui => "sui",
        _ => "starknet",
    };
    let mut m = remote::manifest(chain);
    m.family = family.clone();
    m.network_fingerprint = if family == ChainFamily::Starknet {
        "SN_SEPOLIA"
    } else {
        "sandbox-network"
    }
    .into();
    m.max_network_cost_atomic = U128(20_000_000);
    m.max_fee_per_gas = U128(10_000);
    let ed = SigningKey::from_bytes(&[3; 32]);
    let pubkey = ed.verifying_key().to_bytes();
    m.controller_public_key = if family == ChainFamily::Starknet {
        public_key(&key(3))
    } else {
        pubkey.to_vec()
    };
    m.controller = match family {
        ChainFamily::Solana => pubkey.to_vec(),
        ChainFamily::Sui => sui_sdk_types::Ed25519PublicKey::new(pubkey)
            .derive_address()
            .as_bytes()
            .to_vec(),
        _ => address(99),
    };
    m.decimals = if family == ChainFamily::Starknet {
        18
    } else {
        9
    };
    m.vault = match family {
        ChainFamily::Solana => {
            let program = vec![7; 32];
            let config = mpc::pda(
                &program,
                &[b"config", &env::sha256(b"sandbox_tests"), &m.controller],
            );
            [program, config].concat()
        }
        ChainFamily::Sui => [vec![7; 32], vec![8; 32]].concat(),
        _ => address(77),
    };
    if family == ChainFamily::Starknet {
        m.asset_address = address(88);
    }
    call_as("owner.near", NOW, 1);
    f.contract.register_chain_manifest(m.clone());
    let response = if family == ChainFamily::Starknet {
        PublicKey::Secp256k1(Secp256k1PublicKey(
            m.controller_public_key.as_slice().try_into().unwrap(),
        ))
    } else {
        PublicKey::Ed25519(Ed25519PublicKey(pubkey))
    };
    testing_env!(
        context("kanso.near", NOW, 0).build(),
        near_sdk::test_vm_config(),
        near_parameters::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![PromiseResult::Successful(
            near_sdk::serde_json::to_vec(&response).unwrap()
        )]
    );
    f.contract.record_controller_key(chain.into(), 1);
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
    let mut p = f.contract.get_pool("pool".into()).policy;
    p.version += 1;
    p.eligible_assets.push(chain.into());
    p.asset_caps.push(AssetCap {
        asset_id: chain.into(),
        max_collateral_value_atomic: U128(1_000_000_000_000),
    });
    call_as("lp.near", NOW, 1);
    f.contract.update_pool_policy("pool".into(), p);
    let amount = 10_u128.pow(u32::from(m.decimals));
    let leg = BasketLeg {
        asset_id: chain.into(),
        custody: Custody::Remote {
            chain_id: chain.into(),
            manifest_version: 1,
            lock_id: address(11),
            source_owner: address(12),
            release_recipient: address(12),
            min_price_atomic: U128(1_000_000_000),
            max_price_atomic: U128(3_000_000_000),
        },
        leg_id: chain.into(),
        owner: account("borrower.near"),
        amount_atomic: U128(amount),
        release_recipient: account("borrower.near"),
    };
    (m, leg)
}
fn attest(request: ForeignChainRpcRequest, value: ExtractedValue) -> ReadProof {
    let payload = ForeignTxSignPayload::V1(ForeignTxSignPayloadV1 {
        request,
        values: vec![value],
    });
    let signature = signature(&key(2), &payload.compute_msg_hash().unwrap().0);
    ReadProof { payload, signature }
}
fn state_proof(m: &ChainManifest, data: Vec<u8>, seed: &[u8], id: &[u8]) -> ReadProof {
    let key = mpc::pda(&m.vault[..32], &[seed, &m.vault[32..], id]);
    attest(
        ForeignChainRpcRequest::Solana(SvmRpcRequest {
            tx_id: SvmTxId([9; 64]),
            finality: SvmFinality::Finalized,
            extractors: vec![SvmExtractor::AccountState {
                pubkey: SvmAddress(key.try_into().unwrap()),
            }]
            .try_into()
            .unwrap(),
        }),
        ExtractedValue::SvmExtractedValue(SvmExtractedValue::AccountState(SvmAccount {
            owner: SvmAddress(m.vault[..32].try_into().unwrap()),
            data,
        })),
    )
}
fn event_proof(m: &ChainManifest, data: Vec<u8>, name: &str) -> ReadProof {
    attest(
        ForeignChainRpcRequest::Sui(SuiRpcRequest {
            tx_id: SuiTxId([9; 32]),
            finality: SuiFinality::Checkpointed,
            extractors: vec![SuiExtractor::Event { event_index: 0 }]
                .try_into()
                .unwrap(),
        }),
        ExtractedValue::SuiExtractedValue(SuiExtractedValue::Event(SuiEvent {
            package_id: SuiAddress(m.vault[..32].try_into().unwrap()),
            transaction_module: "collateral_vault".into(),
            sender: SuiAddress(address(12).try_into().unwrap()),
            type_tag: format!(
                "0x{}::collateral_vault::{name}",
                hex::encode(&m.vault[..32])
            ),
            bcs: data,
        })),
    )
}
fn stark_proof(
    m: &ChainManifest,
    mut keys: Vec<Vec<u8>>,
    data: Vec<Vec<u8>>,
    name: &str,
) -> ReadProof {
    let mut selector = env::keccak256(name.as_bytes());
    selector[0] &= 3;
    keys.insert(0, selector);
    attest(
        ForeignChainRpcRequest::Starknet(StarknetRpcRequest {
            tx_id: StarknetTxId(StarknetFelt([9; 32])),
            finality: StarknetFinality::AcceptedOnL1,
            extractors: vec![StarknetExtractor::Log { log_index: 0 }]
                .try_into()
                .unwrap(),
        }),
        ExtractedValue::StarknetExtractedValue(StarknetExtractedValue::Log(StarknetLog {
            block_hash: StarknetFelt([10; 32]),
            block_number: 100,
            from_address: StarknetFelt(m.vault.as_slice().try_into().unwrap()),
            keys: keys
                .into_iter()
                .map(|k| StarknetFelt(k.try_into().unwrap()))
                .collect(),
            data: data
                .into_iter()
                .map(|d| StarknetFelt(d.try_into().unwrap()))
                .collect(),
        })),
    )
}
fn lock_proof(f: &Fixture, m: &ChainManifest, leg: &BasketLeg) -> ReadProof {
    let loan = f.contract.get_loan("loan".into());
    let mut agreement = loan.offer_hash;
    if m.family == ChainFamily::Starknet {
        agreement[0] &= 3;
    }
    let dep = mpc::commitment(&m.family, b"sandbox_tests");
    let borrower = mpc::commitment(&m.family, b"borrower.near");
    let leg_id = mpc::commitment(&m.family, m.chain_id.as_bytes());
    match m.family {
        ChainFamily::Solana => {
            let mut d = b"KANSOLOK".to_vec();
            for field in [
                &m.vault[32..],
                &address(11),
                &agreement,
                &borrower,
                &leg_id,
                &address(12),
                &address(12),
            ] {
                d.extend_from_slice(field);
            }
            d.push(0);
            for n in [leg.amount_atomic.0 as u64, leg.amount_atomic.0 as u64, 0] {
                d.extend_from_slice(&n.to_le_bytes());
            }
            state_proof(m, d, b"lock", &address(11))
        }
        ChainFamily::Sui => {
            let mut d = vec![];
            for field in [
                &m.vault[32..],
                &dep,
                &env::sha256(m.network_fingerprint.as_bytes()),
                &address(11),
                &agreement,
                &borrower,
                &leg_id,
                &address(12),
                &address(12),
            ] {
                d.extend_from_slice(field);
            }
            d.push(0);
            d.extend_from_slice(&(leg.amount_atomic.0 as u64).to_le_bytes());
            event_proof(m, d, "LockAccepted")
        }
        _ => stark_proof(
            m,
            vec![address(11), agreement, borrower],
            vec![
                dep,
                leg_id,
                address(12),
                address(12),
                m.asset_address.clone(),
                remote::word(&leg.amount_atomic.0.to_be_bytes()),
                address(0),
            ],
            "LockAccepted",
        ),
    }
}
fn delivery_proof(op: &RemoteOperation, remaining: u128) -> ReadProof {
    let m = &op.manifest;
    let c = &op.command;
    match m.family {
        ChainFamily::Solana => {
            let mut d = b"KANSORCP".to_vec();
            for field in [
                &m.vault[32..],
                &c.operation_id,
                &c.lock_id,
                &c.agreement,
                &c.settlement_id,
                &c.recipient,
            ] {
                d.extend_from_slice(field);
            }
            for n in [c.amount_atomic.0 as u64, remaining as u64, c.nonce] {
                d.extend_from_slice(&n.to_le_bytes());
            }
            d.push(c.kind);
            state_proof(m, d, b"receipt", &c.operation_id)
        }
        ChainFamily::Sui => {
            let mut d = vec![];
            for field in [
                &m.vault[32..],
                &mpc::commitment(&m.family, b"sandbox_tests"),
                &env::sha256(m.network_fingerprint.as_bytes()),
                &c.operation_id,
                &c.lock_id,
                &c.agreement,
                &c.settlement_id,
                &c.recipient,
            ] {
                d.extend_from_slice(field);
            }
            for n in [c.amount_atomic.0 as u64, remaining as u64, c.nonce] {
                d.extend_from_slice(&n.to_le_bytes());
            }
            d.push(c.kind);
            event_proof(m, d, "CommandExecuted")
        }
        _ => stark_proof(
            m,
            vec![
                c.operation_id.clone(),
                c.lock_id.clone(),
                c.agreement.clone(),
            ],
            vec![
                mpc::commitment(&m.family, b"sandbox_tests"),
                c.settlement_id.clone(),
                c.recipient.clone(),
                remote::word(&c.amount_atomic.0.to_be_bytes()),
                remote::word(&remaining.to_be_bytes()),
                remote::word(&c.nonce.to_be_bytes()),
                address(c.kind),
            ],
            "CommandExecuted",
        ),
    }
}
#[test]
fn three_chain_setup_and_real_signatures_complete_solana_sui_and_starknet_releases() {
    let mut f = Fixture::new();
    let configurations = vec![
        configure(&mut f, ChainFamily::Solana),
        configure(&mut f, ChainFamily::Sui),
        configure(&mut f, ChainFamily::Starknet),
    ];
    let mut offer = f.offer("loan");
    offer.policy_version = 4;
    offer.legs = configurations.iter().map(|(_, l)| l.clone()).collect();
    call_as("borrower.near", NOW, 1);
    f.contract.accept_offer(offer);
    for (index, (m, leg)) in configurations.iter().enumerate() {
        let proof = lock_proof(&f, m, leg);
        call_as("borrower.near", NOW, 1);
        let loan = f
            .contract
            .submit_remote_lock("loan".into(), m.chain_id.clone(), proof);
        assert_eq!(
            loan.setup_state,
            if index == 2 {
                SetupState::Ready
            } else {
                SetupState::Locking
            }
        );
    }
    call_as("borrower.near", NOW, 1);
    f.contract.fund_loan("loan".into(), "fund".into());
    callback_result(&mut f.contract, "fund", NOW, true);
    f.contract.finalize_transfer("fund".into());
    for (m, leg) in configurations {
        let id = format!("release_{}", m.chain_id);
        let amount = leg.amount_atomic.0 / 10;
        let revision = f.contract.get_loan("loan".into()).revision.to_string();
        call_as("borrower.near", NOW, 1);
        f.contract.prepare_remote_release(
            id.clone(),
            "loan".into(),
            m.chain_id.clone(),
            U128(amount),
            revision,
            NOW + 300,
        );
        let ctx = match m.family {
            ChainFamily::Solana => TransactionContext::Solana {
                recent_blockhash: vec![8; 32],
            },
            ChainFamily::Sui => TransactionContext::Sui {
                gas_object_id: vec![5; 32],
                gas_object_version: 7,
                gas_object_digest: vec![6; 32],
                gas_price: 1000,
                gas_budget: 10_000_000,
                vault_initial_shared_version: 1,
                expiration_epoch: 100,
            },
            _ => TransactionContext::Starknet {
                nonce: 0,
                l1_gas: 1000,
                l1_data_gas: 1000,
                l2_gas: 100_000,
                l1_price: U128(1),
                l1_data_price: U128(1),
                l2_price: U128(1),
            },
        };
        f.contract
            .request_remote_signature(id.clone(), "attempt".into(), ctx, false)
            .detach();
        let op = f.contract.get_remote_operation(id.clone()).unwrap();
        let payload = &op.signing_attempts[0].payload;
        let signed = if m.family == ChainFamily::Starknet {
            SignatureResponse::Secp256k1(signature(&key(3), payload))
        } else {
            SignatureResponse::Ed25519 {
                signature: SigningKey::from_bytes(&[3; 32])
                    .sign(payload)
                    .to_bytes()
                    .into(),
            }
        };
        f.contract
            .submit_remote_signature(id.clone(), "attempt".into(), signed);
        let broadcast = f
            .contract
            .remote_broadcast_transaction(id.clone(), "attempt".into());
        match m.family {
            ChainFamily::Solana => {
                assert_eq!(
                    broadcast.transaction.len(),
                    op.signing_attempts[0].transaction.len() + 65
                );
                if let Ok(path) = std::env::var("KANSO_SOLANA_VECTOR") {
                    std::fs::write(path,serde_json::to_string_pretty(&serde_json::json!({"program":m.vault[..32],"config":m.vault[32..],"controller":m.controller,"deployment":env::sha256(b"sandbox_tests"),"lock_id":op.command.lock_id,"agreement":op.command.agreement,"borrower":env::sha256(b"borrower.near"),"leg_id":env::sha256(b"solana"),"owner":address(12),"recipient":op.command.recipient,"amount":leg.amount_atomic.0.to_string(),"released":amount.to_string(),"signed_transaction":broadcast.transaction})).unwrap()+"\n").unwrap();
                }
            }
            ChainFamily::Sui => {
                assert_eq!(broadcast.signature.len(), 97);
                let tx: sui_sdk_types::Transaction =
                    bcs::from_bytes(&broadcast.transaction).unwrap();
                let sui_sdk_types::TransactionKind::ProgrammableTransaction(ptb) = tx.kind else {
                    panic!("PTB_REQUIRED")
                };
                assert_eq!(ptb.commands.len(), 1);
            }
            _ => {
                let tx: serde_json::Value = serde_json::from_slice(&broadcast.transaction).unwrap();
                assert_eq!(tx["signature"].as_array().unwrap().len(), 4);
            }
        }
        let proof = delivery_proof(&op, leg.amount_atomic.0 - amount);
        call_as("borrower.near", NOW, 1);
        assert_eq!(
            f.contract
                .submit_remote_delivery(id.clone(), proof.clone())
                .state,
            RemoteState::Delivered
        );
        assert_eq!(
            f.contract.submit_remote_delivery(id, proof).state,
            RemoteState::Delivered
        );
    }
}
