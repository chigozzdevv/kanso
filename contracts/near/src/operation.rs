use crate::collateral::remote::{decode_delivery, family_hash};
use crate::{
    config::valid_id,
    events,
    manifest::{ChainFamily, ChainManifest},
    mpc::{self, ReadProof},
    state::{Custody, LoanState},
    Coordinator, CoordinatorExt,
};
use near_mpc_contract_interface::types::{
    DomainId, Payload, PublicKey, SignRequestArgs, SignatureResponse,
};
use near_sdk::{
    env,
    json_types::U128,
    near,
    serde_json::{self, json},
    AccountId, Gas, NearToken, Promise,
};

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum RemoteState {
    Prepared,
    Signing,
    Signed,
    Delivered,
    Invalidated,
    Cancelled,
}
#[near(serializers = [borsh,json])]
#[derive(Clone)]
pub struct SourceCommand {
    pub operation_id: Vec<u8>,
    pub lock_id: Vec<u8>,
    pub agreement: Vec<u8>,
    pub settlement_id: Vec<u8>,
    pub recipient: Vec<u8>,
    pub amount_atomic: U128,
    pub nonce: u64,
    pub deadline: u64,
    pub kind: u8,
}
#[near(serializers = [borsh,json])]
#[derive(Clone)]
pub struct RemoteOperation {
    pub operation_id: String,
    pub settlement_id: Option<String>,
    pub loan_id: String,
    pub leg_id: String,
    pub owner: AccountId,
    pub manifest: ChainManifest,
    pub command: SourceCommand,
    pub state: RemoteState,
    pub signing_attempts: Vec<SigningAttempt>,
    pub network_cost_reserved_atomic: U128,
    pub revision: u64,
}
#[near(serializers = [borsh,json])]
#[derive(Clone)]
pub struct SigningAttempt {
    pub attempt_id: String,
    pub transaction: Vec<u8>,
    pub payload: Vec<u8>,
    pub ed25519: bool,
    pub signature: Option<SignatureResponse>,
    pub invalidation: bool,
    pub account_nonce: Option<u64>,
    pub source_deadline: u64,
}

#[near]
impl Coordinator {
    #[payable]
    pub fn verify_controller_key(&mut self, chain_id: String, version: u32) -> Promise {
        Self::one_yocto();
        let manifest = self.get_chain_manifest(chain_id.clone(), Some(version));
        Promise::new(manifest.mpc_account).function_call("derived_public_key",serde_json::to_vec(&json!({"path":manifest.derivation_path,"predecessor":env::current_account_id(),"domain_id":manifest.sign_domain})).unwrap(),NearToken::from_yoctonear(0),Gas::from_tgas(15)).then(Promise::new(env::current_account_id()).function_call("record_controller_key",serde_json::to_vec(&json!({"chain_id":chain_id,"version":version})).unwrap(),NearToken::from_yoctonear(0),Gas::from_tgas(15)))
    }
    #[private]
    pub fn record_controller_key(&mut self, chain_id: String, version: u32) -> bool {
        assert_eq!(env::promise_results_count(), 1, "INVALID_CALLBACK");
        let manifest = self.get_chain_manifest(chain_id.clone(), Some(version));
        let Ok(bytes) = env::promise_result_checked(0, 1024) else {
            return false;
        };
        let key: PublicKey = serde_json::from_slice(&bytes).expect("INVALID_MPC_KEY");
        let near_key: near_sdk::PublicKey = key.try_into().expect("UNSUPPORTED_MPC_KEY");
        let bytes = &near_key.as_bytes()[1..];
        let expected = if manifest.family == ChainFamily::Bitcoin {
            bitcoin::PublicKey::from_slice(&[&[4_u8][..], bytes].concat())
                .expect("INVALID_BTC_KEY")
                .inner
                .serialize()
                .to_vec()
        } else {
            bytes.to_vec()
        };
        assert_eq!(
            expected, manifest.controller_public_key,
            "DERIVED_KEY_MISMATCH"
        );
        self.verified_controllers
            .insert(&(chain_id, version), &true);
        true
    }
    #[payable]
    pub fn prepare_remote_release(
        &mut self,
        operation_id: String,
        loan_id: String,
        leg_id: String,
        amount_atomic: U128,
        expected_revision: String,
        deadline: u64,
    ) -> RemoteOperation {
        Self::one_yocto();
        valid_id(&operation_id);
        let mut loan = self.loan(&loan_id);
        let owner = env::predecessor_account_id();

        if let Some(existing) = self.remote_operations.get(&operation_id) {
            assert!(
                existing.loan_id == loan_id
                    && existing.leg_id == leg_id
                    && existing.command.amount_atomic == amount_atomic
                    && existing.command.deadline == deadline,
                "IDEMPOTENCY_CONFLICT"
            );
            return existing;
        }
        assert_eq!(
            loan.revision.to_string(),
            expected_revision,
            "BASKET_REVISION_CHANGED"
        );
        assert!(loan.active_outflow.is_none(), "OUTFLOW_UNRESOLVED");
        assert!(
            deadline > Self::now() && deadline <= Self::now() + 86_400,
            "INVALID_COMMAND_DEADLINE"
        );
        loan.accrue(Self::now());
        let active = loan.state == LoanState::Active;
        assert!(
            active
                || matches!(
                    loan.state,
                    LoanState::Repaid | LoanState::Cancelled | LoanState::WrittenOff
                ),
            "RELEASE_NOT_ALLOWED"
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
            release_recipient,
            ..
        } = &lock.leg.custody
        else {
            panic!("REMOTE_LEG_REQUIRED")
        };
        let manifest = self.get_chain_manifest(chain_id.clone(), Some(*manifest_version));
        let collateral =
            lock.accepted && matches!(lock.purpose, crate::state::LockPurpose::Collateral);
        if active && collateral {
            assert!(Self::now() < loan.matures_at, "LOAN_DUE");
        }
        let expected_owner = match &lock.purpose {
            crate::state::LockPurpose::Collateral => loan.offer.borrower.clone(),
            crate::state::LockPurpose::Payment { payer, .. } => payer.clone(),
        };
        assert_eq!(owner, expected_owner, "CUSTODY_OWNER_REQUIRED");
        assert!(
            manifest.family != ChainFamily::Bitcoin,
            "BITCOIN_SPEND_REQUIRED"
        );
        assert!(
            lock.receipt_verified
                && amount_atomic.0 > 0
                && lock.locked_atomic.0 - lock.reserved_atomic.0 >= amount_atomic.0,
            "COLLATERAL_UNAVAILABLE"
        );
        lock.reserved_atomic.0 += amount_atomic.0;
        let command = SourceCommand {
            operation_id: mpc::commitment(&manifest.family, operation_id.as_bytes()),
            lock_id: lock_id.clone(),
            agreement: family_hash(&manifest, &lock.agreement),
            settlement_id: vec![0; 32],
            recipient: release_recipient.clone(),
            amount_atomic,
            nonce: lock.remote_nonce,
            deadline,
            kind: 0,
        };
        if active && collateral {
            self.assert_safe_withdrawal(&loan);
        }
        let before = env::storage_usage();
        let operation = RemoteOperation {
            operation_id: operation_id.clone(),
            settlement_id: None,
            loan_id: loan_id.clone(),
            leg_id,
            owner: owner.clone(),
            manifest,
            command,
            state: RemoteState::Prepared,
            signing_attempts: Vec::new(),
            network_cost_reserved_atomic: U128(0),
            revision: 1,
        };
        loan.active_outflow = Some(operation_id.clone());
        loan.revision += 1;
        self.loans.insert(&loan_id, &loan);
        self.remote_operations.insert(&operation_id, &operation);
        self.charge_storage(&owner, before);
        events::emit(
            &self.config.deployment_id,
            "RemoteActionPrepared",
            &operation_id,
            1,
            json!({"operation_id":operation_id,"loan_id":loan_id,"amount_atomic":amount_atomic}),
        );
        operation
    }
    #[payable]
    pub fn cancel_unsigned_remote_operation(&mut self, operation_id: String) -> RemoteOperation {
        Self::one_yocto();
        let mut operation = self.remote_operation(&operation_id);
        assert_eq!(
            env::predecessor_account_id(),
            operation.owner,
            "OWNER_REQUIRED"
        );
        if operation.state == RemoteState::Cancelled {
            return operation;
        }
        assert_eq!(
            operation.state,
            RemoteState::Prepared,
            "SIGNATURE_UNRESOLVED"
        );
        self.resolve_remote_reservation(&operation, false);
        operation.state = RemoteState::Cancelled;
        operation.revision += 1;
        self.remote_operations.insert(&operation_id, &operation);
        operation
    }
    #[payable]
    pub fn request_remote_signature(
        &mut self,
        operation_id: String,
        attempt_id: String,
        context: crate::transaction::TransactionContext,
        invalidation: bool,
    ) -> Promise {
        valid_id(&attempt_id);
        let mut operation = self.remote_operation(&operation_id);
        let recovery = invalidation && Self::now() >= operation.command.deadline;
        assert!(
            env::predecessor_account_id() == operation.owner || recovery,
            "EXECUTION_OWNER_REQUIRED"
        );
        assert!(
            matches!(
                operation.state,
                RemoteState::Prepared | RemoteState::Signing | RemoteState::Signed
            ),
            "OPERATION_TERMINAL"
        );
        let current = self.get_chain_manifest(operation.manifest.chain_id.clone(), None);
        assert!(
            current.signing_enabled && operation.manifest.signing_enabled,
            "SIGNING_PAUSED"
        );
        assert_eq!(
            self.verified_controllers.get(&(
                operation.manifest.chain_id.clone(),
                operation.manifest.version
            )),
            Some(true),
            "CONTROLLER_KEY_UNVERIFIED"
        );
        assert!(
            env::prepaid_gas().as_gas() >= Gas::from_tgas(200).as_gas(),
            "INSUFFICIENT_GAS"
        );
        let mut command = operation.command.clone();
        if invalidation {
            command.operation_id = mpc::commitment(
                &operation.manifest.family,
                format!("invalidate:{operation_id}").as_bytes(),
            );
            command.amount_atomic = U128(0);
            command.recipient = vec![0; command.recipient.len()];
            command.settlement_id = vec![0; 32];
            command.kind = 2;
            command.deadline = operation
                .signing_attempts
                .iter()
                .find(|a| a.attempt_id == attempt_id)
                .map_or_else(
                    || Self::now().checked_add(86_400).expect("TIME_OVERFLOW"),
                    |a| a.source_deadline,
                );
        }
        let built = crate::transaction::construct(&operation.manifest, &command, &context);
        let before = env::storage_usage();
        let index = if let Some(index) = operation
            .signing_attempts
            .iter()
            .position(|a| a.attempt_id == attempt_id)
        {
            let old = &operation.signing_attempts[index];
            assert!(
                old.payload == built.payload
                    && old.transaction == built.transaction
                    && old.invalidation == invalidation,
                "IDEMPOTENCY_CONFLICT"
            );
            index
        } else {
            assert!(
                operation.signing_attempts.len() < 8,
                "SIGNATURE_ATTEMPT_LIMIT"
            );
            if let Some(nonce) = built.account_nonce {
                let key = format!(
                    "{}:{}:{nonce}",
                    operation.manifest.chain_id,
                    hex::encode(&operation.manifest.controller)
                );
                if let Some(existing) = self.signing_resources.get(&key) {
                    assert_eq!(existing, operation_id, "ACCOUNT_NONCE_RESERVED");
                } else {
                    let account_key = format!(
                        "{}:{}",
                        operation.manifest.chain_id,
                        hex::encode(&operation.manifest.controller)
                    );
                    let next = self
                        .account_nonce_next
                        .get(&account_key)
                        .expect("ACCOUNT_NONCE_NOT_INITIALIZED");
                    assert_eq!(nonce, next, "ACCOUNT_NONCE_CHANGED");
                    self.account_nonce_next
                        .insert(&account_key, &next.checked_add(1).expect("NONCE_OVERFLOW"));
                    self.signing_resources.insert(&key, &operation_id);
                }
            }
            if let Some(resource) = &built.resource {
                let key = format!("{}:{resource}", operation.manifest.chain_id);
                if let Some(existing) = self.signing_resources.get(&key) {
                    assert_eq!(existing, operation_id, "GAS_RESOURCE_RESERVED");
                } else {
                    self.signing_resources.insert(&key, &operation_id);
                }
            }
            operation.network_cost_reserved_atomic.0 += built.maximum_network_cost;
            assert!(
                operation.network_cost_reserved_atomic.0
                    <= operation.manifest.max_network_cost_atomic.0,
                "OPERATION_NETWORK_COST_LIMIT"
            );
            operation.signing_attempts.push(SigningAttempt {
                attempt_id: attempt_id.clone(),
                transaction: built.transaction,
                payload: built.payload,
                ed25519: built.ed25519,
                signature: None,
                invalidation,
                account_nonce: built.account_nonce,
                source_deadline: command.deadline,
            });
            operation.signing_attempts.len() - 1
        };
        if operation.state == RemoteState::Prepared {
            let mut loan = self.loan(&operation.loan_id);
            loan.accrue(Self::now());
            if operation.command.kind == 0
                && loan.state == LoanState::Active
                && loan.locks.iter().any(|l| {
                    l.leg.leg_id == operation.leg_id
                        && l.accepted
                        && matches!(l.purpose, crate::state::LockPurpose::Collateral)
                })
            {
                self.assert_safe_withdrawal(&loan);
            }
            if operation.command.kind == 1 {
                self.recheck_settlement(
                    operation
                        .settlement_id
                        .as_ref()
                        .expect("SETTLEMENT_ID_REQUIRED"),
                    &operation.leg_id,
                    operation.command.amount_atomic.0,
                    &loan,
                );
            }
            operation.state = RemoteState::Signing;
            operation.revision += 1;
        }
        let attempt = &operation.signing_attempts[index];
        let payload = if attempt.ed25519 {
            Payload::Eddsa(
                attempt
                    .payload
                    .clone()
                    .try_into()
                    .expect("EDDSA_PAYLOAD_TOO_LARGE"),
            )
        } else {
            Payload::from_legacy_ecdsa(
                attempt
                    .payload
                    .clone()
                    .try_into()
                    .expect("INVALID_ECDSA_DIGEST"),
            )
        };
        let args = SignRequestArgs {
            path: operation.manifest.derivation_path.clone(),
            payload,
            domain_id: DomainId(operation.manifest.sign_domain),
        };
        self.remote_operations.insert(&operation_id, &operation);
        self.charge_storage(&operation.owner, before);
        Promise::new(operation.manifest.mpc_account)
            .function_call(
                "sign",
                serde_json::to_vec(&json!({"request":args})).unwrap(),
                env::attached_deposit(),
                Gas::from_tgas(70),
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "record_remote_signature",
                    serde_json::to_vec(
                        &json!({"operation_id":operation_id,"attempt_id":attempt_id}),
                    )
                    .unwrap(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(40),
                ),
            )
    }
    #[private]
    pub fn record_remote_signature(&mut self, operation_id: String, attempt_id: String) -> bool {
        assert_eq!(env::promise_results_count(), 1, "INVALID_CALLBACK");
        self.remote_operation(&operation_id);
        let Ok(bytes) = env::promise_result_checked(0, 4096) else {
            return false;
        };
        let signature: SignatureResponse =
            serde_json::from_slice(&bytes).expect("INVALID_MPC_SIGNATURE_RESPONSE");
        self.submit_remote_signature(operation_id, attempt_id, signature)
    }
    #[payable]
    pub fn submit_remote_delivery(
        &mut self,
        operation_id: String,
        proof: ReadProof,
    ) -> RemoteOperation {
        Self::one_yocto();
        let mut operation = self.remote_operation(&operation_id);
        mpc::verify_read(&operation.manifest, &proof);
        let receipt = decode_delivery(&operation.manifest, &proof);
        let invalidation_id = mpc::commitment(
            &operation.manifest.family,
            format!("invalidate:{operation_id}").as_bytes(),
        );
        let invalidated = receipt.kind == 2;
        assert!(
            receipt.operation_id
                == if invalidated {
                    invalidation_id
                } else {
                    operation.command.operation_id.clone()
                }
                && receipt.lock_id == operation.command.lock_id
                && receipt.agreement == operation.command.agreement
                && receipt.nonce == operation.command.nonce,
            "COMMAND_COMMITMENT_MISMATCH"
        );
        assert!(
            operation.manifest.family == ChainFamily::Solana
                || receipt.deployment
                    == mpc::commitment(
                        &operation.manifest.family,
                        self.config.deployment_id.as_bytes()
                    ),
            "DEPLOYMENT_MISMATCH"
        );
        if invalidated {
            assert!(
                receipt.amount == 0
                    && receipt.recipient.iter().all(|b| *b == 0)
                    && receipt.settlement_id.iter().all(|b| *b == 0),
                "INVALID_INVALIDATION_RECEIPT"
            );
        } else {
            assert!(
                receipt.kind == operation.command.kind
                    && receipt.amount == operation.command.amount_atomic.0
                    && receipt.recipient == operation.command.recipient
                    && receipt.settlement_id == operation.command.settlement_id,
                "DELIVERY_MISMATCH"
            );
        }
        if matches!(
            operation.state,
            RemoteState::Delivered | RemoteState::Invalidated
        ) {
            assert_eq!(
                operation.state,
                if invalidated {
                    RemoteState::Invalidated
                } else {
                    RemoteState::Delivered
                },
                "CONFLICTING_OUTCOME"
            );
            return operation;
        }
        assert!(
            matches!(operation.state, RemoteState::Signing | RemoteState::Signed),
            "OPERATION_NOT_SIGNED"
        );
        let loan = self.loan(&operation.loan_id);
        let lock = loan
            .locks
            .iter()
            .find(|l| l.leg.leg_id == operation.leg_id)
            .unwrap();
        let expected = lock.locked_atomic.0
            - if invalidated {
                0
            } else {
                operation.command.amount_atomic.0
            };
        assert_eq!(receipt.remaining, expected, "SOURCE_BALANCE_MISMATCH");
        self.resolve_remote_reservation(&operation, !invalidated);
        operation.state = if invalidated {
            RemoteState::Invalidated
        } else {
            RemoteState::Delivered
        };
        operation.revision += 1;
        self.remote_operations.insert(&operation_id, &operation);
        events::emit(
            &self.config.deployment_id,
            "RemoteActionVerified",
            &operation_id,
            operation.revision,
            json!({"operation_id":operation_id,"delivered":!invalidated,"amount_atomic":U128(receipt.amount)}),
        );
        operation
    }
    pub fn get_remote_operation(&self, operation_id: String) -> Option<RemoteOperation> {
        self.remote_operations.get(&operation_id)
    }
}
impl Coordinator {
    pub(crate) fn remote_operation(&self, id: &str) -> RemoteOperation {
        self.remote_operations
            .get(&id.to_owned())
            .expect("REMOTE_OPERATION_NOT_FOUND")
    }
    fn resolve_remote_reservation(&mut self, op: &RemoteOperation, delivered: bool) {
        let mut loan = self.loan(&op.loan_id);
        let lock = loan
            .locks
            .iter_mut()
            .find(|l| l.leg.leg_id == op.leg_id)
            .unwrap();
        lock.reserved_atomic.0 -= op.command.amount_atomic.0;
        if delivered {
            lock.locked_atomic.0 -= op.command.amount_atomic.0;
        }
        lock.remote_nonce = lock
            .remote_nonce
            .checked_add(u64::from(op.state != RemoteState::Prepared))
            .expect("NONCE_OVERFLOW");
        if op.command.kind == 1 {
            self.resolve_remote_settlement(op, delivered);
            if !delivered {
                loan.resolve_outflow(op.settlement_id.as_deref().unwrap_or(&op.operation_id));
            }
        } else {
            loan.resolve_outflow(op.settlement_id.as_deref().unwrap_or(&op.operation_id));
        }
        if loan.state == LoanState::Cancelled && loan.custody_resolved() {
            loan.setup_state = crate::state::SetupState::Aborted;
        }
        loan.revision += 1;
        self.loans.insert(&loan.loan_id, &loan);
    }
}
pub fn verify_signature(
    manifest: &ChainManifest,
    attempt: &SigningAttempt,
    signature: &SignatureResponse,
) {
    match signature {
        SignatureResponse::Secp256k1(sig) => {
            assert!(!attempt.ed25519, "SIGNATURE_SCHEME_MISMATCH");
            let recovered = env::ecrecover(
                &attempt.payload,
                &sig.to_ecrecover_bytes(),
                sig.recovery_id,
                true,
            )
            .expect("INVALID_MPC_SIGNATURE");
            assert_eq!(
                recovered.as_slice(),
                manifest.controller_public_key.as_slice(),
                "MPC_CONTROLLER_MISMATCH"
            );
        }
        SignatureResponse::Ed25519 { signature } => {
            assert!(attempt.ed25519, "SIGNATURE_SCHEME_MISMATCH");
            let signature: [u8; 64] = near_sdk::borsh::to_vec(signature)
                .unwrap()
                .try_into()
                .unwrap();
            let key: [u8; 32] = manifest
                .controller_public_key
                .as_slice()
                .try_into()
                .expect("INVALID_ED25519_KEY");
            assert!(
                env::ed25519_verify(&signature, &attempt.payload, &key),
                "INVALID_MPC_SIGNATURE"
            );
        }
    }
}

#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct BroadcastTransaction {
    pub transaction: Vec<u8>,
    pub signature: Vec<u8>,
}
#[near]
impl Coordinator {
    pub fn submit_remote_signature(
        &mut self,
        operation_id: String,
        attempt_id: String,
        signature: SignatureResponse,
    ) -> bool {
        let before = env::storage_usage();
        let mut operation = self.remote_operation(&operation_id);
        let attempt = operation
            .signing_attempts
            .iter_mut()
            .find(|a| a.attempt_id == attempt_id)
            .expect("ATTEMPT_NOT_FOUND");
        verify_signature(&operation.manifest, attempt, &signature);
        if attempt.signature.is_none() {
            attempt.signature = Some(signature);
        }
        if operation.state == RemoteState::Signing {
            operation.state = RemoteState::Signed;
            operation.revision += 1;
        }
        self.remote_operations.insert(&operation_id, &operation);
        self.charge_storage(&operation.owner, before);
        true
    }
    pub fn remote_broadcast_transaction(
        &self,
        operation_id: String,
        attempt_id: String,
    ) -> BroadcastTransaction {
        let operation = self.remote_operation(&operation_id);
        let attempt = operation
            .signing_attempts
            .iter()
            .find(|a| a.attempt_id == attempt_id)
            .expect("ATTEMPT_NOT_FOUND");
        let signature = attempt.signature.as_ref().expect("SIGNATURE_NOT_RECORDED");
        let transaction = match (&operation.manifest.family, signature) {
            (ChainFamily::Evm, SignatureResponse::Secp256k1(signature)) => {
                let input = rlp::Rlp::new(&attempt.transaction[1..]);
                assert_eq!(input.item_count().unwrap(), 9, "INVALID_EVM_TRANSACTION");
                let mut out = rlp::RlpStream::new_list(12);
                for index in 0..9 {
                    out.append_raw(input.at(index).unwrap().as_raw(), 1);
                }
                out.append(&signature.recovery_id);
                for bytes in [&signature.big_r.affine_point[1..], &signature.s.scalar[..]] {
                    let first = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
                    out.append(&&bytes[first..]);
                }
                let mut tx = vec![2];
                tx.extend_from_slice(&out.out());
                tx
            }
            (ChainFamily::Solana, SignatureResponse::Ed25519 { signature }) => {
                let mut tx = vec![1];
                tx.extend_from_slice(&near_sdk::borsh::to_vec(signature).unwrap());
                tx.extend_from_slice(&attempt.transaction);
                tx
            }
            (ChainFamily::Sui, SignatureResponse::Ed25519 { signature }) => {
                let mut sig = vec![0];
                sig.extend_from_slice(&near_sdk::borsh::to_vec(signature).unwrap());
                sig.extend_from_slice(&operation.manifest.controller_public_key);
                return BroadcastTransaction {
                    transaction: attempt.transaction.clone(),
                    signature: sig,
                };
            }
            (ChainFamily::Starknet, SignatureResponse::Secp256k1(signature)) => {
                let mut tx: serde_json::Value =
                    serde_json::from_slice(&attempt.transaction).unwrap();
                let bytes = signature.to_ecrecover_bytes();
                let mut parts = vec![];
                for component in [&bytes[..32], &bytes[32..]] {
                    for half in [&component[16..], &component[..16]] {
                        parts.push(format!(
                            "0x{:x}",
                            u128::from_be_bytes(half.try_into().unwrap())
                        ));
                    }
                }
                tx["signature"] = json!(parts);
                serde_json::to_vec(&tx).unwrap()
            }
            _ => panic!("SIGNATURE_SCHEME_MISMATCH"),
        };
        BroadcastTransaction {
            transaction,
            signature: vec![],
        }
    }
}
