use near_sdk::{
    env,
    json_types::U128,
    near,
    serde_json::{self, json},
    AccountId,
};

use crate::{
    config::valid_id,
    events, math,
    state::{LoanState, PaymentIntent, PaymentReceipt},
    Coordinator, CoordinatorExt,
};

#[near]
impl Coordinator {
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        assert_eq!(
            env::predecessor_account_id(),
            self.config.settlement_token,
            "SETTLEMENT_TOKEN_REQUIRED"
        );
        assert!(amount.0 > 0, "ZERO_PAYMENT");
        let intent: PaymentIntent = serde_json::from_str(&msg).expect("INVALID_PAYMENT_MESSAGE");
        let operation_id = match &intent {
            PaymentIntent::PoolDeposit { operation_id, .. }
            | PaymentIntent::Repayment { operation_id, .. }
            | PaymentIntent::SolverEscrow { operation_id } => operation_id,
        };
        valid_id(operation_id);
        let key = (sender_id.clone(), operation_id.clone());
        if let Some(receipt) = self.payments.get(&key) {
            assert!(
                receipt.intent == intent && receipt.amount_atomic == amount,
                "IDEMPOTENCY_CONFLICT"
            );
            return amount;
        }
        let before = env::storage_usage();
        let used = match &intent {
            PaymentIntent::SolverEscrow { operation_id } => {
                self.fund_escrow(operation_id, &sender_id, amount.0)
            }
            PaymentIntent::PoolDeposit { pool_id, .. } => {
                self.apply_pool_deposit(pool_id, &sender_id, amount.0, operation_id)
            }
            PaymentIntent::Repayment { loan_id, .. } => {
                self.apply_repayment(loan_id, amount.0, operation_id)
            }
        };
        if used == 0 {
            return amount;
        }
        self.payments.insert(
            &key,
            &PaymentReceipt {
                intent,
                amount_atomic: amount,
                used_atomic: U128(used),
            },
        );
        self.charge_storage(&sender_id, before);
        U128(amount.0 - used)
    }

    pub fn get_payment(
        &self,
        sender_id: AccountId,
        operation_id: String,
    ) -> Option<PaymentReceipt> {
        self.payments.get(&(sender_id, operation_id))
    }
}

impl Coordinator {
    fn apply_pool_deposit(
        &mut self,
        pool_id: &str,
        owner: &AccountId,
        amount: u128,
        operation_id: &str,
    ) -> u128 {
        let mut pool = self.pool(pool_id);
        assert!(!pool.pending_withdrawal, "POOL_WITHDRAWAL_PENDING");
        let nav = self.nav(&pool);
        let shares = if pool.total_shares.0 == 0 {
            assert_eq!(nav, 0, "EMPTY_POOL_INVARIANT");
            amount
        } else {
            assert!(nav > 0, "POOL_INSOLVENT");
            math::mul_div_floor(amount, pool.total_shares.0, nav)
        };
        if shares == 0 {
            return 0;
        }
        let key = (pool_id.to_owned(), owner.clone());
        let mut position = self.positions.get(&key).unwrap_or_default();
        position.shares.0 += shares;
        pool.total_shares.0 += shares;
        pool.cash_atomic.0 += amount;
        pool.revision += 1;
        self.positions.insert(&key, &position);
        self.pools.insert(&pool.pool_id, &pool);
        events::emit(
            &self.config.deployment_id,
            "PoolDepositApplied",
            pool_id,
            pool.revision,
            json!({"operation_id": operation_id, "pool_id": pool_id, "owner": owner, "amount_atomic": U128(amount), "shares": U128(shares), "revision": pool.revision.to_string()}),
        );
        amount
    }

    pub(crate) fn apply_repayment(
        &mut self,
        loan_id: &str,
        amount: u128,
        operation_id: &str,
    ) -> u128 {
        let mut loan = self.loan(loan_id);
        if loan.state == LoanState::Repaid {
            return 0;
        }
        assert_eq!(loan.state, LoanState::Active, "LOAN_NOT_ACTIVE");
        loan.accrue(Self::now());
        let used = amount.min(loan.debt());
        let mut remaining = used;
        let fees = remaining.min(loan.fees_due_atomic.0);
        loan.fees_due_atomic.0 -= fees;
        remaining -= fees;
        let interest = remaining.min(loan.interest_due());
        if interest == loan.interest_due() {
            loan.interest_atomic.0 = 0;
            loan.interest_remainder = 0;
        } else {
            loan.interest_atomic.0 -= interest;
        }
        remaining -= interest;
        loan.principal_outstanding_atomic.0 -= remaining;
        let mut pool = self.pool(&loan.offer.pool_id);
        pool.cash_atomic.0 += used;
        pool.revision += 1;
        if loan.debt() == 0 {
            loan.state = LoanState::Repaid;
            pool.loan_ids.retain(|id| id != loan_id);
        }
        loan.revision += 1;
        self.loans.insert(&loan.loan_id, &loan);
        self.pools.insert(&pool.pool_id, &pool);
        events::emit(
            &self.config.deployment_id,
            "RepaymentApplied",
            loan_id,
            loan.revision,
            json!({"operation_id": operation_id, "loan_id": loan_id, "amount_atomic": U128(used), "fees_atomic": U128(fees), "interest_atomic": U128(interest), "principal_atomic": U128(remaining), "revision": loan.revision.to_string()}),
        );
        used
    }
}
