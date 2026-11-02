use kanso::collateral_vault::{
    Command, Deposit, ICollateralVaultDispatcher, ICollateralVaultDispatcherTrait,
};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp,
    start_cheat_caller_address, start_cheat_chain_id_global, stop_cheat_caller_address,
};
use starknet::{ContractAddress, SyscallResultTrait};

#[starknet::interface]
trait ITestToken<T> {
    fn mint(ref self: T, owner: ContractAddress, amount: u256);
    fn balance_of(self: @T, owner: ContractAddress) -> u256;
    fn transfer(ref self: T, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: T, sender: ContractAddress, recipient: ContractAddress, amount: u256,
    ) -> bool;
    fn approve(ref self: T, spender: ContractAddress, amount: u256);
}
#[starknet::contract]
mod TestToken {
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::{ContractAddress, get_caller_address};
    #[storage]
    struct Storage {
        balances: Map<ContractAddress, u256>,
        allowances: Map<(ContractAddress, ContractAddress), u256>,
    }
    #[abi(embed_v0)]
    impl TokenImpl of super::ITestToken<ContractState> {
        fn mint(ref self: ContractState, owner: ContractAddress, amount: u256) {
            self.balances.write(owner, self.balances.read(owner) + amount);
        }
        fn balance_of(self: @ContractState, owner: ContractAddress) -> u256 {
            self.balances.read(owner)
        }
        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            let sender = get_caller_address();
            self.balances.write(sender, self.balances.read(sender) - amount);
            self.balances.write(recipient, self.balances.read(recipient) + amount);
            true
        }
        fn transfer_from(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) -> bool {
            let key = (sender, get_caller_address());
            self.allowances.write(key, self.allowances.read(key) - amount);
            self.balances.write(sender, self.balances.read(sender) - amount);
            self.balances.write(recipient, self.balances.read(recipient) + amount);
            true
        }
        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) {
            self.allowances.write((get_caller_address(), spender), amount);
        }
    }
}
fn deploy(name: ByteArray, args: Array<felt252>) -> ContractAddress {
    let class = declare(name).unwrap_syscall().contract_class();
    let (address, _) = class.deploy(@args).unwrap_syscall();
    address
}
fn setup() -> (ICollateralVaultDispatcher, ITestTokenDispatcher) {
    start_cheat_chain_id_global('SN_SEPOLIA');
    let token = deploy("TestToken", array![]);
    let vault = deploy("CollateralVault", array![0xD, 'SN_SEPOLIA', 0xC, token.into()]);
    let token = ITestTokenDispatcher { contract_address: token };
    let vault = ICollateralVaultDispatcher { contract_address: vault };
    token.mint(0xB.try_into().unwrap(), 1000);
    start_cheat_caller_address(token.contract_address, 0xB.try_into().unwrap());
    token.approve(vault.contract_address, 1000);
    stop_cheat_caller_address(token.contract_address);
    start_cheat_caller_address(vault.contract_address, 0xB.try_into().unwrap());
    vault
        .deposit(
            Deposit {
                lock_id: 1,
                agreement: 2,
                borrower: 0xB,
                leg_id: 3,
                refund_recipient: 0xB.try_into().unwrap(),
                purpose: 0,
                amount: 1000,
            },
        );
    start_cheat_caller_address(vault.contract_address, 0xC.try_into().unwrap());
    (vault, token)
}
fn release(id: felt252, amount: u128, nonce: u64) -> Command {
    Command {
        operation_id: id,
        lock_id: 1,
        agreement: 2,
        settlement_id: 0,
        recipient: 0xB.try_into().unwrap(),
        amount,
        nonce,
        deadline: 600,
        kind: 0,
    }
}
#[test]
fn partial_sale_and_release_deliver_exact_strk() {
    let (vault, token) = setup();
    let mut sale = release(11, 300, 0);
    sale.kind = 1;
    sale.settlement_id = 55;
    sale.recipient = 0x5.try_into().unwrap();
    vault.execute(sale);
    assert(token.balance_of(0x5.try_into().unwrap()) == 300, 'WRONG_DELIVERY');
    vault.execute(release(12, 700, 1));
    assert(vault.get_lock(1).remaining == 0, 'REMAINING');
    assert(vault.accounted_balance() == 0, 'ACCOUNTING');
}
#[test]
#[should_panic(expected: 'UNAUTHORIZED')]
fn borrower_cannot_withdraw() {
    let (vault, _) = setup();
    start_cheat_caller_address(vault.contract_address, 0xB.try_into().unwrap());
    vault.execute(release(11, 1000, 0));
}
#[test]
#[should_panic(expected: 'DUPLICATE_OPERATION')]
fn duplicate_operation_cannot_spend() {
    let (vault, _) = setup();
    vault.execute(release(11, 100, 0));
    vault.execute(release(11, 100, 1));
}
#[test]
#[should_panic(expected: 'WRONG_NONCE')]
fn invalidation_consumes_the_source_nonce() {
    let (vault, _) = setup();
    let mut invalidation = release(11, 0, 0);
    invalidation.kind = 2;
    invalidation.recipient = 0.try_into().unwrap();
    vault.execute(invalidation);
    assert(vault.get_lock(1).remaining == 1000, 'BALANCE_CHANGED');
    vault.execute(release(12, 1000, 0));
}
#[test]
#[should_panic(expected: 'EXPIRED')]
fn source_clock_rejects_expired_release() {
    let (vault, _) = setup();
    start_cheat_block_timestamp(vault.contract_address, 601);
    vault.execute(release(11, 1000, 0));
}
#[test]
#[should_panic(expected: 'WRONG_LOCK')]
fn agreement_cannot_be_rebound() {
    let (vault, _) = setup();
    let mut command = release(11, 1000, 0);
    command.agreement = 99;
    vault.execute(command);
}
#[test]
#[should_panic(expected: 'INSUFFICIENT_COLLATERAL')]
fn another_lock_cannot_cover_an_overspend() {
    let (vault, _) = setup();
    vault.execute(release(11, 1001, 0));
}
