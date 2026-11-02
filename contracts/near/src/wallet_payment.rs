use crate::{
    config::valid_id,
    state::{BasketLeg, LoanState, Lock, LockPurpose, Transfer},
    Coordinator, CoordinatorExt,
};
use near_sdk::{env, json_types::U128, near, AccountId};

#[near]
impl Coordinator {
    pub fn wallet_payment_leg_id(
        &self,
        loan_id: String,
        payer: AccountId,
        payment_id: String,
    ) -> String {
        hex::encode(env::sha256(
            near_sdk::borsh::to_vec(&(
                "kanso:wallet-payment:v1",
                &self.config.deployment_id,
                loan_id,
                payer,
                payment_id,
            ))
            .unwrap(),
        ))
    }
    #[payable]
    pub fn create_wallet_payment(
        &mut self,
        loan_id: String,
        payment_id: String,
        leg: BasketLeg,
    ) -> Lock {
        Self::one_yocto();
        valid_id(&payment_id);
        let payer = env::predecessor_account_id();
        let mut loan = self.loan(&loan_id);
        let leg_id = self.wallet_payment_leg_id(loan_id.clone(), payer.clone(), payment_id.clone());
        assert_eq!(leg.leg_id, leg_id, "PAYMENT_LEG_ID_MISMATCH");
        assert_eq!(leg.owner, payer, "PAYER_REQUIRED");
        assert!(leg.amount_atomic.0 > 0, "ZERO_PAYMENT");
        self.validate_leg(&leg, true);
        let agreement = env::sha256(
            near_sdk::borsh::to_vec(&(
                "kanso:payment-commitment:v1",
                &self.config.deployment_id,
                &loan_id,
                &payer,
                &payment_id,
                &leg,
            ))
            .unwrap(),
        );
        if let Some(existing) = loan.locks.iter().find(|l| l.leg.leg_id == leg_id) {
            assert_eq!(existing.agreement, agreement, "IDEMPOTENCY_CONFLICT");
            return existing.clone();
        }
        assert_eq!(loan.state, LoanState::Active, "LOAN_NOT_ACTIVE");
        assert!(loan.locks.len() < 16, "BASKET_LEG_LIMIT");
        let before = env::storage_usage();
        let lock = Lock {
            purpose: LockPurpose::Payment {
                payment_id,
                payer: payer.clone(),
            },
            agreement,
            leg,
            locked_atomic: U128(0),
            reserved_atomic: U128(0),
            accepted: false,
            receipt_verified: false,
            remote_nonce: 0,
        };
        loan.locks.push(lock.clone());
        loan.revision += 1;
        self.loans.insert(&loan_id, &loan);
        self.charge_storage(&payer, before);
        lock
    }
    #[payable]
    pub fn refund_native_wallet_payment(
        &mut self,
        loan_id: String,
        leg_id: String,
        transfer_id: String,
    ) -> Transfer {
        Self::one_yocto();
        let mut loan = self.loan(&loan_id);
        let lock = loan
            .locks
            .iter()
            .find(|l| l.leg.leg_id == leg_id)
            .expect("PAYMENT_NOT_FOUND");
        let LockPurpose::Payment { payer, .. } = &lock.purpose else {
            panic!("WALLET_PAYMENT_REQUIRED")
        };
        assert_eq!(env::predecessor_account_id(), *payer, "PAYER_REQUIRED");
        let amount = lock.locked_atomic;
        if let Some(existing) = self.transfers.get(&transfer_id) {
            self.check_transfer_identity(
                &existing,
                crate::state::TransferKind::CollateralRelease,
                payer,
                &loan_id,
                &leg_id,
            );
            return existing;
        }
        self.reserve_native_release(&mut loan, &leg_id, amount, &transfer_id, false)
    }
}
