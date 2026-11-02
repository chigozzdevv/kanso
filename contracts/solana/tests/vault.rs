use borsh::{to_vec, BorshDeserialize};
use kanso_solana_vault::{
    instruction::{Command, VaultInstruction},
    state::{Config, Lock, Receipt},
};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
};
use solana_signer::Signer;
use solana_system_interface::program::ID as SYSTEM;
use solana_transaction::Transaction;

struct Fixture {
    svm: LiteSVM,
    program: Pubkey,
    borrower: Keypair,
    controller: Keypair,
    config: Pubkey,
    lock: Pubkey,
    recipient: Pubkey,
}
impl Fixture {
    fn new() -> Self {
        Self::with_prefund(false)
    }
    fn with_prefund(prefund: bool) -> Self {
        let mut svm = LiteSVM::new();
        let program = Pubkey::new_unique();
        let borrower = Keypair::new();
        let controller = Keypair::new();
        let recipient = Pubkey::new_unique();
        svm.add_program_from_file(
            program,
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/deploy/kanso_solana_vault.so"),
        )
        .expect("build the Solana program before running tests");
        svm.airdrop(&borrower.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&controller.pubkey(), 1_000_000_000).unwrap();
        svm.airdrop(&recipient, 1_000_000).unwrap();
        let deployment = [7; 32];
        let (config, _) = Pubkey::find_program_address(
            &[b"config", &deployment, controller.pubkey().as_ref()],
            &program,
        );
        let (lock, _) =
            Pubkey::find_program_address(&[b"lock", config.as_ref(), &[1; 32]], &program);
        let mut f = Self {
            svm,
            program,
            borrower,
            controller,
            config,
            lock,
            recipient,
        };
        if prefund {
            f.svm.airdrop(&config, 1).unwrap();
            f.svm.airdrop(&lock, 1).unwrap();
        }
        let init = f.ix(
            vec![
                AccountMeta::new(config, false),
                AccountMeta::new(f.borrower.pubkey(), true),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            VaultInstruction::Initialize {
                deployment,
                network: [9; 32],
                controller: f.controller.pubkey().to_bytes(),
            },
        );
        f.borrower_tx(init).unwrap();
        let deposit = f.deposit();
        f.borrower_tx(deposit).unwrap();
        f
    }
    fn ix(&self, accounts: Vec<AccountMeta>, instruction: VaultInstruction) -> Instruction {
        Instruction {
            program_id: self.program,
            accounts,
            data: to_vec(&instruction).unwrap(),
        }
    }
    fn borrower_tx(&mut self, ix: Instruction) -> Result<(), String> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(
            &[ix],
            Some(&self.borrower.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let tx = Transaction::new(&[&self.borrower], msg, self.svm.latest_blockhash());
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    }
    fn controller_tx(&mut self, command: Command, use_borrower: bool) -> Result<(), String> {
        let (receipt, _) = Pubkey::find_program_address(
            &[b"receipt", self.config.as_ref(), &command.operation_id],
            &self.program,
        );
        let signer = if use_borrower {
            &self.borrower
        } else {
            &self.controller
        };
        let recipient = Pubkey::new_from_array(command.recipient);
        let ix = self.ix(
            vec![
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(self.lock, false),
                AccountMeta::new(receipt, false),
                AccountMeta::new_readonly(signer.pubkey(), true),
                AccountMeta::new(signer.pubkey(), true),
                AccountMeta::new(recipient, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            VaultInstruction::Execute(command),
        );
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(
            &[ix],
            Some(&signer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let tx = Transaction::new(&[signer], msg, self.svm.latest_blockhash());
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    }
    fn deposit(&self) -> Instruction {
        self.ix(
            vec![
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(self.lock, false),
                AccountMeta::new(self.borrower.pubkey(), true),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            VaultInstruction::Deposit {
                lock_id: [1; 32],
                agreement: [2; 32],
                borrower: [3; 32],
                leg_id: [4; 32],
                refund_recipient: self.borrower.pubkey().to_bytes(),
                purpose: 0,
                amount: 1_000_000_000,
            },
        )
    }
    fn command(&self, id: u8, amount: u64, nonce: u64) -> Command {
        Command {
            operation_id: [id; 32],
            lock_id: [1; 32],
            agreement: [2; 32],
            settlement_id: [0; 32],
            recipient: self.recipient.to_bytes(),
            amount,
            nonce,
            deadline: u64::MAX,
            kind: 0,
            max_receipt_rent: 10_000_000,
        }
    }
    fn locked(&self) -> Lock {
        Lock::try_from_slice(&self.svm.get_account(&self.lock).unwrap().data).unwrap()
    }
}
#[test]
fn native_custody_executes_and_leaves_rent_and_an_immutable_receipt() {
    let mut f = Fixture::new();
    let before = f.svm.get_balance(&f.recipient).unwrap();
    let rent = f.svm.get_balance(&f.lock).unwrap() - 1_000_000_000;
    let mut sale = f.command(11, 300_000_000, 0);
    sale.kind = 1;
    sale.settlement_id = [55; 32];
    f.controller_tx(sale, false).unwrap();
    assert_eq!(f.locked().remaining, 700_000_000);
    assert_eq!(
        f.svm.get_balance(&f.recipient).unwrap(),
        before + 300_000_000
    );
    f.controller_tx(f.command(12, 700_000_000, 1), false)
        .unwrap();
    assert_eq!(f.locked().remaining, 0);
    assert_eq!(f.svm.get_balance(&f.lock).unwrap(), rent);
    let (address, _) =
        Pubkey::find_program_address(&[b"receipt", f.config.as_ref(), &[11; 32]], &f.program);
    let receipt = Receipt::try_from_slice(&f.svm.get_account(&address).unwrap().data).unwrap();
    assert_eq!(receipt.amount, 300_000_000);
    assert_eq!(receipt.nonce, 0);
    assert_eq!(receipt.remaining, 700_000_000);
}
#[test]
fn borrower_has_no_release_authority() {
    let mut f = Fixture::new();
    assert!(f
        .controller_tx(f.command(11, 1_000_000_000, 0), true)
        .is_err());
    assert_eq!(f.locked().remaining, 1_000_000_000);
}
#[test]
fn duplicate_receipt_and_stale_nonce_cannot_spend_again() {
    let mut f = Fixture::new();
    f.controller_tx(f.command(11, 100, 0), false).unwrap();
    assert!(f.controller_tx(f.command(11, 100, 1), false).is_err());
    assert!(f.controller_tx(f.command(12, 100, 0), false).is_err());
    assert_eq!(f.locked().remaining, 999_999_900);
}
#[test]
fn source_nonce_invalidation_preserves_collateral() {
    let mut f = Fixture::new();
    let mut command = f.command(11, 0, 0);
    command.kind = 2;
    command.recipient = [0; 32];
    f.controller_tx(command, false).unwrap();
    assert_eq!(f.locked().remaining, 1_000_000_000);
    assert!(f.controller_tx(f.command(12, 100, 0), false).is_err());
}
#[test]
fn wrong_agreement_and_overspend_roll_back() {
    let mut f = Fixture::new();
    let mut command = f.command(11, 100, 0);
    command.agreement = [99; 32];
    assert!(f.controller_tx(command, false).is_err());
    assert!(f
        .controller_tx(f.command(12, 1_000_000_001, 0), false)
        .is_err());
    assert_eq!(f.locked().nonce, 0);
}
#[test]
fn duplicate_deposit_cannot_replace_verified_lock() {
    let mut f = Fixture::new();
    assert!(f.borrower_tx(f.deposit()).is_err());
    assert_eq!(f.locked().deposited, 1_000_000_000);
}
#[test]
fn state_serialization_has_fixed_receipt_and_lock_sizes() {
    assert_eq!(
        to_vec(&Config {
            tag: Config::TAG,
            deployment: [1; 32],
            network: [2; 32],
            controller: [3; 32]
        })
        .unwrap()
        .len(),
        Config::SIZE
    );
    let f = Fixture::new();
    assert_eq!(to_vec(&f.locked()).unwrap().len(), Lock::SIZE);
}

#[test]
fn dust_prefunding_cannot_block_config_deposits_or_command_receipts() {
    let mut f = Fixture::with_prefund(true);
    let (receipt, _) =
        Pubkey::find_program_address(&[b"receipt", f.config.as_ref(), &[11; 32]], &f.program);
    f.svm.airdrop(&receipt, 1).unwrap();
    f.controller_tx(f.command(11, 100, 0), false).unwrap();
    assert_eq!(f.locked().remaining, 999_999_900);
}
