use crate::{
    collateral::bitcoin::{BitcoinRecovery, BitcoinSpend},
    manifest::{ChainFamily, ChainManifest},
    state::{Custody, Loan},
    Coordinator, CoordinatorExt,
};
use bitcoin::{consensus::deserialize, hashes::Hash, Transaction};
use near_sdk::{env, near, serde_json, AccountId, Gas, NearToken, Promise};

const VERIFIER_PREFIX: &[u8] = b"\0kanso:bitcoin-verifier:v1:";

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct BitcoinVerifier {
    pub account_id: AccountId,
    pub network_fingerprint: String,
    pub max_tip_age_seconds: u64,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct BitcoinInclusionProof {
    pub tx_id: String,
    pub tx_block_blockhash: String,
    pub tx_index: u64,
    pub merkle_proof: Vec<String>,
    pub coinbase_tx_id: String,
    pub coinbase_merkle_proof: Vec<String>,
}

#[near(serializers = [json])]
pub enum BitcoinProofAction {
    Lock {
        loan_id: String,
        leg_id: String,
        vout: u32,
    },
    Delivery {
        operation_id: String,
    },
    Recovery {
        recovery_id: String,
        loan_id: String,
        leg_id: String,
        vout: u32,
    },
}

#[near(serializers = [json])]
struct LightClientTip {
    block_header: TipHeader,
    block_height: u64,
}
#[near(serializers = [json])]
struct TipHeader {
    time: u64,
}

fn verifier_key(version: u32) -> Vec<u8> {
    [VERIFIER_PREFIX, &version.to_le_bytes()].concat()
}
fn hash(value: &str) -> [u8; 32] {
    assert!(value.len() == 64, "INVALID_BITCOIN_HASH");
    let mut bytes: [u8; 32] = hex::decode(value)
        .expect("INVALID_BITCOIN_HASH")
        .try_into()
        .expect("INVALID_BITCOIN_HASH");
    bytes.reverse();
    bytes
}

impl BitcoinInclusionProof {
    pub fn validate_transaction(&self, raw: &[u8]) -> Transaction {
        assert!(raw.len() <= 100_000, "BITCOIN_TX_TOO_LARGE");
        let tx: Transaction = deserialize(raw).expect("INVALID_BITCOIN_TRANSACTION");
        assert!(!tx.is_coinbase(), "COINBASE_COLLATERAL_UNSUPPORTED");
        assert_eq!(
            tx.compute_txid().to_byte_array(),
            hash(&self.tx_id),
            "TXID_MISMATCH"
        );
        let depth = self.merkle_proof.len();
        assert!(
            (1..=32).contains(&depth)
                && depth == self.coinbase_merkle_proof.len()
                && self.tx_index > 0
                && self.tx_index < (1_u64 << depth),
            "INVALID_BITCOIN_PROOF_DEPTH"
        );
        tx
    }
    pub fn borsh_args(&self, confirmations: u64) -> Vec<u8> {
        fn path(output: &mut Vec<u8>, hashes: &[String]) {
            output.extend_from_slice(&(hashes.len() as u32).to_le_bytes());
            for value in hashes {
                output.extend_from_slice(&hash(value));
            }
        }
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&hash(&self.tx_id));
        bytes.extend_from_slice(&hash(&self.tx_block_blockhash));
        bytes.extend_from_slice(&self.tx_index.to_le_bytes());
        path(&mut bytes, &self.merkle_proof);
        bytes.extend_from_slice(&hash(&self.coinbase_tx_id));
        path(&mut bytes, &self.coinbase_merkle_proof);
        bytes.extend_from_slice(&confirmations.to_le_bytes());
        bytes
    }
}

#[near]
impl Coordinator {
    #[payable]
    pub fn register_bitcoin_verifier(&mut self, manifest_version: u32, verifier: BitcoinVerifier) {
        Self::one_yocto();
        assert_eq!(
            env::predecessor_account_id(),
            self.config.owner,
            "OWNER_REQUIRED"
        );
        let manifest = self.get_chain_manifest("bitcoin".into(), Some(manifest_version));
        assert_eq!(
            manifest.family,
            ChainFamily::Bitcoin,
            "BITCOIN_MANIFEST_REQUIRED"
        );
        assert_eq!(
            verifier.network_fingerprint, manifest.network_fingerprint,
            "BITCOIN_NETWORK_MISMATCH"
        );
        assert_ne!(
            verifier.account_id,
            env::current_account_id(),
            "INVALID_BITCOIN_VERIFIER"
        );
        assert!(
            (1_200..=86_400).contains(&verifier.max_tip_age_seconds),
            "INVALID_TIP_MAX_AGE"
        );
        if let Some(existing) = self.get_bitcoin_verifier(manifest_version) {
            assert_eq!(existing, verifier, "BITCOIN_VERIFIER_IMMUTABLE");
            return;
        }
        let before = env::storage_usage();
        // Separate storage preserves deployed loans, manifests and the coordinator root layout.
        env::storage_write(
            &verifier_key(manifest_version),
            &near_sdk::borsh::to_vec(&verifier).unwrap(),
        );
        self.charge_storage(&self.config.owner.clone(), before);
    }
    pub fn get_bitcoin_verifier(&self, manifest_version: u32) -> Option<BitcoinVerifier> {
        env::storage_read(&verifier_key(manifest_version)).map(|bytes| {
            near_sdk::borsh::from_slice(&bytes).expect("INVALID_BITCOIN_VERIFIER_STATE")
        })
    }
    #[payable]
    pub fn submit_bitcoin_lock(
        &mut self,
        loan_id: String,
        leg_id: String,
        proof: BitcoinInclusionProof,
        raw_transaction: Vec<u8>,
        vout: u32,
    ) -> Promise {
        Self::one_yocto();
        let action = BitcoinProofAction::Lock {
            loan_id,
            leg_id,
            vout,
        };
        self.verify_bitcoin(action, proof, raw_transaction)
    }
    #[payable]
    pub fn submit_bitcoin_delivery(
        &mut self,
        operation_id: String,
        proof: BitcoinInclusionProof,
        raw_transaction: Vec<u8>,
    ) -> Promise {
        Self::one_yocto();
        self.verify_bitcoin(
            BitcoinProofAction::Delivery { operation_id },
            proof,
            raw_transaction,
        )
    }
    #[payable]
    pub fn register_bitcoin_recovery(
        &mut self,
        recovery_id: String,
        loan_id: String,
        leg_id: String,
        proof: BitcoinInclusionProof,
        raw_transaction: Vec<u8>,
        vout: u32,
    ) -> Promise {
        Self::one_yocto();
        crate::config::valid_id(&recovery_id);
        self.verify_bitcoin(
            BitcoinProofAction::Recovery {
                recovery_id,
                loan_id,
                leg_id,
                vout,
            },
            proof,
            raw_transaction,
        )
    }
    #[private]
    pub fn complete_bitcoin_verification(
        &mut self,
        action: BitcoinProofAction,
        raw_transaction: Vec<u8>,
        payer: AccountId,
    ) -> serde_json::Value {
        assert_eq!(env::promise_results_count(), 2, "INVALID_CALLBACK");
        let verified = env::promise_result_checked(0, 64).expect("BITCOIN_INCLUSION_FAILED");
        assert_eq!(
            serde_json::from_slice::<bool>(&verified).ok(),
            Some(true),
            "BITCOIN_INCLUSION_FAILED"
        );
        let bytes = env::promise_result_checked(1, 4096).expect("BITCOIN_TIP_UNAVAILABLE");
        let tip: LightClientTip = serde_json::from_slice(&bytes).expect("INVALID_BITCOIN_TIP");
        let manifest = self.bitcoin_proof_manifest(&action, &payer);
        let verifier = self
            .get_bitcoin_verifier(manifest.version)
            .expect("BITCOIN_VERIFIER_NOT_CONFIGURED");
        let now = Self::now();
        assert!(
            tip.block_height > 0 && tip.block_header.time <= now.saturating_add(7_200),
            "INVALID_BITCOIN_TIP"
        );
        assert!(
            tip.block_header
                .time
                .saturating_add(verifier.max_tip_age_seconds)
                >= now,
            "BITCOIN_LIGHT_CLIENT_STALE"
        );
        let tx: Transaction = deserialize(&raw_transaction).expect("INVALID_BITCOIN_TRANSACTION");
        match action {
            BitcoinProofAction::Lock {
                loan_id,
                leg_id,
                vout,
            } => {
                let result: Loan = self.apply_bitcoin_lock(loan_id, leg_id, &tx, vout, &payer);
                serde_json::to_value(result).unwrap()
            }
            BitcoinProofAction::Delivery { operation_id } => {
                let result: BitcoinSpend = self.apply_bitcoin_delivery(operation_id, &tx);
                serde_json::to_value(result).unwrap()
            }
            BitcoinProofAction::Recovery {
                recovery_id,
                loan_id,
                leg_id,
                vout,
            } => {
                let result: BitcoinRecovery =
                    self.apply_bitcoin_recovery(recovery_id, loan_id, leg_id, &tx, vout, &payer);
                serde_json::to_value(result).unwrap()
            }
        }
    }
}

impl Coordinator {
    fn bitcoin_proof_manifest(
        &self,
        action: &BitcoinProofAction,
        payer: &AccountId,
    ) -> ChainManifest {
        let (loan_id, leg_id) = match action {
            BitcoinProofAction::Lock {
                loan_id, leg_id, ..
            } => (loan_id, leg_id),
            BitcoinProofAction::Recovery {
                loan_id, leg_id, ..
            } => (loan_id, leg_id),
            BitcoinProofAction::Delivery { operation_id } => {
                return self
                    .bitcoin_spends
                    .get(operation_id)
                    .expect("BITCOIN_SPEND_NOT_FOUND")
                    .manifest
            }
        };
        let loan = self.loan(loan_id);
        let lock = loan
            .locks
            .iter()
            .find(|l| &l.leg.leg_id == leg_id)
            .expect("LEG_NOT_FOUND");
        if matches!(action, BitcoinProofAction::Recovery { .. }) {
            assert_eq!(payer, &lock.leg.owner, "SOURCE_OWNER_REQUIRED");
        }
        let Custody::Remote {
            chain_id,
            manifest_version,
            ..
        } = &lock.leg.custody
        else {
            panic!("BITCOIN_LEG_REQUIRED")
        };
        assert_eq!(chain_id, "bitcoin", "BITCOIN_LEG_REQUIRED");
        self.get_chain_manifest(chain_id.clone(), Some(*manifest_version))
    }
    fn verify_bitcoin(
        &self,
        action: BitcoinProofAction,
        proof: BitcoinInclusionProof,
        raw_transaction: Vec<u8>,
    ) -> Promise {
        let payer = env::predecessor_account_id();
        let manifest = self.bitcoin_proof_manifest(&action, &payer);
        let verifier = self
            .get_bitcoin_verifier(manifest.version)
            .expect("BITCOIN_VERIFIER_NOT_CONFIGURED");
        proof.validate_transaction(&raw_transaction);
        let inclusion = Promise::new(verifier.account_id.clone()).function_call(
            "verify_transaction_inclusion_v2",
            proof.borsh_args(manifest.minimum_confirmations),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(45),
        );
        let tip = Promise::new(verifier.account_id).function_call(
            "get_last_block_header",
            b"{}".to_vec(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(5),
        );
        inclusion.and(tip).then(Promise::new(env::current_account_id()).function_call(
            "complete_bitcoin_verification", serde_json::to_vec(&serde_json::json!({"action":action,"raw_transaction":raw_transaction,"payer":payer})).unwrap(), NearToken::from_yoctonear(0), Gas::from_tgas(180),
        ))
    }
}
