use starknet::ContractAddress;

#[derive(Drop, Copy, Serde, starknet::Store)]
pub struct Lock {
    pub agreement: felt252,
    pub borrower: felt252,
    pub leg_id: felt252,
    pub owner: ContractAddress,
    pub refund_recipient: ContractAddress,
    pub purpose: u8,
    pub deposited: u128,
    pub remaining: u128,
    pub nonce: u64,
    pub exists: bool,
}
#[derive(Drop, Copy, Serde)]
pub struct Deposit {
    pub lock_id: felt252,
    pub agreement: felt252,
    pub borrower: felt252,
    pub leg_id: felt252,
    pub refund_recipient: ContractAddress,
    pub purpose: u8,
    pub amount: u128,
}
#[derive(Drop, Copy, Serde)]
pub struct Command {
    pub operation_id: felt252,
    pub lock_id: felt252,
    pub agreement: felt252,
    pub settlement_id: felt252,
    pub recipient: ContractAddress,
    pub amount: u128,
    pub nonce: u64,
    pub deadline: u64,
    pub kind: u8,
}
#[starknet::interface]
pub trait IERC20<T> {
    fn balance_of(self: @T, account: ContractAddress) -> u256;
    fn transfer(ref self: T, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: T, sender: ContractAddress, recipient: ContractAddress, amount: u256,
    ) -> bool;
}
#[starknet::interface]
pub trait ICollateralVault<T> {
    fn deposit(ref self: T, deposit: Deposit);
    fn execute(ref self: T, command: Command);
    fn get_lock(self: @T, lock_id: felt252) -> Lock;
    fn get_config(self: @T) -> (felt252, felt252, ContractAddress, ContractAddress);
    fn accounted_balance(self: @T) -> u128;
    fn is_executed(self: @T, operation_id: felt252) -> bool;
}

#[starknet::contract]
pub mod CollateralVault {
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{
        ContractAddress, get_block_timestamp, get_caller_address, get_contract_address, get_tx_info,
    };
    use super::{Command, Deposit, IERC20Dispatcher, IERC20DispatcherTrait, Lock};
    #[storage]
    struct Storage {
        deployment: felt252,
        chain_id: felt252,
        controller: ContractAddress,
        token: ContractAddress,
        locks: Map<felt252, Lock>,
        executed: Map<felt252, bool>,
        accounted: u128,
        entered: bool,
    }
    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        LockAccepted: LockAccepted,
        CommandExecuted: CommandExecuted,
    }
    #[derive(Drop, starknet::Event)]
    struct LockAccepted {
        #[key]
        lock_id: felt252,
        #[key]
        agreement: felt252,
        #[key]
        borrower: felt252,
        deployment: felt252,
        leg_id: felt252,
        owner: ContractAddress,
        refund_recipient: ContractAddress,
        asset: ContractAddress,
        amount: u128,
        purpose: u8,
    }
    #[derive(Drop, starknet::Event)]
    struct CommandExecuted {
        #[key]
        operation_id: felt252,
        #[key]
        lock_id: felt252,
        #[key]
        agreement: felt252,
        deployment: felt252,
        settlement_id: felt252,
        recipient: ContractAddress,
        amount: u128,
        remaining: u128,
        nonce: u64,
        kind: u8,
    }
    #[constructor]
    fn constructor(
        ref self: ContractState,
        deployment: felt252,
        chain_id: felt252,
        controller: ContractAddress,
        token: ContractAddress,
    ) {
        assert(
            deployment != 0 && chain_id != 0 && !controller.is_zero() && !token.is_zero(),
            'INVALID_CONFIG',
        );
        assert(get_tx_info().unbox().chain_id == chain_id, 'WRONG_CHAIN');
        self.deployment.write(deployment);
        self.chain_id.write(chain_id);
        self.controller.write(controller);
        self.token.write(token);
    }
    #[abi(embed_v0)]
    impl VaultImpl of super::ICollateralVault<ContractState> {
        fn get_config(
            self: @ContractState,
        ) -> (felt252, felt252, ContractAddress, ContractAddress) {
            (
                self.deployment.read(),
                self.chain_id.read(),
                self.controller.read(),
                self.token.read(),
            )
        }
        fn deposit(ref self: ContractState, deposit: Deposit) {
            assert(!self.entered.read(), 'REENTRANT');
            self.entered.write(true);
            assert(get_tx_info().unbox().chain_id == self.chain_id.read(), 'WRONG_CHAIN');
            assert(
                deposit.lock_id != 0
                    && deposit.agreement != 0
                    && deposit.borrower != 0
                    && deposit.leg_id != 0
                    && deposit.amount > 0
                    && deposit.purpose <= 1,
                'INVALID_DEPOSIT',
            );
            assert(
                !deposit.refund_recipient.is_zero()
                    && deposit.refund_recipient != get_contract_address(),
                'INVALID_RECIPIENT',
            );
            assert(!self.locks.read(deposit.lock_id).exists, 'DUPLICATE_LOCK');
            let owner = get_caller_address();
            let token = IERC20Dispatcher { contract_address: self.token.read() };
            let vault = get_contract_address();
            let before = token.balance_of(vault);
            assert(token.transfer_from(owner, vault, deposit.amount.into()), 'TRANSFER_FAILED');
            assert(token.balance_of(vault) - before == deposit.amount.into(), 'INCORRECT_RECEIPT');
            self
                .locks
                .write(
                    deposit.lock_id,
                    Lock {
                        agreement: deposit.agreement,
                        borrower: deposit.borrower,
                        leg_id: deposit.leg_id,
                        owner,
                        refund_recipient: deposit.refund_recipient,
                        purpose: deposit.purpose,
                        deposited: deposit.amount,
                        remaining: deposit.amount,
                        nonce: 0,
                        exists: true,
                    },
                );
            self.accounted.write(self.accounted.read() + deposit.amount);
            self
                .emit(
                    LockAccepted {
                        lock_id: deposit.lock_id,
                        agreement: deposit.agreement,
                        borrower: deposit.borrower,
                        deployment: self.deployment.read(),
                        leg_id: deposit.leg_id,
                        owner,
                        refund_recipient: deposit.refund_recipient,
                        asset: self.token.read(),
                        amount: deposit.amount,
                        purpose: deposit.purpose,
                    },
                );
            self.entered.write(false);
        }
        fn execute(ref self: ContractState, command: Command) {
            assert(get_caller_address() == self.controller.read(), 'UNAUTHORIZED');
            assert(get_tx_info().unbox().chain_id == self.chain_id.read(), 'WRONG_CHAIN');
            assert(!self.entered.read(), 'REENTRANT');
            self.entered.write(true);
            assert(!self.executed.read(command.operation_id), 'DUPLICATE_OPERATION');
            assert(command.operation_id != 0 && command.kind <= 2, 'INVALID_COMMAND');
            assert(get_block_timestamp() <= command.deadline, 'EXPIRED');
            let mut locked = self.locks.read(command.lock_id);
            assert(locked.exists && locked.agreement == command.agreement, 'WRONG_LOCK');
            assert(locked.nonce == command.nonce, 'WRONG_NONCE');
            if command.kind == 2 {
                assert(
                    command.amount == 0
                        && command.recipient.is_zero()
                        && command.settlement_id == 0,
                    'INVALID_INVALIDATION',
                );
            } else {
                assert(
                    command.amount > 0
                        && !command.recipient.is_zero()
                        && command.recipient != get_contract_address()
                        && (command.kind == 1) == (command.settlement_id != 0),
                    'INVALID_COMMAND',
                );
                assert(command.amount <= locked.remaining, 'INSUFFICIENT_COLLATERAL');
            }
            locked.remaining -= command.amount;
            locked.nonce += 1;
            self.locks.write(command.lock_id, locked);
            self.executed.write(command.operation_id, true);
            self.accounted.write(self.accounted.read() - command.amount);
            if command.amount > 0 {
                let token = IERC20Dispatcher { contract_address: self.token.read() };
                let vault = get_contract_address();
                let before = token.balance_of(vault);
                let recipient_before = token.balance_of(command.recipient);
                assert(token.transfer(command.recipient, command.amount.into()), 'TRANSFER_FAILED');
                assert(
                    before
                        - token.balance_of(vault) == command.amount.into()
                            && token.balance_of(command.recipient)
                        - recipient_before == command.amount.into(),
                    'INCORRECT_DELIVERY',
                );
            }
            self
                .emit(
                    CommandExecuted {
                        operation_id: command.operation_id,
                        lock_id: command.lock_id,
                        agreement: command.agreement,
                        deployment: self.deployment.read(),
                        settlement_id: command.settlement_id,
                        recipient: command.recipient,
                        amount: command.amount,
                        remaining: locked.remaining,
                        nonce: command.nonce,
                        kind: command.kind,
                    },
                );
            self.entered.write(false);
        }
        fn get_lock(self: @ContractState, lock_id: felt252) -> Lock {
            self.locks.read(lock_id)
        }
        fn accounted_balance(self: @ContractState) -> u128 {
            self.accounted.read()
        }
        fn is_executed(self: @ContractState, operation_id: felt252) -> bool {
            self.executed.read(operation_id)
        }
    }
}
