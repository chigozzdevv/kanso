use crate::{
    state::{Transfer, TransferKind, TransferOutcome},
    Coordinator, CoordinatorExt,
};
use near_sdk::{env, near};
#[near(serializers=[borsh,json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct RecoveryPolicy {
    pub public_keys: Vec<Vec<u8>>,
    pub threshold: u8,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct OutcomeAttestation {
    pub transfer_id: String,
    pub succeeded: bool,
    pub receipt_id: Vec<u8>,
    pub finalized_block_hash: Vec<u8>,
    pub finalized_block_height: u64,
    pub observed_at: u64,
    pub signatures: Vec<OutcomeSignature>,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct OutcomeSignature {
    pub key_index: u8,
    pub signature: Vec<u8>,
}

#[near]
impl Coordinator {
    #[payable]
    pub fn configure_recovery(&mut self, policy: RecoveryPolicy) {
        Self::one_yocto();
        assert_eq!(
            env::predecessor_account_id(),
            self.config.owner,
            "OWNER_REQUIRED"
        );
        assert_eq!(self.transfer_count, 0, "RECOVERY_POLICY_FROZEN");
        assert!(
            !policy.public_keys.is_empty()
                && policy.public_keys.len() <= 16
                && policy.threshold > 0
                && usize::from(policy.threshold) <= policy.public_keys.len(),
            "INVALID_RECOVERY_THRESHOLD"
        );
        for (index, key) in policy.public_keys.iter().enumerate() {
            assert!(
                key.len() == 32
                    && key.iter().any(|b| *b != 0)
                    && !policy.public_keys[..index].contains(key),
                "INVALID_RECOVERY_KEY"
            );
        }
        let before = env::storage_usage();
        self.recovery_policy = Some(policy);
        self.charge_storage(&self.config.owner.clone(), before);
    }
    pub fn recovery_message(&self, attestation: OutcomeAttestation) -> Vec<u8> {
        let transfer = self
            .transfers
            .get(&attestation.transfer_id)
            .expect("TRANSFER_NOT_FOUND");
        self.outcome_message(&transfer, &attestation)
    }
    pub fn recover_transfer_outcome(&mut self, attestation: OutcomeAttestation) -> Transfer {
        let policy = self
            .recovery_policy
            .as_ref()
            .expect("RECOVERY_NOT_CONFIGURED");
        let mut transfer = self
            .transfers
            .get(&attestation.transfer_id)
            .expect("TRANSFER_NOT_FOUND");
        assert!(
            attestation.receipt_id.len() == 32
                && attestation.finalized_block_hash.len() == 32
                && attestation.finalized_block_height > 0
                && attestation.observed_at >= transfer.committed_at
                && attestation.observed_at <= Self::now(),
            "INVALID_FINALIZED_OUTCOME"
        );
        assert!(
            attestation.signatures.len() <= policy.public_keys.len(),
            "TOO_MANY_SIGNATURES"
        );
        let message = self.outcome_message(&transfer, &attestation);
        let mut seen = Vec::new();
        for signed in &attestation.signatures {
            assert!(
                !seen.contains(&signed.key_index),
                "DUPLICATE_RECOVERY_SIGNER"
            );
            let key = policy
                .public_keys
                .get(usize::from(signed.key_index))
                .expect("UNKNOWN_RECOVERY_SIGNER");
            let key: [u8; 32] = key.as_slice().try_into().unwrap();
            let signature: [u8; 64] = signed
                .signature
                .as_slice()
                .try_into()
                .expect("INVALID_RECOVERY_SIGNATURE");
            assert!(
                env::ed25519_verify(&signature, &message, &key),
                "INVALID_RECOVERY_SIGNATURE"
            );
            seen.push(signed.key_index);
        }
        assert!(
            seen.len() >= usize::from(policy.threshold),
            "RECOVERY_QUORUM_REQUIRED"
        );
        let outcome = if attestation.succeeded {
            TransferOutcome::Succeeded
        } else {
            TransferOutcome::Failed
        };
        if transfer.outcome != TransferOutcome::Unknown {
            assert_eq!(transfer.outcome, outcome, "CONFLICTING_TRANSFER_OUTCOME");
            return transfer;
        }
        transfer.outcome = outcome;
        transfer.observed_at = attestation.observed_at;
        self.transfers.insert(&transfer.transfer_id, &transfer);
        transfer
    }
    pub fn get_recovery_policy(&self) -> Option<RecoveryPolicy> {
        self.recovery_policy.clone()
    }
}
impl Coordinator {
    fn outcome_message(&self, transfer: &Transfer, a: &OutcomeAttestation) -> Vec<u8> {
        let token = if matches!(
            transfer.kind,
            TransferKind::Disbursement | TransferKind::LpWithdrawal | TransferKind::Refund
        ) {
            self.config.settlement_token.as_str()
        } else {
            "near"
        };
        near_sdk::borsh::to_vec(&(
            "kanso:near-transfer-outcome:v1",
            &self.config.deployment_id,
            env::current_account_id(),
            token,
            &transfer.transfer_id,
            &transfer.kind,
            &transfer.recipient,
            transfer.amount_atomic.0,
            transfer.committed_at,
            a.succeeded,
            &a.receipt_id,
            &a.finalized_block_hash,
            a.finalized_block_height,
            a.observed_at,
        ))
        .unwrap()
    }
}
