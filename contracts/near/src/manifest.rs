use crate::{
    config::valid_id,
    math,
    state::{BasketLeg, Custody},
    Coordinator, CoordinatorExt,
};
use near_sdk::{env, json_types::U128, near};

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ChainFamily {
    Evm,
    Solana,
    Sui,
    Starknet,
    Bitcoin,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct ChainManifest {
    pub chain_id: String,
    pub version: u32,
    pub family: ChainFamily,
    pub network_fingerprint: String,
    pub vault: Vec<u8>,
    pub controller: Vec<u8>,
    pub controller_public_key: Vec<u8>,
    pub asset_id: String,
    pub asset_address: Vec<u8>,
    pub decimals: u8,
    pub max_collateral_atomic: U128,
    pub ltv_bps: u16,
    pub liquidation_threshold_bps: u16,
    pub mpc_account: near_sdk::AccountId,
    pub read_domain: u64,
    pub read_public_key: Vec<u8>,
    pub sign_domain: u64,
    pub derivation_path: String,
    pub minimum_confirmations: u64,
    pub initial_account_nonce: u64,
    pub max_gas: u64,
    pub max_fee_per_gas: U128,
    pub max_network_cost_atomic: U128,
    pub capability_evidence_hash: Vec<u8>,
    pub new_locks_enabled: bool,
    pub signing_enabled: bool,
}

#[near]
impl Coordinator {
    #[payable]
    pub fn register_chain_manifest(&mut self, manifest: ChainManifest) {
        Self::one_yocto();
        assert_eq!(
            env::predecessor_account_id(),
            self.config.owner,
            "OWNER_REQUIRED"
        );
        valid_id(&manifest.chain_id);
        valid_id(&manifest.asset_id);
        assert_ne!(manifest.asset_id, "near", "RESERVED_ASSET_IDENTIFIER");
        let expected = self.manifest_versions.get(&manifest.chain_id).unwrap_or(0) + 1;
        assert_eq!(manifest.version, expected, "MANIFEST_VERSION_CHANGED");
        assert!(
            manifest.read_public_key.len() == 64
                && manifest.capability_evidence_hash.len() == 32
                && manifest.capability_evidence_hash.iter().any(|b| *b != 0),
            "CAPABILITY_EVIDENCE_REQUIRED"
        );
        assert!(
            !manifest.network_fingerprint.is_empty()
                && manifest.network_fingerprint.len() <= 128
                && !manifest.derivation_path.is_empty()
                && manifest.derivation_path.len() <= 128,
            "INVALID_CHAIN_CONFIGURATION"
        );
        assert!(
            manifest.decimals <= 24
                && manifest.max_collateral_atomic.0 > 0
                && manifest.max_gas > 0
                && manifest.max_network_cost_atomic.0 > 0,
            "INVALID_ASSET_BOUNDS"
        );
        assert!(
            manifest.ltv_bps > 0
                && manifest.ltv_bps <= self.config.max_ltv_bps
                && manifest.liquidation_threshold_bps > manifest.ltv_bps
                && manifest.liquidation_threshold_bps <= self.config.max_liquidation_threshold_bps,
            "INVALID_ASSET_RISK"
        );
        let width = match manifest.family {
            ChainFamily::Evm => 20,
            ChainFamily::Bitcoin => 33,
            _ => 32,
        };
        assert!(
            manifest.controller.len() == width && manifest.controller.iter().any(|b| *b != 0),
            "INVALID_CONTROLLER"
        );
        match manifest.family {
            ChainFamily::Evm => {
                assert!(
                    matches!(
                        manifest.chain_id.as_str(),
                        "base" | "arbitrum" | "bnb" | "polygon" | "avalanche" | "hyperevm"
                    ),
                    "UNSUPPORTED_CHAIN"
                );
                assert_eq!(manifest.vault.len(), 20, "INVALID_VAULT");
                assert!(manifest.asset_address.is_empty(), "NATIVE_ASSET_REQUIRED");
                assert_eq!(manifest.decimals, 18, "INVALID_DECIMALS");
                assert_eq!(
                    manifest.controller_public_key.len(),
                    64,
                    "INVALID_SIGNING_KEY"
                );
                let hash = env::keccak256(&manifest.controller_public_key);
                assert_eq!(
                    &hash[12..],
                    manifest.controller.as_slice(),
                    "CONTROLLER_KEY_MISMATCH"
                );
                let expected = match manifest.chain_id.as_str() {
                    "base" => "84532",
                    "arbitrum" => "421614",
                    "bnb" => "97",
                    "polygon" => "80002",
                    "avalanche" => "43113",
                    _ => "998",
                };
                assert_eq!(manifest.network_fingerprint, expected, "WRONG_TESTNET");
            }
            ChainFamily::Solana => {
                assert_eq!(manifest.chain_id, "solana", "UNSUPPORTED_CHAIN");
                assert_eq!(manifest.vault.len(), 64, "INVALID_PROGRAM_CONFIGURATION");
                assert_eq!(manifest.decimals, 9, "INVALID_DECIMALS");
                let deployment = env::sha256(self.config.deployment_id.as_bytes());
                assert_eq!(
                    &manifest.vault[32..],
                    crate::mpc::pda(
                        &manifest.vault[..32],
                        &[b"config", &deployment, &manifest.controller]
                    ),
                    "CONFIG_PDA_MISMATCH"
                );
                assert_eq!(
                    manifest.controller_public_key, manifest.controller,
                    "CONTROLLER_KEY_MISMATCH"
                );
            }
            ChainFamily::Sui => {
                assert_eq!(manifest.chain_id, "sui", "UNSUPPORTED_CHAIN");
                assert_eq!(manifest.vault.len(), 64, "INVALID_PACKAGE_CONFIGURATION");
                assert_eq!(manifest.decimals, 9, "INVALID_DECIMALS");
                assert_eq!(
                    manifest.controller_public_key.len(),
                    32,
                    "INVALID_SIGNING_KEY"
                );
                let key = sui_sdk_types::Ed25519PublicKey::new(
                    manifest
                        .controller_public_key
                        .as_slice()
                        .try_into()
                        .expect("INVALID_SIGNING_KEY"),
                );
                assert_eq!(
                    key.derive_address().as_bytes(),
                    manifest.controller.as_slice(),
                    "CONTROLLER_ADDRESS_MISMATCH"
                );
            }
            ChainFamily::Starknet => {
                assert_eq!(manifest.chain_id, "starknet", "UNSUPPORTED_CHAIN");
                assert_eq!(manifest.vault.len(), 32, "INVALID_VAULT");
                assert_eq!(manifest.asset_address.len(), 32, "EXACT_TOKEN_REQUIRED");
                assert_eq!(manifest.decimals, 18, "INVALID_DECIMALS");
                for address in [
                    &manifest.vault,
                    &manifest.controller,
                    &manifest.asset_address,
                ] {
                    assert!(
                        address.iter().any(|b| *b != 0) && address[0] < 8,
                        "INVALID_STARKNET_ADDRESS"
                    );
                }
                assert_eq!(
                    manifest.controller_public_key.len(),
                    64,
                    "INVALID_SIGNING_KEY"
                );
                assert_eq!(manifest.network_fingerprint, "SN_SEPOLIA", "WRONG_TESTNET");
            }
            ChainFamily::Bitcoin => {
                assert_eq!(manifest.chain_id, "bitcoin", "UNSUPPORTED_CHAIN");
                assert_eq!(
                    manifest.network_fingerprint,
                    "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943",
                    "WRONG_TESTNET"
                );
                assert_eq!(manifest.decimals, 8, "INVALID_DECIMALS");
                assert!(manifest.minimum_confirmations > 0, "CONFIRMATIONS_REQUIRED");
                assert_eq!(
                    manifest.controller_public_key.len(),
                    33,
                    "INVALID_SIGNING_KEY"
                );
            }
        }
        assert!(
            manifest.family == ChainFamily::Starknet || manifest.asset_address.is_empty(),
            "NATIVE_ASSET_REQUIRED"
        );
        let before = env::storage_usage();
        let origin = env::sha256(
            near_sdk::borsh::to_vec(&(
                &manifest.chain_id,
                &manifest.family,
                &manifest.network_fingerprint,
                &manifest.asset_address,
                manifest.decimals,
            ))
            .unwrap(),
        );
        if let Some(existing) = self.asset_origins.get(&manifest.asset_id) {
            assert_eq!(existing, origin, "ASSET_IDENTITY_CHANGED");
        } else {
            self.asset_origins.insert(&manifest.asset_id, &origin);
        }
        let nonce_key = format!(
            "{}:{}",
            manifest.chain_id,
            hex::encode(&manifest.controller)
        );
        if matches!(manifest.family, ChainFamily::Evm | ChainFamily::Starknet)
            && self.account_nonce_next.get(&nonce_key).is_none()
        {
            self.account_nonce_next
                .insert(&nonce_key, &manifest.initial_account_nonce);
        }
        self.manifests
            .insert(&(manifest.chain_id.clone(), manifest.version), &manifest);
        self.manifest_versions
            .insert(&manifest.chain_id, &manifest.version);
        self.charge_storage(&self.config.owner.clone(), before);
    }
    pub fn get_chain_manifest(&self, chain_id: String, version: Option<u32>) -> ChainManifest {
        let version = version.unwrap_or_else(|| {
            self.manifest_versions
                .get(&chain_id)
                .expect("CHAIN_NOT_CONFIGURED")
        });
        self.manifests
            .get(&(chain_id, version))
            .expect("MANIFEST_NOT_FOUND")
    }
}
impl Coordinator {
    pub(crate) fn validate_leg(&self, leg: &BasketLeg, require_enabled: bool) {
        match &leg.custody {
            Custody::Near => assert_eq!(leg.asset_id, "near", "ASSET_CUSTODY_MISMATCH"),
            Custody::Remote {
                chain_id,
                manifest_version,
                lock_id,
                source_owner,
                release_recipient,
                min_price_atomic,
                max_price_atomic,
            } => {
                let manifest = self.get_chain_manifest(chain_id.clone(), Some(*manifest_version));
                if require_enabled {
                    assert!(
                        manifest.new_locks_enabled && manifest.signing_enabled,
                        "CHAIN_DISABLED"
                    );
                    if manifest.family == ChainFamily::Bitcoin {
                        assert!(
                            self.get_bitcoin_verifier(*manifest_version).is_some(),
                            "BITCOIN_VERIFIER_NOT_CONFIGURED"
                        );
                    } else {
                        assert_eq!(
                            self.verified_controllers
                                .get(&(chain_id.clone(), *manifest_version)),
                            Some(true),
                            "CONTROLLER_KEY_UNVERIFIED"
                        );
                    }
                    let current = self.get_chain_manifest(chain_id.clone(), None);
                    assert!(
                        current.new_locks_enabled && current.signing_enabled,
                        "CHAIN_DISABLED"
                    );
                }
                assert_eq!(manifest.asset_id, leg.asset_id, "ASSET_CUSTODY_MISMATCH");
                if matches!(
                    manifest.family,
                    ChainFamily::Solana | ChainFamily::Sui | ChainFamily::Bitcoin
                ) {
                    assert!(
                        leg.amount_atomic.0 <= u128::from(u64::MAX),
                        "SOURCE_AMOUNT_OVERFLOW"
                    );
                }
                assert!(
                    leg.amount_atomic.0 <= manifest.max_collateral_atomic.0,
                    "ASSET_EXPOSURE_LIMIT"
                );
                let width = match manifest.family {
                    ChainFamily::Evm => 20,
                    ChainFamily::Bitcoin => 22,
                    _ => 32,
                };
                assert!(
                    lock_id.len() == 32
                        && source_owner.len() == width
                        && release_recipient.len() == width
                        && release_recipient.iter().any(|b| *b != 0),
                    "INVALID_SOURCE_BINDING"
                );
                assert!(
                    min_price_atomic.0 > 0 && min_price_atomic.0 <= max_price_atomic.0,
                    "INVALID_PRICE_BOUNDS"
                );
                if require_enabled {
                    let price = self.asset_price(&leg.asset_id);
                    assert!(
                        price >= min_price_atomic.0 && price <= max_price_atomic.0,
                        "PRICE_OUT_OF_BOUNDS"
                    );
                }
            }
        }
    }
    pub(crate) fn leg_capacity(
        &self,
        leg: &BasketLeg,
        amount: u128,
        weight: u16,
        liquidation: bool,
    ) -> u128 {
        let (_decimals, weight) = match &leg.custody {
            Custody::Near => (24, weight),
            Custody::Remote {
                chain_id,
                manifest_version,
                ..
            } => {
                let m = self.get_chain_manifest(chain_id.clone(), Some(*manifest_version));
                let limit = if !liquidation {
                    m.ltv_bps
                } else {
                    m.liquidation_threshold_bps
                };
                (m.decimals, weight.min(limit))
            }
        };
        let value = self.leg_value(leg, amount);
        math::mul_div_floor(value, u128::from(weight), 10_000)
    }
    pub(crate) fn leg_value(&self, leg: &BasketLeg, amount: u128) -> u128 {
        let decimals = match &leg.custody {
            Custody::Near => 24,
            Custody::Remote {
                chain_id,
                manifest_version,
                ..
            } => {
                self.get_chain_manifest(chain_id.clone(), Some(*manifest_version))
                    .decimals
            }
        };
        math::mul_div_floor(
            amount,
            self.asset_price(&leg.asset_id),
            10_u128.pow(u32::from(decimals)),
        )
    }
}
