use near_sdk::{json_types::U128, near, AccountId};

use crate::{config::Network, math};

// Bound the work required to price all live receivables at an LP share checkpoint.
pub const MAX_POOL_LOANS: usize = 32;

#[near(serializers = [borsh,json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct AssetCap {
    pub asset_id: String,
    pub max_collateral_value_atomic: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct PoolPolicy {
    pub version: u32,
    pub apr_bps: u16,
    pub origination_fee_atomic: U128,
    pub min_principal_atomic: U128,
    pub max_principal_atomic: U128,
    pub max_duration_seconds: u64,
    pub setup_duration_seconds: u64,
    pub grace_seconds: u64,
    pub interest_buffer_seconds: u64,
    pub ltv_bps: u16,
    pub liquidation_threshold_bps: u16,
    pub min_liquidity_atomic: U128,
    pub withdrawal_health_ppm: u32,
    pub min_conditional_trigger_health_ppm: u32,
    pub max_liquidation_surplus_atomic: U128,
    pub recovery_health_ppm: u32,
    pub max_execution_cost_bps: u16,
    pub max_slippage_bps: u16,
    pub max_execution_cost_atomic: U128,
    pub eligible_assets: Vec<String>,
    pub asset_caps: Vec<AssetCap>,
    pub max_outstanding_principal_atomic: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Pool {
    pub pool_id: String,
    pub manager: AccountId,
    pub policy: PoolPolicy,
    pub cash_atomic: U128,
    pub reserved_atomic: U128,
    pub in_flight_atomic: U128,
    pub total_shares: U128,
    pub pending_withdrawal: bool,
    pub recognized_loss_atomic: U128,
    pub loan_ids: Vec<String>,
    #[serde(with = "decimal_u64")]
    pub revision: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Position {
    pub shares: U128,
    pub reserved_shares: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(tag = "family", rename_all = "snake_case", deny_unknown_fields)]
pub enum Custody {
    Near,
    Remote {
        chain_id: String,
        manifest_version: u32,
        lock_id: Vec<u8>,
        source_owner: Vec<u8>,
        release_recipient: Vec<u8>,
        min_price_atomic: U128,
        max_price_atomic: U128,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct BasketLeg {
    pub asset_id: String,
    pub custody: Custody,
    pub leg_id: String,
    pub owner: AccountId,
    pub amount_atomic: U128,
    pub release_recipient: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct Offer {
    pub deployment_id: String,
    pub network: Network,
    pub offer_id: String,
    pub pool_id: String,
    pub borrower: AccountId,
    pub payout_account: AccountId,
    pub policy_version: u32,
    pub principal_atomic: U128,
    pub apr_bps: u16,
    pub duration_seconds: u64,
    pub origination_fee_atomic: U128,
    pub expires_at: u64,
    pub setup_deadline: u64,
    pub min_price_atomic: U128,
    pub max_price_atomic: U128,
    pub legs: Vec<BasketLeg>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LockPurpose {
    Collateral,
    Payment {
        payment_id: String,
        payer: AccountId,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Lock {
    pub purpose: LockPurpose,
    pub agreement: Vec<u8>,
    pub leg: BasketLeg,
    pub locked_atomic: U128,
    pub reserved_atomic: U128,
    pub accepted: bool,
    pub receipt_verified: bool,
    pub remote_nonce: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum LoanState {
    PendingFunding,
    Active,
    Repaid,
    Cancelled,
    WrittenOff,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SetupState {
    Reserved,
    Locking,
    Ready,
    Funding,
    Funded,
    Aborting,
    Aborted,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Loan {
    pub loan_id: String,
    pub offer_hash: Vec<u8>,
    pub offer: Offer,
    pub policy: PoolPolicy,
    pub state: LoanState,
    pub setup_state: SetupState,
    pub locks: Vec<Lock>,
    pub principal_outstanding_atomic: U128,
    pub interest_atomic: U128,
    pub interest_remainder: u64,
    pub fees_due_atomic: U128,
    pub started_at: u64,
    pub last_accrued_at: u64,
    pub matures_at: u64,
    pub active_outflow: Option<String>,
    pub recovery_outflows: Vec<String>,
    pub written_off_atomic: U128,
    #[serde(with = "decimal_u64")]
    pub revision: u64,
}

impl Loan {
    pub fn accrue(&mut self, now: u64) {
        if self.state != LoanState::Active {
            return;
        }
        assert!(now >= self.last_accrued_at, "CLOCK_REGRESSION");
        let (increment, remainder) = math::interest(
            self.principal_outstanding_atomic.0,
            self.offer.apr_bps,
            now - self.last_accrued_at,
            self.interest_remainder,
        );
        self.interest_atomic.0 += increment;
        self.interest_remainder = remainder;
        self.last_accrued_at = now;
    }

    pub fn interest_due(&self) -> u128 {
        self.interest_atomic.0 + u128::from(self.interest_remainder > 0)
    }

    pub fn debt(&self) -> u128 {
        self.principal_outstanding_atomic.0 + self.interest_due() + self.fees_due_atomic.0
    }

    pub fn track_outflow(&mut self, id: String) {
        assert!(!self.has_outflow(&id), "OUTFLOW_ALREADY_TRACKED");
        if self.active_outflow.is_none() {
            self.active_outflow = Some(id);
        } else {
            assert!(self.recovery_outflows.len() < 15, "OUTFLOW_LIMIT");
            self.recovery_outflows.push(id);
        }
    }
    pub fn has_outflow(&self, id: &str) -> bool {
        self.active_outflow.as_deref() == Some(id) || self.recovery_outflows.iter().any(|i| i == id)
    }
    pub fn resolve_outflow(&mut self, id: &str) {
        assert!(self.has_outflow(id), "OUTFLOW_IDENTITY_MISMATCH");
        if self.active_outflow.as_deref() == Some(id) {
            self.active_outflow = if self.recovery_outflows.is_empty() {
                None
            } else {
                Some(self.recovery_outflows.remove(0))
            };
        } else {
            self.recovery_outflows.retain(|i| i != id);
        }
    }

    pub fn custody_resolved(&self) -> bool {
        self.locks
            .iter()
            .all(|lock| lock.locked_atomic.0 == 0 && lock.reserved_atomic.0 == 0)
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum TransferKind {
    Disbursement,
    CollateralRelease,
    LpWithdrawal,
    StorageWithdrawal,
    SettlementDelivery,
    Refund,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum TransferOutcome {
    Unknown,
    Succeeded,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Transfer {
    pub transfer_id: String,
    pub kind: TransferKind,
    pub owner: AccountId,
    pub object_id: String,
    pub leg_id: String,
    pub recipient: AccountId,
    pub amount_atomic: U128,
    pub outcome: TransferOutcome,
    pub finalized: bool,
    pub committed_at: u64,
    pub observed_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Withdrawal {
    pub withdrawal_id: String,
    pub pool_id: String,
    pub owner: AccountId,
    pub shares: U128,
    pub state: WithdrawalState,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum WithdrawalState {
    Requested,
    Pending,
    Paid,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct Price {
    pub price_atomic: U128,
    pub confidence_bps: u16,
    pub published_at: u64,
    pub sequence: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PaymentIntent {
    PoolDeposit {
        pool_id: String,
        operation_id: String,
    },
    SolverEscrow {
        operation_id: String,
    },
    Repayment {
        loan_id: String,
        operation_id: String,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PaymentReceipt {
    pub intent: PaymentIntent,
    pub amount_atomic: U128,
    pub used_atomic: U128,
}

mod decimal_u64 {
    use near_sdk::serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(near_sdk::serde::de::Error::custom)
    }
}
