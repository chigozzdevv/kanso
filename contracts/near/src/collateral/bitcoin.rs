use crate::{
    manifest::ChainManifest,
    state::{Custody, LoanState},
    Coordinator, CoordinatorExt,
};
use bitcoin::{
    absolute,
    consensus::{deserialize, serialize},
    hashes::Hash,
    sighash::{EcdsaSighashType, SighashCache},
    transaction, Amount, CompressedPublicKey, OutPoint, ScriptBuf, Sequence, Transaction, TxIn,
    TxOut, Txid, Witness,
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

#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct BitcoinUtxo {
    pub txid: Vec<u8>,
    pub vout: u32,
    pub amount: u64,
    pub script: Vec<u8>,
    pub spent: bool,
    pub reserved_by: Option<String>,
}
#[near(serializers=[borsh,json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum BitcoinSpendState {
    Prepared,
    Signing,
    Signed,
    Delivered,
    Invalidated,
    Cancelled,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct BitcoinSpend {
    pub operation_id: String,
    pub settlement_id: Option<String>,
    pub recovery_id: Option<String>,
    pub loan_id: String,
    pub leg_id: String,
    pub owner: AccountId,
    pub manifest: ChainManifest,
    pub input: BitcoinUtxo,
    pub recipient_script: Vec<u8>,
    pub amount_atomic: U128,
    pub max_fee_atomic: U128,
    pub expires_at: u64,
    pub state: BitcoinSpendState,
    pub attempts: Vec<BitcoinAttempt>,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct BitcoinAttempt {
    pub attempt_id: String,
    pub fee_atomic: U128,
    pub cancellation: bool,
    pub raw_unsigned: Vec<u8>,
    pub digest: Vec<u8>,
    pub signature: Option<SignatureResponse>,
}

fn script(public_key: &[u8]) -> ScriptBuf {
    let key = CompressedPublicKey::from_slice(public_key).expect("INVALID_BTC_PUBLIC_KEY");
    ScriptBuf::new_p2wpkh(&key.wpubkey_hash())
}
fn leg_key(loan: &str, leg: &str) -> String {
    format!("{loan}:{leg}")
}
fn outpoint_key(txid: &[u8], vout: u32) -> String {
    format!("bitcoin:{}:{vout}", hex::encode(txid))
}
fn path(manifest: &ChainManifest, loan: &str, leg: &str) -> String {
    format!("{}/{loan}/{leg}", manifest.derivation_path)
}

#[near]
impl Coordinator {
    #[payable]
    pub fn derive_bitcoin_deposit_key(&mut self, loan_id: String, leg_id: String) -> Promise {
        Self::one_yocto();
        let loan = self.loan(&loan_id);
        let lock = loan
            .locks
            .iter()
            .find(|l| l.leg.leg_id == leg_id)
            .expect("LEG_NOT_FOUND");
        let Custody::Remote {
            chain_id,
            manifest_version,
            ..
        } = &lock.leg.custody
        else {
            panic!("REMOTE_LEG_REQUIRED")
        };
        assert_eq!(chain_id, "bitcoin", "BITCOIN_LEG_REQUIRED");
        let manifest = self.get_chain_manifest(chain_id.clone(), Some(*manifest_version));
        Promise::new(manifest.mpc_account.clone()).function_call("derived_public_key",serde_json::to_vec(&json!({"path":path(&manifest,&loan_id,&leg_id),"predecessor":env::current_account_id(),"domain_id":manifest.sign_domain})).unwrap(),NearToken::from_yoctonear(0),Gas::from_tgas(15)).then(Promise::new(env::current_account_id()).function_call("record_bitcoin_key",serde_json::to_vec(&json!({"loan_id":loan_id,"leg_id":leg_id})).unwrap(),NearToken::from_yoctonear(0),Gas::from_tgas(20)))
    }
    #[private]
    pub fn record_bitcoin_key(&mut self, loan_id: String, leg_id: String) -> bool {
        assert_eq!(env::promise_results_count(), 1, "INVALID_CALLBACK");
        let Ok(bytes) = env::promise_result_checked(0, 1024) else {
            return false;
        };
        let key: PublicKey = serde_json::from_slice(&bytes).expect("INVALID_MPC_KEY");
        let key: near_sdk::PublicKey = key.try_into().expect("UNSUPPORTED_KEY");
        assert_eq!(key.as_bytes()[0], 1, "SECP256K1_REQUIRED");
        let key = bitcoin::PublicKey::from_slice(&[&[4_u8][..], &key.as_bytes()[1..]].concat())
            .expect("INVALID_BTC_KEY")
            .inner
            .serialize()
            .to_vec();
        let id = leg_key(&loan_id, &leg_id);
        if let Some(previous) = self.bitcoin_keys.get(&id) {
            assert_eq!(previous, key, "BITCOIN_KEY_CHANGED");
            return true;
        }
        let loan = self.loan(&loan_id);
        let before = env::storage_usage();
        self.bitcoin_keys.insert(&id, &key);
        self.charge_storage(&loan.offer.borrower, before);
        true
    }
    pub fn bitcoin_deposit_script(&self, loan_id: String, leg_id: String) -> Vec<u8> {
        let key = self
            .bitcoin_keys
            .get(&leg_key(&loan_id, &leg_id))
            .expect("BITCOIN_KEY_NOT_DERIVED");
        script(&key).into_bytes()
    }
}
impl Coordinator {
    pub(crate) fn apply_bitcoin_lock(
        &mut self,
        loan_id: String,
        leg_id: String,
        tx: &Transaction,
        vout: u32,
        payer: &AccountId,
    ) -> crate::state::Loan {
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
            "SETUP_NOT_OPEN"
        );
        assert_ne!(
            loan.setup_state,
            crate::state::SetupState::Funding,
            "DISBURSEMENT_UNRESOLVED"
        );
        let lock = loan
            .locks
            .iter_mut()
            .find(|l| l.leg.leg_id == leg_id)
            .expect("LEG_NOT_FOUND");
        let Custody::Remote { chain_id, .. } = &lock.leg.custody else {
            panic!("BITCOIN_LEG_REQUIRED")
        };
        assert_eq!(chain_id, "bitcoin", "BITCOIN_LEG_REQUIRED");
        let output = tx.output.get(vout as usize).expect("OUTPUT_NOT_FOUND");
        let id = leg_key(&loan_id, &leg_id);
        let key = self.bitcoin_keys.get(&id).expect("BITCOIN_KEY_NOT_DERIVED");
        assert!(
            output.script_pubkey == script(&key) && output.value.to_sat() > 0,
            "BITCOIN_OUTPUT_MISMATCH"
        );
        let txid = tx.compute_txid().to_byte_array().to_vec();
        let resource = outpoint_key(&txid, vout);
        if lock.receipt_verified {
            assert_eq!(
                self.remote_resources.get(&resource),
                Some(id.clone()),
                "DEPOSIT_ALREADY_ACCEPTED"
            );
            return loan;
        }
        assert!(
            self.remote_resources.get(&resource).is_none(),
            "OUTPOINT_REUSED"
        );
        let before = env::storage_usage();
        self.remote_resources.insert(&resource, &id);
        self.bitcoin_utxos.insert(
            &id,
            &BitcoinUtxo {
                txid,
                vout,
                amount: output.value.to_sat(),
                script: output.script_pubkey.clone().into_bytes(),
                spent: false,
                reserved_by: None,
            },
        );
        lock.receipt_verified = true;
        lock.accepted = u128::from(output.value.to_sat()) == lock.leg.amount_atomic.0;
        lock.locked_atomic = U128(u128::from(output.value.to_sat()));
        loan.revision += 1;
        if matches!(loan.state, LoanState::PendingFunding | LoanState::Cancelled) {
            loan.setup_state = if loan.state == LoanState::Cancelled {
                crate::state::SetupState::Aborting
            } else if loan.locks.iter().all(|l| l.accepted)
                && Self::now() < loan.offer.setup_deadline
            {
                crate::state::SetupState::Ready
            } else {
                crate::state::SetupState::Locking
            };
        }
        self.loans.insert(&loan_id, &loan);
        self.charge_storage(payer, before);
        loan
    }
}
#[near]
impl Coordinator {
    #[payable]
    pub fn prepare_bitcoin_release(
        &mut self,
        operation_id: String,
        loan_id: String,
        leg_id: String,
        amount_atomic: U128,
        max_fee_atomic: U128,
        expected_revision: String,
    ) -> BitcoinSpend {
        Self::one_yocto();
        crate::config::valid_id(&operation_id);
        let mut loan = self.loan(&loan_id);

        if let Some(existing) = self.bitcoin_spends.get(&operation_id) {
            assert!(
                existing.loan_id == loan_id
                    && existing.leg_id == leg_id
                    && existing.amount_atomic == amount_atomic
                    && existing.max_fee_atomic == max_fee_atomic,
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
        loan.accrue(Self::now());
        let active = loan.state == LoanState::Active;
        assert!(
            active
                || matches!(
                    loan.state,
                    LoanState::Cancelled | LoanState::Repaid | LoanState::WrittenOff
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
            release_recipient,
            ..
        } = &lock.leg.custody
        else {
            panic!("BITCOIN_LEG_REQUIRED")
        };
        assert_eq!(chain_id, "bitcoin", "BITCOIN_LEG_REQUIRED");
        let manifest = self.get_chain_manifest(chain_id.clone(), Some(*manifest_version));
        let collateral =
            lock.accepted && matches!(lock.purpose, crate::state::LockPurpose::Collateral);
        if active && collateral {
            assert!(Self::now() < loan.matures_at, "LOAN_DUE");
        }
        let owner = match &lock.purpose {
            crate::state::LockPurpose::Collateral => loan.offer.borrower.clone(),
            crate::state::LockPurpose::Payment { payer, .. } => payer.clone(),
        };
        assert_eq!(
            env::predecessor_account_id(),
            owner,
            "CUSTODY_OWNER_REQUIRED"
        );
        assert!(
            max_fee_atomic.0 > 0 && max_fee_atomic.0 <= manifest.max_network_cost_atomic.0,
            "BITCOIN_FEE_LIMIT"
        );
        let recipient_script = ScriptBuf::from_bytes(release_recipient.clone());
        assert!(recipient_script.is_p2wpkh(), "P2WPKH_RECIPIENT_REQUIRED");
        let reserve = amount_atomic
            .0
            .checked_add(max_fee_atomic.0)
            .expect("AMOUNT_OVERFLOW");
        assert!(
            amount_atomic.0 >= 294 && reserve <= lock.locked_atomic.0 - lock.reserved_atomic.0,
            "COLLATERAL_UNAVAILABLE"
        );
        lock.reserved_atomic.0 += reserve;
        let mut input = self
            .bitcoin_utxos
            .get(&leg_key(&loan_id, &leg_id))
            .expect("UTXO_NOT_FOUND");
        assert!(
            !input.spent && input.reserved_by.is_none(),
            "UTXO_UNAVAILABLE"
        );
        assert_eq!(
            u128::from(input.amount),
            lock.locked_atomic.0,
            "UTXO_BALANCE_MISMATCH"
        );
        input.reserved_by = Some(operation_id.clone());
        let recipient_script = release_recipient.clone();
        if active && collateral {
            self.assert_safe_withdrawal(&loan);
        }
        let before = env::storage_usage();
        let spend = BitcoinSpend {
            operation_id: operation_id.clone(),
            settlement_id: None,
            recovery_id: None,
            loan_id: loan_id.clone(),
            leg_id: leg_id.clone(),
            owner,
            manifest,
            input: input.clone(),
            recipient_script,
            amount_atomic,
            max_fee_atomic,
            expires_at: Self::now() + 86_400,
            state: BitcoinSpendState::Prepared,
            attempts: vec![],
        };
        loan.active_outflow = Some(operation_id.clone());
        loan.revision += 1;
        self.loans.insert(&loan_id, &loan);
        self.bitcoin_utxos
            .insert(&leg_key(&loan_id, &leg_id), &input);
        self.bitcoin_spends.insert(&operation_id, &spend);
        self.charge_storage(&spend.owner, before);
        spend
    }
    #[payable]
    pub fn request_bitcoin_signature(
        &mut self,
        operation_id: String,
        attempt_id: String,
        fee_atomic: U128,
        cancellation: bool,
    ) -> Promise {
        crate::config::valid_id(&attempt_id);
        let mut spend = self
            .bitcoin_spends
            .get(&operation_id)
            .expect("BITCOIN_SPEND_NOT_FOUND");
        assert!(
            env::predecessor_account_id() == spend.owner
                || (cancellation && Self::now() >= spend.expires_at),
            "OWNER_REQUIRED"
        );
        assert!(
            matches!(
                spend.state,
                BitcoinSpendState::Prepared
                    | BitcoinSpendState::Signing
                    | BitcoinSpendState::Signed
            ),
            "BITCOIN_SPEND_TERMINAL"
        );
        assert!(
            spend.manifest.signing_enabled
                && self
                    .get_chain_manifest("bitcoin".into(), None)
                    .signing_enabled,
            "SIGNING_PAUSED"
        );
        assert!(
            fee_atomic.0 > 0 && fee_atomic.0 <= spend.max_fee_atomic.0,
            "BITCOIN_FEE_LIMIT"
        );
        if spend.recovery_id.is_some() {
            assert!(!cancellation, "RECOVERY_REFUND_ONLY");
        }
        if spend.state == BitcoinSpendState::Prepared && spend.recovery_id.is_none() {
            let mut loan = self.loan(&spend.loan_id);
            loan.accrue(Self::now());
            if let Some(id) = &spend.settlement_id {
                self.recheck_settlement(
                    id,
                    &spend.leg_id,
                    spend.amount_atomic.0 + spend.max_fee_atomic.0,
                    &loan,
                );
            } else if loan.state == LoanState::Active
                && loan.locks.iter().any(|l| {
                    l.leg.leg_id == spend.leg_id
                        && l.accepted
                        && matches!(l.purpose, crate::state::LockPurpose::Collateral)
                })
            {
                self.assert_safe_withdrawal(&loan);
            }
            spend.state = BitcoinSpendState::Signing;
        }
        if spend.state == BitcoinSpendState::Prepared {
            spend.state = BitcoinSpendState::Signing;
        }
        let id = leg_key(&spend.loan_id, &spend.leg_id);
        let public_key = self.bitcoin_keys.get(&id).expect("BITCOIN_KEY_NOT_DERIVED");
        let tx = build_spend(&spend, fee_atomic.0, cancellation);
        let digest = SighashCache::new(&tx)
            .p2wpkh_signature_hash(
                0,
                &ScriptBuf::from_bytes(spend.input.script.clone()),
                Amount::from_sat(spend.input.amount),
                EcdsaSighashType::All,
            )
            .expect("INVALID_BIP143_INPUT")
            .to_byte_array()
            .to_vec();
        if let Some(old) = spend.attempts.iter().find(|a| a.attempt_id == attempt_id) {
            assert!(
                old.fee_atomic == fee_atomic && old.cancellation == cancellation,
                "IDEMPOTENCY_CONFLICT"
            );
        } else {
            assert!(spend.attempts.len() < 8, "SIGNATURE_ATTEMPT_LIMIT");
            if let Some(last) = spend
                .attempts
                .iter()
                .rfind(|a| a.cancellation == cancellation)
            {
                assert!(fee_atomic.0 > last.fee_atomic.0, "RBF_FEE_MUST_INCREASE");
            }
            spend.attempts.push(BitcoinAttempt {
                attempt_id: attempt_id.clone(),
                fee_atomic,
                cancellation,
                raw_unsigned: serialize(&tx),
                digest: digest.clone(),
                signature: None,
            });
        }
        let before = env::storage_usage();
        self.bitcoin_spends.insert(&operation_id, &spend);
        self.charge_storage(&spend.owner, before);
        assert_eq!(
            script(&public_key).as_bytes(),
            spend.input.script.as_slice(),
            "CUSTODY_KEY_MISMATCH"
        );
        let request = SignRequestArgs {
            path: path(&spend.manifest, &spend.loan_id, &spend.leg_id),
            payload: Payload::from_legacy_ecdsa(digest.try_into().unwrap()),
            domain_id: DomainId(spend.manifest.sign_domain),
        };
        Promise::new(spend.manifest.mpc_account)
            .function_call(
                "sign",
                serde_json::to_vec(&json!({"request":request})).unwrap(),
                env::attached_deposit(),
                Gas::from_tgas(70),
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "record_bitcoin_signature",
                    serde_json::to_vec(
                        &json!({"operation_id":operation_id,"attempt_id":attempt_id}),
                    )
                    .unwrap(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(30),
                ),
            )
    }
    #[private]
    pub fn record_bitcoin_signature(&mut self, operation_id: String, attempt_id: String) -> bool {
        assert_eq!(env::promise_results_count(), 1, "INVALID_CALLBACK");
        let Ok(bytes) = env::promise_result_checked(0, 4096) else {
            return false;
        };
        let signature: SignatureResponse =
            serde_json::from_slice(&bytes).expect("INVALID_MPC_SIGNATURE");
        self.submit_bitcoin_signature(operation_id, attempt_id, signature)
    }
    pub fn submit_bitcoin_signature(
        &mut self,
        operation_id: String,
        attempt_id: String,
        signature: SignatureResponse,
    ) -> bool {
        let before = env::storage_usage();
        let mut spend = self
            .bitcoin_spends
            .get(&operation_id)
            .expect("BITCOIN_SPEND_NOT_FOUND");
        let public_key = self
            .bitcoin_keys
            .get(&leg_key(&spend.loan_id, &spend.leg_id))
            .unwrap();
        let attempt = spend
            .attempts
            .iter_mut()
            .find(|a| a.attempt_id == attempt_id)
            .expect("ATTEMPT_NOT_FOUND");
        let SignatureResponse::Secp256k1(sig) = &signature else {
            panic!("SECP256K1_REQUIRED")
        };
        let recovered = env::ecrecover(
            &attempt.digest,
            &sig.to_ecrecover_bytes(),
            sig.recovery_id,
            true,
        )
        .expect("INVALID_SIGNATURE");
        let expected = bitcoin::PublicKey::from_slice(&public_key)
            .unwrap()
            .inner
            .serialize_uncompressed();
        assert_eq!(
            recovered.as_slice(),
            &expected[1..],
            "BITCOIN_SIGNER_MISMATCH"
        );
        if attempt.signature.is_none() {
            attempt.signature = Some(signature);
        }
        if spend.state == BitcoinSpendState::Signing {
            spend.state = BitcoinSpendState::Signed;
        }
        self.bitcoin_spends.insert(&operation_id, &spend);
        self.charge_storage(&spend.owner, before);
        true
    }
}
impl Coordinator {
    pub(crate) fn apply_bitcoin_delivery(
        &mut self,
        operation_id: String,
        tx: &Transaction,
    ) -> BitcoinSpend {
        let mut spend = self
            .bitcoin_spends
            .get(&operation_id)
            .expect("BITCOIN_SPEND_NOT_FOUND");
        let attempt = spend
            .attempts
            .iter()
            .find(|a| {
                deserialize::<Transaction>(&a.raw_unsigned)
                    .unwrap()
                    .compute_txid()
                    == tx.compute_txid()
            })
            .expect("UNAUTHORIZED_BITCOIN_SPEND")
            .clone();
        let expected = if attempt.cancellation {
            BitcoinSpendState::Invalidated
        } else {
            BitcoinSpendState::Delivered
        };
        if matches!(
            spend.state,
            BitcoinSpendState::Delivered | BitcoinSpendState::Invalidated
        ) {
            assert_eq!(spend.state, expected, "CONFLICTING_BITCOIN_OUTCOME");
            return spend;
        }
        assert!(
            matches!(
                spend.state,
                BitcoinSpendState::Signing | BitcoinSpendState::Signed
            ),
            "BITCOIN_NOT_SIGNED"
        );
        if let Some(id) = &spend.recovery_id {
            assert!(!attempt.cancellation, "RECOVERY_REFUND_ONLY");
            let mut recovery = self.bitcoin_recoveries.get(id).expect("RECOVERY_NOT_FOUND");
            assert_eq!(
                recovery.input.reserved_by.as_ref(),
                Some(&operation_id),
                "RECOVERY_RESERVATION_MISMATCH"
            );
            recovery.input.spent = true;
            recovery.completed = true;
            spend.state = BitcoinSpendState::Delivered;
            self.bitcoin_recoveries.insert(id, &recovery);
            self.bitcoin_spends.insert(&operation_id, &spend);
            return spend;
        }
        let before = env::storage_usage();
        let mut loan = self.loan(&spend.loan_id);
        let mut clear_outflow = false;
        let lock = loan
            .locks
            .iter_mut()
            .find(|l| l.leg.leg_id == spend.leg_id)
            .unwrap();
        lock.reserved_atomic.0 -= spend.amount_atomic.0 + spend.max_fee_atomic.0;
        lock.locked_atomic.0 -= attempt.fee_atomic.0
            + if attempt.cancellation {
                0
            } else {
                spend.amount_atomic.0
            };
        if let Some(id) = &spend.settlement_id {
            let mut settlement = self.settlement(id);
            assert_eq!(
                settlement.state,
                crate::settlement::SettlementState::Committed,
                "SETTLEMENT_NOT_COMMITTED"
            );
            let source_cost = crate::math::mul_div_ceil(
                settlement.reserved_source_fee_value_atomic.0,
                attempt.fee_atomic.0,
                spend.max_fee_atomic.0,
            );
            if attempt.cancellation {
                if settlement.plan.kind == crate::settlement::SettlementKind::Conditional {
                    self.resolve_conditional(
                        &loan.loan_id,
                        &lock.leg.asset_id,
                        settlement.plan.input_atomic.0,
                        settlement.plan.net_output_atomic.0,
                        settlement.plan.execution_cost_atomic.0,
                        Some((attempt.fee_atomic.0, 0, source_cost)),
                    );
                }
                settlement.state = crate::settlement::SettlementState::Funded;
                settlement.transfer_id = None;
                clear_outflow = true;
            } else {
                settlement.state = crate::settlement::SettlementState::Delivered;
                settlement.source_spent_atomic = U128(spend.amount_atomic.0 + attempt.fee_atomic.0);
                settlement.actual_cost_atomic = U128(
                    settlement.plan.execution_cost_atomic.0
                        - settlement.reserved_source_fee_value_atomic.0
                        + source_cost,
                );
            }
            settlement.revision += 1;
            self.settlements.insert(id, &settlement);
        } else {
            clear_outflow = true;
        }
        loan.revision += 1;
        let id = leg_key(&spend.loan_id, &spend.leg_id);
        let change_index = if attempt.cancellation { 0 } else { 1 };
        if let Some(output) = tx.output.get(change_index) {
            assert_eq!(
                output.script_pubkey.as_bytes(),
                spend.input.script,
                "CHANGE_SCRIPT_MISMATCH"
            );
            assert_eq!(
                u128::from(output.value.to_sat()),
                lock.locked_atomic.0,
                "CHANGE_AMOUNT_MISMATCH"
            );
            let txid = tx.compute_txid().to_byte_array().to_vec();
            let key = outpoint_key(&txid, change_index as u32);
            assert!(
                self.remote_resources.get(&key).is_none(),
                "CHANGE_ALREADY_USED"
            );
            self.remote_resources.insert(&key, &id);
            self.bitcoin_utxos.insert(
                &id,
                &BitcoinUtxo {
                    txid,
                    vout: change_index as u32,
                    amount: output.value.to_sat(),
                    script: spend.input.script.clone(),
                    spent: false,
                    reserved_by: None,
                },
            );
        } else {
            assert_eq!(lock.locked_atomic.0, 0, "MISSING_CHANGE");
            let mut old = spend.input.clone();
            old.spent = true;
            old.reserved_by = None;
            self.bitcoin_utxos.insert(&id, &old);
        }
        if clear_outflow {
            loan.resolve_outflow(spend.settlement_id.as_deref().unwrap_or(&operation_id));
        }
        spend.state = expected;
        if loan.state == LoanState::Cancelled && loan.custody_resolved() {
            loan.setup_state = crate::state::SetupState::Aborted;
        }
        self.loans.insert(&loan.loan_id, &loan);
        self.bitcoin_spends.insert(&operation_id, &spend);
        self.charge_storage(&spend.owner, before);
        spend
    }
}
#[near]
impl Coordinator {
    pub fn get_bitcoin_spend(&self, operation_id: String) -> Option<BitcoinSpend> {
        self.bitcoin_spends.get(&operation_id)
    }
}
pub fn build_spend(spend: &BitcoinSpend, fee: u128, cancellation: bool) -> Transaction {
    let fee: u64 = fee.try_into().expect("BITCOIN_FEE_OVERFLOW");
    let amount: u64 = spend
        .amount_atomic
        .0
        .try_into()
        .expect("BITCOIN_AMOUNT_OVERFLOW");
    let delivered = if cancellation { 0 } else { amount };
    if spend.recovery_id.is_some() {
        assert!(!cancellation, "RECOVERY_REFUND_ONLY");
        return Transaction {
            version: transaction::Version::TWO,
            lock_time: absolute::LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_byte_array(spend.input.txid.as_slice().try_into().unwrap()),
                    vout: spend.input.vout,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(
                    spend
                        .input
                        .amount
                        .checked_sub(fee)
                        .expect("INSUFFICIENT_BITCOIN"),
                ),
                script_pubkey: ScriptBuf::from_bytes(spend.recipient_script.clone()),
            }],
        };
    }
    let change = spend
        .input
        .amount
        .checked_sub(delivered)
        .and_then(|v| v.checked_sub(fee))
        .expect("INSUFFICIENT_BITCOIN");
    let mut outputs = vec![];
    if !cancellation {
        outputs.push(TxOut {
            value: Amount::from_sat(amount),
            script_pubkey: ScriptBuf::from_bytes(spend.recipient_script.clone()),
        });
    }
    if change > 0 {
        assert!(change >= 294, "BITCOIN_CHANGE_DUST");
        outputs.push(TxOut {
            value: Amount::from_sat(change),
            script_pubkey: ScriptBuf::from_bytes(spend.input.script.clone()),
        });
    }
    Transaction {
        version: transaction::Version::TWO,
        lock_time: absolute::LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint {
                txid: Txid::from_byte_array(spend.input.txid.as_slice().try_into().unwrap()),
                vout: spend.input.vout,
            },
            script_sig: ScriptBuf::new(),
            sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
            witness: Witness::new(),
        }],
        output: outputs,
    }
}

impl Coordinator {
    pub(crate) fn bitcoin_sale(
        &mut self,
        plan: &crate::settlement::SettlementPlan,
        loan: &crate::state::Loan,
        manifest: ChainManifest,
        operation_id: String,
    ) -> BitcoinSpend {
        assert!(
            self.bitcoin_spends.get(&operation_id).is_none(),
            "BITCOIN_SPEND_EXISTS"
        );
        let id = leg_key(&loan.loan_id, &plan.leg_id);
        let mut input = self.bitcoin_utxos.get(&id).expect("UTXO_NOT_FOUND");
        assert!(
            !input.spent && input.reserved_by.is_none(),
            "UTXO_UNAVAILABLE"
        );
        let recipient = ScriptBuf::from_bytes(plan.remote_recipient.clone());
        assert!(recipient.is_p2wpkh(), "P2WPKH_RECIPIENT_REQUIRED");
        let amount = plan.input_atomic.0 - plan.max_source_fee_atomic.0;
        assert!(amount >= 294, "BITCOIN_DUST");
        input.reserved_by = Some(operation_id.clone());
        self.bitcoin_utxos.insert(&id, &input);
        BitcoinSpend {
            operation_id,
            settlement_id: Some(plan.operation_id.clone()),
            recovery_id: None,
            loan_id: loan.loan_id.clone(),
            leg_id: plan.leg_id.clone(),
            owner: plan.solver.clone(),
            manifest,
            input,
            recipient_script: plan.remote_recipient.clone(),
            amount_atomic: U128(amount),
            max_fee_atomic: plan.max_source_fee_atomic,
            expires_at: plan.expires_at,
            state: BitcoinSpendState::Prepared,
            attempts: vec![],
        }
    }
}
#[near]
impl Coordinator {
    #[payable]
    pub fn cancel_unsigned_bitcoin_spend(&mut self, operation_id: String) -> BitcoinSpend {
        Self::one_yocto();
        let mut spend = self
            .bitcoin_spends
            .get(&operation_id)
            .expect("BITCOIN_SPEND_NOT_FOUND");
        assert!(
            env::predecessor_account_id() == spend.owner || Self::now() >= spend.expires_at,
            "OWNER_REQUIRED"
        );
        if spend.state == BitcoinSpendState::Cancelled {
            return spend;
        }
        assert_eq!(
            spend.state,
            BitcoinSpendState::Prepared,
            "SIGNATURE_UNRESOLVED"
        );
        if let Some(id) = &spend.recovery_id {
            let mut recovery = self.bitcoin_recoveries.get(id).expect("RECOVERY_NOT_FOUND");
            recovery.input.reserved_by = None;
            spend.state = BitcoinSpendState::Cancelled;
            self.bitcoin_recoveries.insert(id, &recovery);
            self.bitcoin_spends.insert(&operation_id, &spend);
            return spend;
        }
        let mut loan = self.loan(&spend.loan_id);
        let lock = loan
            .locks
            .iter_mut()
            .find(|l| l.leg.leg_id == spend.leg_id)
            .unwrap();
        lock.reserved_atomic.0 -= spend.amount_atomic.0 + spend.max_fee_atomic.0;
        if let Some(id) = &spend.settlement_id {
            let mut settlement = self.settlement(id);
            if settlement.plan.kind == crate::settlement::SettlementKind::Conditional {
                self.resolve_conditional(
                    &loan.loan_id,
                    &lock.leg.asset_id,
                    settlement.plan.input_atomic.0,
                    settlement.plan.net_output_atomic.0,
                    settlement.plan.execution_cost_atomic.0,
                    None,
                );
            }
            settlement.state = crate::settlement::SettlementState::Funded;
            settlement.transfer_id = None;
            settlement.revision += 1;
            self.settlements.insert(id, &settlement);
        }
        loan.resolve_outflow(spend.settlement_id.as_deref().unwrap_or(&operation_id));
        loan.revision += 1;
        let mut input = spend.input.clone();
        input.reserved_by = None;
        self.bitcoin_utxos
            .insert(&leg_key(&spend.loan_id, &spend.leg_id), &input);
        spend.state = BitcoinSpendState::Cancelled;
        self.loans.insert(&loan.loan_id, &loan);
        self.bitcoin_spends.insert(&operation_id, &spend);
        spend
    }
    pub fn signed_bitcoin_transaction(&self, operation_id: String, attempt_id: String) -> Vec<u8> {
        let spend = self
            .bitcoin_spends
            .get(&operation_id)
            .expect("BITCOIN_SPEND_NOT_FOUND");
        let attempt = spend
            .attempts
            .iter()
            .find(|a| a.attempt_id == attempt_id)
            .expect("ATTEMPT_NOT_FOUND");
        let Some(SignatureResponse::Secp256k1(signature)) = &attempt.signature else {
            panic!("SIGNATURE_NOT_RECORDED")
        };
        let compact = signature.to_ecrecover_bytes();
        let signature = bitcoin::secp256k1::ecdsa::Signature::from_compact(&compact)
            .expect("INVALID_SIGNATURE");
        let mut der = signature.serialize_der().to_vec();
        der.push(EcdsaSighashType::All as u8);
        let key = self
            .bitcoin_keys
            .get(&leg_key(&spend.loan_id, &spend.leg_id))
            .unwrap();
        let mut tx: Transaction = deserialize(&attempt.raw_unsigned).unwrap();
        tx.input[0].witness = Witness::from_slice(&[der, key]);
        serialize(&tx)
    }
}

#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct BitcoinRecovery {
    pub recovery_id: String,
    pub loan_id: String,
    pub leg_id: String,
    pub owner: AccountId,
    pub manifest: ChainManifest,
    pub input: BitcoinUtxo,
    pub refund_script: Vec<u8>,
    pub completed: bool,
}
impl Coordinator {
    pub(crate) fn apply_bitcoin_recovery(
        &mut self,
        recovery_id: String,
        loan_id: String,
        leg_id: String,
        tx: &Transaction,
        vout: u32,
        payer: &AccountId,
    ) -> BitcoinRecovery {
        crate::config::valid_id(&recovery_id);
        let loan = self.loan(&loan_id);
        let lock = loan
            .locks
            .iter()
            .find(|l| l.leg.leg_id == leg_id)
            .expect("LEG_NOT_FOUND");
        assert_eq!(payer, &lock.leg.owner, "SOURCE_OWNER_REQUIRED");
        let Custody::Remote {
            chain_id,
            manifest_version,
            release_recipient,
            ..
        } = &lock.leg.custody
        else {
            panic!("BITCOIN_LEG_REQUIRED")
        };
        assert_eq!(chain_id, "bitcoin", "BITCOIN_LEG_REQUIRED");
        let manifest = self.get_chain_manifest(chain_id.clone(), Some(*manifest_version));
        let output = tx.output.get(vout as usize).expect("OUTPUT_NOT_FOUND");
        let public_key = self
            .bitcoin_keys
            .get(&leg_key(&loan_id, &leg_id))
            .expect("BITCOIN_KEY_NOT_DERIVED");
        assert!(
            output.value.to_sat() > 0 && output.script_pubkey == script(&public_key),
            "BITCOIN_OUTPUT_MISMATCH"
        );
        let txid = tx.compute_txid().to_byte_array().to_vec();
        if let Some(existing) = self.bitcoin_recoveries.get(&recovery_id) {
            assert!(
                existing.loan_id == loan_id
                    && existing.leg_id == leg_id
                    && existing.input.txid == txid
                    && existing.input.vout == vout,
                "IDEMPOTENCY_CONFLICT"
            );
            return existing;
        }
        let resource = outpoint_key(&txid, vout);
        assert!(
            self.remote_resources.get(&resource).is_none(),
            "OUTPOINT_ALREADY_ASSIGNED"
        );
        let before = env::storage_usage();
        let recovery = BitcoinRecovery {
            recovery_id: recovery_id.clone(),
            loan_id,
            leg_id,
            owner: lock.leg.owner.clone(),
            manifest,
            input: BitcoinUtxo {
                txid,
                vout,
                amount: output.value.to_sat(),
                script: output.script_pubkey.clone().into_bytes(),
                spent: false,
                reserved_by: None,
            },
            refund_script: release_recipient.clone(),
            completed: false,
        };
        self.remote_resources
            .insert(&resource, &format!("recovery:{recovery_id}"));
        self.bitcoin_recoveries.insert(&recovery_id, &recovery);
        self.charge_storage(&recovery.owner, before);
        recovery
    }
}
#[near]
impl Coordinator {
    #[payable]
    pub fn prepare_bitcoin_recovery(
        &mut self,
        recovery_id: String,
        operation_id: String,
        max_fee_atomic: U128,
    ) -> BitcoinSpend {
        Self::one_yocto();
        crate::config::valid_id(&operation_id);
        let mut recovery = self
            .bitcoin_recoveries
            .get(&recovery_id)
            .expect("RECOVERY_NOT_FOUND");
        assert_eq!(
            env::predecessor_account_id(),
            recovery.owner,
            "SOURCE_OWNER_REQUIRED"
        );
        if let Some(existing) = self.bitcoin_spends.get(&operation_id) {
            assert!(
                existing.recovery_id.as_ref() == Some(&recovery_id)
                    && existing.max_fee_atomic == max_fee_atomic,
                "IDEMPOTENCY_CONFLICT"
            );
            return existing;
        }
        assert!(
            !recovery.completed && !recovery.input.spent && recovery.input.reserved_by.is_none(),
            "RECOVERY_UNAVAILABLE"
        );
        assert!(
            max_fee_atomic.0 > 0
                && max_fee_atomic.0 <= recovery.manifest.max_network_cost_atomic.0
                && max_fee_atomic.0 + 294 <= u128::from(recovery.input.amount),
            "RECOVERY_FEE_LIMIT"
        );
        let before = env::storage_usage();
        recovery.input.reserved_by = Some(operation_id.clone());
        let spend = BitcoinSpend {
            operation_id: operation_id.clone(),
            settlement_id: None,
            recovery_id: Some(recovery_id.clone()),
            loan_id: recovery.loan_id.clone(),
            leg_id: recovery.leg_id.clone(),
            owner: recovery.owner.clone(),
            manifest: recovery.manifest.clone(),
            input: recovery.input.clone(),
            recipient_script: recovery.refund_script.clone(),
            amount_atomic: U128(u128::from(recovery.input.amount) - max_fee_atomic.0),
            max_fee_atomic,
            expires_at: Self::now() + 86_400,
            state: BitcoinSpendState::Prepared,
            attempts: vec![],
        };
        self.bitcoin_recoveries.insert(&recovery_id, &recovery);
        self.bitcoin_spends.insert(&operation_id, &spend);
        self.charge_storage(&recovery.owner, before);
        spend
    }
    pub fn get_bitcoin_recovery(&self, recovery_id: String) -> Option<BitcoinRecovery> {
        self.bitcoin_recoveries.get(&recovery_id)
    }
}
