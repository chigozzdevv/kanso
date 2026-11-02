use crate::{
    manifest::{ChainFamily, ChainManifest},
    operation::SourceCommand,
};
use near_sdk::{env, json_types::U128, near};

#[near(serializers=[borsh,json])]
#[derive(Clone)]
#[serde(tag = "family", rename_all = "snake_case", deny_unknown_fields)]
pub enum TransactionContext {
    Evm {
        nonce: u64,
        gas_limit: u64,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
    },
    Solana {
        recent_blockhash: Vec<u8>,
    },
    Sui {
        gas_object_id: Vec<u8>,
        gas_object_version: u64,
        gas_object_digest: Vec<u8>,
        gas_price: u64,
        gas_budget: u64,
        vault_initial_shared_version: u64,
        expiration_epoch: u64,
    },
    Starknet {
        nonce: u64,
        l1_gas: u64,
        l1_data_gas: u64,
        l2_gas: u64,
        l1_price: U128,
        l1_data_price: U128,
        l2_price: U128,
    },
}
pub struct ConstructedTransaction {
    pub transaction: Vec<u8>,
    pub payload: Vec<u8>,
    pub ed25519: bool,
    pub maximum_network_cost: u128,
    pub account_nonce: Option<u64>,
    pub resource: Option<String>,
}
fn word(bytes: &[u8]) -> Vec<u8> {
    assert!(bytes.len() <= 32, "WORD_OVERFLOW");
    let mut out = vec![0; 32 - bytes.len()];
    out.extend_from_slice(bytes);
    out
}
fn command_words(c: &SourceCommand) -> Vec<Vec<u8>> {
    vec![
        word(&c.operation_id),
        word(&c.lock_id),
        word(&c.agreement),
        word(&c.settlement_id),
        word(&c.recipient),
        word(&c.amount_atomic.0.to_be_bytes()),
        word(&c.nonce.to_be_bytes()),
        word(&c.deadline.to_be_bytes()),
        word(&[c.kind]),
    ]
}
pub fn construct(
    m: &ChainManifest,
    c: &SourceCommand,
    context: &TransactionContext,
) -> ConstructedTransaction {
    match (context, &m.family) {
        (
            TransactionContext::Evm {
                nonce,
                gas_limit,
                max_fee_per_gas,
                max_priority_fee_per_gas,
            },
            ChainFamily::Evm,
        ) => {
            assert!(
                *gas_limit > 0
                    && *gas_limit <= m.max_gas
                    && max_fee_per_gas.0 <= m.max_fee_per_gas.0
                    && max_priority_fee_per_gas.0 <= max_fee_per_gas.0,
                "GAS_BOUNDS_EXCEEDED"
            );
            let cost = u128::from(*gas_limit)
                .checked_mul(max_fee_per_gas.0)
                .expect("GAS_OVERFLOW");
            assert!(cost <= m.max_network_cost_atomic.0, "NETWORK_COST_LIMIT");
            let selector = env::keccak256(
                b"execute((bytes32,bytes32,bytes32,bytes32,address,uint128,uint64,uint64,uint8))",
            );
            let mut data = selector[..4].to_vec();
            for w in command_words(c) {
                data.extend_from_slice(&w);
            }
            let chain: u64 = m.network_fingerprint.parse().expect("INVALID_EVM_CHAIN");
            let mut rlp = rlp::RlpStream::new_list(9);
            rlp.append(&chain)
                .append(nonce)
                .append(&max_priority_fee_per_gas.0)
                .append(&max_fee_per_gas.0)
                .append(gas_limit)
                .append(&m.vault.as_slice())
                .append(&0_u8)
                .append(&data.as_slice())
                .begin_list(0);
            let mut tx = vec![2];
            tx.extend_from_slice(&rlp.out());
            let payload = env::keccak256(&tx);
            ConstructedTransaction {
                transaction: tx,
                payload,
                ed25519: false,
                maximum_network_cost: cost,
                account_nonce: Some(*nonce),
                resource: None,
            }
        }
        (TransactionContext::Solana { recent_blockhash }, ChainFamily::Solana) => {
            solana(m, c, recent_blockhash)
        }
        (
            TransactionContext::Sui {
                gas_object_id,
                gas_object_version,
                gas_object_digest,
                gas_price,
                gas_budget,
                vault_initial_shared_version,
                expiration_epoch,
            },
            ChainFamily::Sui,
        ) => {
            use sui_sdk_types::{
                Address, Argument, Command, Digest, GasPayment, Input, MoveCall, ObjectReference,
                ProgrammableTransaction, SharedInput, Transaction, TransactionExpiration,
                TransactionKind,
            };
            assert!(
                *gas_budget > 0
                    && u128::from(*gas_budget) <= m.max_network_cost_atomic.0
                    && *gas_price > 0
                    && u128::from(*gas_price) <= m.max_fee_per_gas.0
                    && *vault_initial_shared_version > 0,
                "GAS_BOUNDS_EXCEEDED"
            );
            let sender = Address::new(m.controller.as_slice().try_into().unwrap());
            let gas = Address::new(
                gas_object_id
                    .as_slice()
                    .try_into()
                    .expect("INVALID_GAS_OBJECT"),
            );
            assert!(
                gas_object_id.as_slice() != &m.vault[32..],
                "CUSTODY_IS_NOT_GAS"
            );
            let vault = Address::new(m.vault[32..].try_into().unwrap());
            let package = Address::new(m.vault[..32].try_into().unwrap());
            let mut inputs = vec![
                Input::Shared(SharedInput::new(vault, *vault_initial_shared_version, true)),
                Input::Shared(SharedInput::new(Address::from_static("0x6"), 1, false)),
            ];
            for value in [
                &c.operation_id,
                &c.lock_id,
                &c.agreement,
                &c.settlement_id,
                &c.recipient,
            ] {
                assert_eq!(value.len(), 32, "INVALID_SUI_ADDRESS");
                inputs.push(Input::Pure(value.clone()));
            }
            let amount: u64 = c.amount_atomic.0.try_into().expect("SUI_AMOUNT_OVERFLOW");
            for value in [amount, c.nonce, c.deadline] {
                inputs.push(Input::Pure(value.to_le_bytes().to_vec()));
            }
            inputs.push(Input::Pure(vec![c.kind]));
            let call = MoveCall {
                package,
                module: "collateral_vault".parse().unwrap(),
                function: "execute".parse().unwrap(),
                type_arguments: vec![],
                arguments: (0..11).map(Argument::Input).collect(),
            };
            let tx = Transaction {
                kind: TransactionKind::ProgrammableTransaction(ProgrammableTransaction {
                    inputs,
                    commands: vec![Command::MoveCall(call)],
                }),
                sender,
                gas_payment: GasPayment {
                    objects: vec![ObjectReference::new(
                        gas,
                        *gas_object_version,
                        Digest::new(
                            gas_object_digest
                                .as_slice()
                                .try_into()
                                .expect("INVALID_GAS_DIGEST"),
                        ),
                    )],
                    owner: sender,
                    price: *gas_price,
                    budget: *gas_budget,
                },
                expiration: TransactionExpiration::Epoch(*expiration_epoch),
            };
            let transaction = bcs::to_bytes(&tx).expect("INVALID_SUI_TRANSACTION");
            let mut intent = vec![0, 0, 0];
            intent.extend_from_slice(&transaction);
            use blake2::{
                digest::{Update, VariableOutput},
                Blake2bVar,
            };
            let mut hasher = Blake2bVar::new(32).unwrap();
            hasher.update(&intent);
            let mut payload = vec![0; 32];
            hasher.finalize_variable(&mut payload).unwrap();
            ConstructedTransaction {
                transaction,
                payload,
                ed25519: true,
                maximum_network_cost: u128::from(*gas_budget),
                account_nonce: None,
                resource: Some(format!(
                    "{}:{}",
                    hex::encode(gas_object_id),
                    gas_object_version
                )),
            }
        }
        (
            TransactionContext::Starknet {
                nonce,
                l1_gas,
                l1_data_gas,
                l2_gas,
                l1_price,
                l1_data_price,
                l2_price,
            },
            ChainFamily::Starknet,
        ) => {
            use starknet_crypto::{poseidon_hash_many, Felt};
            let mut total = 0_u128;
            for (gas, price) in [
                (*l1_gas, l1_price.0),
                (*l1_data_gas, l1_data_price.0),
                (*l2_gas, l2_price.0),
            ] {
                assert!(
                    gas <= m.max_gas && price <= m.max_fee_per_gas.0,
                    "GAS_BOUNDS_EXCEEDED"
                );
                total = total
                    .checked_add(u128::from(gas).checked_mul(price).expect("GAS_OVERFLOW"))
                    .expect("GAS_OVERFLOW");
            }
            assert!(
                total > 0 && total <= m.max_network_cost_atomic.0,
                "NETWORK_COST_LIMIT"
            );
            let mut selector = env::keccak256(b"execute");
            selector[0] &= 3;
            let mut calldata = vec![
                Felt::ONE,
                Felt::from_bytes_be_slice(&m.vault),
                Felt::from_bytes_be_slice(&selector),
                Felt::from(9_u8),
            ];
            calldata.extend(
                command_words(c)
                    .iter()
                    .map(|w| Felt::from_bytes_be_slice(w)),
            );
            let resource = |name: &[u8], gas: u64, price: u128| {
                let mut bytes = vec![0; 8 - name.len()];
                bytes.extend_from_slice(name);
                bytes.extend_from_slice(&gas.to_be_bytes());
                bytes.extend_from_slice(&price.to_be_bytes());
                Felt::from_bytes_be_slice(&bytes)
            };
            let bounds = poseidon_hash_many(&[
                Felt::ZERO,
                resource(b"L1_GAS", *l1_gas, l1_price.0),
                resource(b"L2_GAS", *l2_gas, l2_price.0),
                resource(b"L1_DATA", *l1_data_gas, l1_data_price.0),
            ]);
            let empty = poseidon_hash_many(&[]);
            let hash = poseidon_hash_many(&[
                Felt::from_bytes_be_slice(b"invoke"),
                Felt::from(3_u8),
                Felt::from_bytes_be_slice(&m.controller),
                bounds,
                empty,
                Felt::from_bytes_be_slice(m.network_fingerprint.as_bytes()),
                Felt::from(*nonce),
                Felt::ZERO,
                empty,
                poseidon_hash_many(&calldata),
            ]);
            let transaction=near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"type":"INVOKE","version":"0x3","sender_address":format!("0x{}",hex::encode(&m.controller)),"calldata":calldata.iter().map(|v|format!("{v:#x}")).collect::<Vec<_>>(),"nonce":format!("{nonce:#x}"),"resource_bounds":{"l1_gas":{"max_amount":format!("{l1_gas:#x}"),"max_price_per_unit":format!("{:#x}",l1_price.0)},"l1_data_gas":{"max_amount":format!("{l1_data_gas:#x}"),"max_price_per_unit":format!("{:#x}",l1_data_price.0)},"l2_gas":{"max_amount":format!("{l2_gas:#x}"),"max_price_per_unit":format!("{:#x}",l2_price.0)}},"tip":"0x0","paymaster_data":[],"account_deployment_data":[],"nonce_data_availability_mode":"L1","fee_data_availability_mode":"L1"})).unwrap();
            ConstructedTransaction {
                transaction,
                payload: hash.to_bytes_be().to_vec(),
                ed25519: false,
                maximum_network_cost: total,
                account_nonce: Some(*nonce),
                resource: None,
            }
        }
        _ => panic!("TRANSACTION_FAMILY_MISMATCH"),
    }
}
fn shortvec(out: &mut Vec<u8>, mut value: usize) {
    loop {
        let mut byte = (value & 127) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 128;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
}
fn solana(m: &ChainManifest, c: &SourceCommand, blockhash: &[u8]) -> ConstructedTransaction {
    assert!(
        blockhash.len() == 32 && blockhash.iter().any(|b| *b != 0),
        "INVALID_BLOCKHASH"
    );
    let controller = m.controller.clone();
    let program = m.vault[..32].to_vec();
    let config = m.vault[32..].to_vec();
    let lock = crate::mpc::pda(&program, &[b"lock", &config, &c.lock_id]);
    let receipt = crate::mpc::pda(&program, &[b"receipt", &config, &c.operation_id]);
    let mut metas = vec![
        (controller.clone(), true, true),
        (config.clone(), false, false),
        (lock.clone(), false, true),
        (receipt.clone(), false, true),
        (c.recipient.clone(), false, true),
        (vec![0; 32], false, false),
        (program.clone(), false, false),
    ];
    let mut keys: Vec<(Vec<u8>, bool, bool)> = Vec::new();
    for (key, signer, writable) in metas.drain(..) {
        if let Some(existing) = keys.iter_mut().find(|k| k.0 == key) {
            existing.1 |= signer;
            existing.2 |= writable;
        } else {
            keys.push((key, signer, writable));
        }
    }
    keys.sort_by_key(|(_, signer, writable)| (!*signer, !*writable));
    assert!(keys.len() <= 32, "ACCOUNT_LIMIT");
    let index = |key: &Vec<u8>| keys.iter().position(|k| &k.0 == key).unwrap() as u8;
    let rent_cap: u64 = (m.max_network_cost_atomic.0 / 2)
        .checked_sub(5000)
        .expect("NETWORK_COST_LIMIT")
        .try_into()
        .expect("GAS_OVERFLOW");
    let mut data = vec![2];
    for field in [
        &c.operation_id,
        &c.lock_id,
        &c.agreement,
        &c.settlement_id,
        &c.recipient,
    ] {
        assert_eq!(field.len(), 32, "INVALID_SOLANA_KEY");
        data.extend_from_slice(field);
    }
    let amount: u64 = c.amount_atomic.0.try_into().expect("SOL_AMOUNT_OVERFLOW");
    for value in [amount, c.nonce, c.deadline] {
        data.extend_from_slice(&value.to_le_bytes());
    }
    data.push(c.kind);
    data.extend_from_slice(&rent_cap.to_le_bytes());
    let readonly = keys
        .iter()
        .filter(|(_, signer, writable)| !*signer && !*writable)
        .count() as u8;
    let mut message = vec![1, 0, readonly];
    shortvec(&mut message, keys.len());
    for (key, _, _) in &keys {
        message.extend_from_slice(key);
    }
    message.extend_from_slice(blockhash);
    shortvec(&mut message, 1);
    message.push(index(&program));
    let accounts = [
        index(&config),
        index(&lock),
        index(&receipt),
        index(&controller),
        index(&controller),
        index(&c.recipient),
        index(&vec![0; 32]),
    ];
    shortvec(&mut message, accounts.len());
    message.extend_from_slice(&accounts);
    shortvec(&mut message, data.len());
    message.extend_from_slice(&data);
    assert!(message.len() + 65 <= 1232, "SOLANA_MESSAGE_TOO_LARGE");
    ConstructedTransaction {
        transaction: message.clone(),
        payload: message,
        ed25519: true,
        maximum_network_cost: m.max_network_cost_atomic.0 / 2,
        account_nonce: None,
        resource: None,
    }
}
