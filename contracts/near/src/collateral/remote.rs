use crate::{
    events,
    manifest::{ChainFamily, ChainManifest},
    mpc::{self, ReadProof},
    state::{Custody, Loan, LoanState, SetupState},
    Coordinator, CoordinatorExt,
};
use near_mpc_contract_interface::types::{
    EvmExtractedValue, ExtractedValue as V, StarknetExtractedValue, SuiExtractedValue,
    SvmExtractedValue,
};
use near_sdk::{env, json_types::U128, near, serde_json::json};

pub struct LockReceipt {
    pub lock_id: Vec<u8>,
    pub agreement: Vec<u8>,
    pub borrower: Vec<u8>,
    pub deployment: Vec<u8>,
    pub leg_id: Vec<u8>,
    pub owner: Vec<u8>,
    pub refund: Vec<u8>,
    pub amount: u128,
    pub purpose: u8,
}
pub struct DeliveryReceipt {
    pub operation_id: Vec<u8>,
    pub lock_id: Vec<u8>,
    pub agreement: Vec<u8>,
    pub deployment: Vec<u8>,
    pub settlement_id: Vec<u8>,
    pub recipient: Vec<u8>,
    pub amount: u128,
    pub remaining: u128,
    pub nonce: u64,
    pub kind: u8,
}

#[near]
impl Coordinator {
    #[payable]
    pub fn submit_remote_lock(
        &mut self,
        loan_id: String,
        leg_id: String,
        proof: ReadProof,
    ) -> Loan {
        Self::one_yocto();
        let mut loan = self.loan(&loan_id);
        assert!(
            matches!(
                loan.state,
                LoanState::PendingFunding
                    | LoanState::Cancelled
                    | LoanState::Active
                    | LoanState::Repaid
                    | LoanState::WrittenOff
            ),
            "LOCK_NOT_EXPECTED"
        );
        assert_ne!(
            loan.setup_state,
            SetupState::Funding,
            "DISBURSEMENT_UNRESOLVED"
        );
        let lock = loan
            .locks
            .iter_mut()
            .find(|l| l.leg.leg_id == leg_id)
            .expect("LEG_NOT_FOUND");
        let Custody::Remote {
            chain_id,
            manifest_version,
            lock_id,
            source_owner,
            release_recipient,
            ..
        } = &lock.leg.custody
        else {
            panic!("REMOTE_LEG_REQUIRED")
        };
        let manifest = self.get_chain_manifest(chain_id.clone(), Some(*manifest_version));
        assert_ne!(
            manifest.family,
            ChainFamily::Bitcoin,
            "BITCOIN_OUTPUT_PROOF_REQUIRED"
        );
        mpc::verify_read(&manifest, &proof);
        let receipt = decode_lock(&manifest, &proof, lock.receipt_verified);
        assert!(
            receipt.lock_id == *lock_id
                && receipt.agreement == family_hash(&manifest, &lock.agreement)
                && receipt.borrower == mpc::commitment(&manifest.family, lock.leg.owner.as_bytes())
                && (manifest.family == ChainFamily::Solana
                    || receipt.deployment
                        == mpc::commitment(&manifest.family, self.config.deployment_id.as_bytes()))
                && receipt.leg_id == mpc::commitment(&manifest.family, leg_id.as_bytes())
                && receipt.owner == *source_owner
                && receipt.refund == *release_recipient
                && receipt.amount > 0
                && receipt.purpose
                    == if matches!(lock.purpose, crate::state::LockPurpose::Collateral) {
                        0
                    } else {
                        1
                    },
            "LOCK_COMMITMENT_MISMATCH"
        );
        let key = format!("{}:{}", chain_id, hex::encode(lock_id));
        if lock.receipt_verified {
            assert_eq!(
                self.remote_resources.get(&key),
                Some(format!("{loan_id}:{leg_id}")),
                "RESOURCE_IDENTITY_MISMATCH"
            );
            return loan;
        }
        assert!(
            self.remote_resources.get(&key).is_none(),
            "SOURCE_RESOURCE_REUSED"
        );
        let before = env::storage_usage();
        self.remote_resources
            .insert(&key, &format!("{loan_id}:{leg_id}"));
        lock.locked_atomic = U128(receipt.amount);
        lock.receipt_verified = true;
        lock.accepted = receipt.amount == lock.leg.amount_atomic.0;
        if matches!(loan.state, LoanState::PendingFunding | LoanState::Cancelled) {
            loan.setup_state = if loan.state == LoanState::Cancelled {
                SetupState::Aborting
            } else if loan.locks.iter().all(|l| l.accepted)
                && Self::now() < loan.offer.setup_deadline
            {
                SetupState::Ready
            } else {
                SetupState::Locking
            };
        }
        loan.revision += 1;
        self.loans.insert(&loan_id, &loan);
        self.charge_storage(&env::predecessor_account_id(), before);
        events::emit(
            &self.config.deployment_id,
            if loan
                .locks
                .iter()
                .any(|l| l.leg.leg_id == leg_id && l.accepted)
            {
                "CollateralLockAccepted"
            } else {
                "CollateralDepositMismatch"
            },
            &loan_id,
            loan.revision,
            json!({"loan_id":loan_id,"leg_id":leg_id,"amount_atomic":U128(receipt.amount)}),
        );
        loan
    }
}

pub fn family_hash(manifest: &ChainManifest, hash: &[u8]) -> Vec<u8> {
    let mut hash = hash.to_vec();
    if manifest.family == ChainFamily::Starknet {
        hash[0] &= 3;
    }
    hash
}
fn bytes(data: &str) -> Vec<u8> {
    hex::decode(data.strip_prefix("0x").unwrap_or(data)).expect("INVALID_LOG_DATA")
}
fn word(data: &[u8], index: usize) -> Vec<u8> {
    data.get(index * 32..(index + 1) * 32)
        .expect("INVALID_LOG_LENGTH")
        .to_vec()
}
fn integer(data: &[u8], index: usize) -> u128 {
    let w = word(data, index);
    assert!(w[..16].iter().all(|b| *b == 0), "INTEGER_OVERFLOW");
    u128::from_be_bytes(w[16..].try_into().unwrap())
}
fn evm_address(data: &[u8], index: usize) -> Vec<u8> {
    let w = word(data, index);
    assert!(w[..12].iter().all(|b| *b == 0), "INVALID_ABI_ADDRESS");
    w[12..].to_vec()
}
fn evm_event<'a>(
    m: &ChainManifest,
    proof: &'a ReadProof,
    signature: &str,
) -> (&'a near_mpc_contract_interface::types::EvmLog, Vec<u8>) {
    let near_mpc_contract_interface::types::ForeignTxSignPayload::V1(payload) = &proof.payload;
    let V::EvmExtractedValue(EvmExtractedValue::Log(log)) = &payload.values[0] else {
        panic!("EVM_LOG_REQUIRED")
    };
    assert!(
        log.address.0.as_slice() == m.vault
            && !log.removed
            && log.topics.len() == 4
            && log.topics[0].0.as_slice() == env::keccak256(signature.as_bytes()),
        "VAULT_EVENT_MISMATCH"
    );
    use near_mpc_contract_interface::types::{EvmExtractor, ForeignChainRpcRequest as R};
    let request = match &payload.request {
        R::Base(r)
        | R::Arbitrum(r)
        | R::Bnb(r)
        | R::Polygon(r)
        | R::Avalanche(r)
        | R::HyperEvm(r) => r,
        _ => panic!("EVM_REQUEST_REQUIRED"),
    };
    assert!(
        request.tx_id.0 == log.transaction_hash.0
            && request.extractors.as_slice()
                == [EvmExtractor::Log {
                    log_index: log.log_index
                }],
        "EXTRACTOR_MISMATCH"
    );
    (log, bytes(&log.data))
}

pub fn decode_lock(m: &ChainManifest, proof: &ReadProof, allow_spent: bool) -> LockReceipt {
    match m.family {
        ChainFamily::Evm => {
            let (log,data)=evm_event(m,proof,"LockAccepted(bytes32,bytes32,bytes32,bytes32,bytes32,address,address,address,uint128,uint8)");
            assert_eq!(data.len(), 224, "INVALID_LOG_LENGTH");
            assert_eq!(evm_address(&data, 4), vec![0; 20], "ASSET_MISMATCH");
            LockReceipt {
                lock_id: log.topics[1].0.to_vec(),
                agreement: log.topics[2].0.to_vec(),
                borrower: log.topics[3].0.to_vec(),
                deployment: word(&data, 0),
                leg_id: word(&data, 1),
                owner: evm_address(&data, 2),
                refund: evm_address(&data, 3),
                amount: integer(&data, 5),
                purpose: integer(&data, 6).try_into().expect("INVALID_PURPOSE"),
            }
        }
        ChainFamily::Solana => {
            let data = solana_account(m, proof, false);
            assert!(
                data.len() == 257 && &data[..8] == b"KANSOLOK" && data[8..40] == m.vault[32..],
                "INVALID_LOCK_ACCOUNT"
            );
            let amount = u64::from_le_bytes(data[233..241].try_into().unwrap());
            let remaining = u64::from_le_bytes(data[241..249].try_into().unwrap());
            let nonce = u64::from_le_bytes(data[249..257].try_into().unwrap());
            assert!(
                allow_spent || (amount == remaining && nonce == 0),
                "LOCK_ALREADY_SPENT"
            );
            assert_solana_pda(m, proof, b"lock", &data[40..72]);
            LockReceipt {
                lock_id: data[40..72].to_vec(),
                agreement: data[72..104].to_vec(),
                borrower: data[104..136].to_vec(),
                deployment: Vec::new(),
                leg_id: data[136..168].to_vec(),
                owner: data[168..200].to_vec(),
                refund: data[200..232].to_vec(),
                amount: u128::from(amount),
                purpose: data[232],
            }
        }
        ChainFamily::Sui => {
            let data = sui_event(m, proof, "LockAccepted");
            assert_eq!(data.len(), 297, "INVALID_EVENT_BCS");
            assert_eq!(&data[..32], &m.vault[32..], "WRONG_VAULT");
            LockReceipt {
                deployment: data[32..64].to_vec(),
                lock_id: data[96..128].to_vec(),
                agreement: data[128..160].to_vec(),
                borrower: data[160..192].to_vec(),
                leg_id: data[192..224].to_vec(),
                owner: data[224..256].to_vec(),
                refund: data[256..288].to_vec(),
                purpose: data[288],
                amount: u128::from(u64::from_le_bytes(data[289..297].try_into().unwrap())),
            }
        }
        ChainFamily::Starknet => {
            let log = starknet_event(m, proof, "LockAccepted");
            assert_eq!(log.keys.len(), 4, "INVALID_EVENT_KEYS");
            assert_eq!(log.data.len(), 7, "INVALID_EVENT_DATA");
            assert_eq!(log.data[4].0.as_slice(), m.asset_address, "ASSET_MISMATCH");
            LockReceipt {
                lock_id: log.keys[1].0.to_vec(),
                agreement: log.keys[2].0.to_vec(),
                borrower: log.keys[3].0.to_vec(),
                deployment: log.data[0].0.to_vec(),
                leg_id: log.data[1].0.to_vec(),
                owner: log.data[2].0.to_vec(),
                refund: log.data[3].0.to_vec(),
                amount: felt_integer(&log.data[5].0),
                purpose: felt_integer(&log.data[6].0)
                    .try_into()
                    .expect("INVALID_PURPOSE"),
            }
        }
        ChainFamily::Bitcoin => panic!("BITCOIN_OUTPUT_PROOF_REQUIRED"),
    }
}

pub fn decode_delivery(m: &ChainManifest, proof: &ReadProof) -> DeliveryReceipt {
    match m.family {
        ChainFamily::Evm => {
            let (log,data)=evm_event(m,proof,"CommandExecuted(bytes32,bytes32,bytes32,bytes32,bytes32,address,uint128,uint128,uint64,uint8)");
            assert_eq!(data.len(), 224, "INVALID_LOG_LENGTH");
            DeliveryReceipt {
                operation_id: log.topics[1].0.to_vec(),
                lock_id: log.topics[2].0.to_vec(),
                agreement: log.topics[3].0.to_vec(),
                deployment: word(&data, 0),
                settlement_id: word(&data, 1),
                recipient: evm_address(&data, 2),
                amount: integer(&data, 3),
                remaining: integer(&data, 4),
                nonce: integer(&data, 5).try_into().expect("NONCE_OVERFLOW"),
                kind: integer(&data, 6).try_into().expect("INVALID_KIND"),
            }
        }
        ChainFamily::Solana => {
            let data = solana_account(m, proof, true);
            assert!(
                data.len() == 225 && &data[..8] == b"KANSORCP" && data[8..40] == m.vault[32..],
                "INVALID_RECEIPT_ACCOUNT"
            );
            assert_solana_pda(m, proof, b"receipt", &data[40..72]);
            DeliveryReceipt {
                operation_id: data[40..72].to_vec(),
                lock_id: data[72..104].to_vec(),
                agreement: data[104..136].to_vec(),
                deployment: Vec::new(),
                settlement_id: data[136..168].to_vec(),
                recipient: data[168..200].to_vec(),
                amount: u128::from(u64::from_le_bytes(data[200..208].try_into().unwrap())),
                remaining: u128::from(u64::from_le_bytes(data[208..216].try_into().unwrap())),
                nonce: u64::from_le_bytes(data[216..224].try_into().unwrap()),
                kind: data[224],
            }
        }
        ChainFamily::Sui => {
            let data = sui_event(m, proof, "CommandExecuted");
            assert_eq!(data.len(), 281, "INVALID_EVENT_BCS");
            assert_eq!(&data[..32], &m.vault[32..], "WRONG_VAULT");
            DeliveryReceipt {
                deployment: data[32..64].to_vec(),
                operation_id: data[96..128].to_vec(),
                lock_id: data[128..160].to_vec(),
                agreement: data[160..192].to_vec(),
                settlement_id: data[192..224].to_vec(),
                recipient: data[224..256].to_vec(),
                amount: u128::from(u64::from_le_bytes(data[256..264].try_into().unwrap())),
                remaining: u128::from(u64::from_le_bytes(data[264..272].try_into().unwrap())),
                nonce: u64::from_le_bytes(data[272..280].try_into().unwrap()),
                kind: data[280],
            }
        }
        ChainFamily::Starknet => {
            let log = starknet_event(m, proof, "CommandExecuted");
            assert_eq!(log.keys.len(), 4, "INVALID_EVENT_KEYS");
            assert_eq!(log.data.len(), 7, "INVALID_EVENT_DATA");
            DeliveryReceipt {
                operation_id: log.keys[1].0.to_vec(),
                lock_id: log.keys[2].0.to_vec(),
                agreement: log.keys[3].0.to_vec(),
                deployment: log.data[0].0.to_vec(),
                settlement_id: log.data[1].0.to_vec(),
                recipient: log.data[2].0.to_vec(),
                amount: felt_integer(&log.data[3].0),
                remaining: felt_integer(&log.data[4].0),
                nonce: felt_integer(&log.data[5].0)
                    .try_into()
                    .expect("NONCE_OVERFLOW"),
                kind: felt_integer(&log.data[6].0)
                    .try_into()
                    .expect("INVALID_KIND"),
            }
        }
        ChainFamily::Bitcoin => panic!("BITCOIN_OUTPUT_PROOF_REQUIRED"),
    }
}
fn felt_integer(bytes: &[u8; 32]) -> u128 {
    assert!(bytes[..16].iter().all(|b| *b == 0), "INTEGER_OVERFLOW");
    u128::from_be_bytes(bytes[16..].try_into().unwrap())
}
fn solana_account<'a>(m: &ChainManifest, proof: &'a ReadProof, _receipt: bool) -> &'a [u8] {
    let near_mpc_contract_interface::types::ForeignTxSignPayload::V1(payload) = &proof.payload;
    let V::SvmExtractedValue(SvmExtractedValue::AccountState(account)) = &payload.values[0] else {
        panic!("ACCOUNT_STATE_REQUIRED")
    };
    assert_eq!(
        account.owner.0.as_slice(),
        &m.vault[..32],
        "PROGRAM_OWNER_MISMATCH"
    );
    &account.data
}
fn assert_solana_pda(m: &ChainManifest, proof: &ReadProof, seed: &[u8], id: &[u8]) {
    use near_mpc_contract_interface::types::{ForeignChainRpcRequest, SvmExtractor};
    let near_mpc_contract_interface::types::ForeignTxSignPayload::V1(payload) = &proof.payload;
    let ForeignChainRpcRequest::Solana(request) = &payload.request else {
        panic!("SOLANA_REQUEST_REQUIRED")
    };
    assert_eq!(request.extractors.len(), 1, "EXTRACTOR_MISMATCH");
    let SvmExtractor::AccountState { pubkey } = &request.extractors[0] else {
        panic!("ACCOUNT_STATE_REQUIRED")
    };
    assert_eq!(
        pubkey.0.as_slice(),
        mpc::pda(&m.vault[..32], &[seed, &m.vault[32..], id]),
        "PDA_MISMATCH"
    );
}
fn sui_event<'a>(m: &ChainManifest, proof: &'a ReadProof, name: &str) -> &'a [u8] {
    let near_mpc_contract_interface::types::ForeignTxSignPayload::V1(payload) = &proof.payload;
    let V::SuiExtractedValue(SuiExtractedValue::Event(event)) = &payload.values[0] else {
        panic!("SUI_EVENT_REQUIRED")
    };
    assert!(
        event.package_id.0.as_slice() == &m.vault[..32]
            && event.transaction_module == "collateral_vault"
            && event.type_tag
                == format!(
                    "0x{}::collateral_vault::{name}",
                    hex::encode(&m.vault[..32])
                ),
        "PACKAGE_EVENT_MISMATCH"
    );
    use near_mpc_contract_interface::types::{ForeignChainRpcRequest, SuiExtractor};
    let ForeignChainRpcRequest::Sui(request) = &payload.request else {
        panic!("SUI_REQUEST_REQUIRED")
    };
    assert!(
        request.extractors.len() == 1
            && matches!(request.extractors[0], SuiExtractor::Event { .. }),
        "EXTRACTOR_MISMATCH"
    );
    &event.bcs
}
fn starknet_event<'a>(
    m: &ChainManifest,
    proof: &'a ReadProof,
    name: &str,
) -> &'a near_mpc_contract_interface::types::StarknetLog {
    let near_mpc_contract_interface::types::ForeignTxSignPayload::V1(payload) = &proof.payload;
    let V::StarknetExtractedValue(StarknetExtractedValue::Log(log)) = &payload.values[0] else {
        panic!("STARKNET_EVENT_REQUIRED")
    };
    let mut selector = env::keccak256(name.as_bytes());
    selector[0] &= 3;
    assert!(
        log.from_address.0.as_slice() == m.vault
            && !log.keys.is_empty()
            && log.keys[0].0.as_slice() == selector,
        "VAULT_EVENT_MISMATCH"
    );
    use near_mpc_contract_interface::types::{ForeignChainRpcRequest, StarknetExtractor};
    let ForeignChainRpcRequest::Starknet(request) = &payload.request else {
        panic!("STARKNET_REQUEST_REQUIRED")
    };
    assert!(
        request.extractors.len() == 1
            && matches!(request.extractors[0], StarknetExtractor::Log { .. }),
        "EXTRACTOR_MISMATCH"
    );
    log
}
