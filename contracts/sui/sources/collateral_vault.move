module kanso::collateral_vault;

use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::sui::SUI;
use sui::table::{Self, Table};

const EConfiguration: u64 = 1;
const EDeposit: u64 = 2;
const EDuplicate: u64 = 3;
const EUnauthorized: u64 = 4;
const ECommand: u64 = 5;
const ENonce: u64 = 6;
const EExpired: u64 = 7;
const EBalance: u64 = 8;

public struct Vault has key {
    id: UID,
    deployment: address,
    network: address,
    controller: address,
    locks: Table<address, Lock>,
    executed: Table<address, bool>,
    accounted_balance: u64,
}

public struct Lock has store {
    agreement: address,
    borrower: address,
    leg_id: address,
    owner: address,
    refund_recipient: address,
    purpose: u8,
    deposited: u64,
    balance: Balance<SUI>,
    nonce: u64,
}

public struct LockAccepted has copy, drop {
    vault: ID,
    deployment: address,
    network: address,
    lock_id: address,
    agreement: address,
    borrower: address,
    leg_id: address,
    owner: address,
    refund_recipient: address,
    purpose: u8,
    amount: u64,
}

public struct CommandExecuted has copy, drop {
    vault: ID,
    deployment: address,
    network: address,
    operation_id: address,
    lock_id: address,
    agreement: address,
    settlement_id: address,
    recipient: address,
    amount: u64,
    remaining: u64,
    nonce: u64,
    kind: u8,
}

public fun create(deployment: address, network: address, controller: address, ctx: &mut TxContext) {
    assert!(deployment != @0x0 && network != @0x0 && controller != @0x0, EConfiguration);
    transfer::share_object(Vault {
        id: object::new(ctx), deployment, network, controller,
        locks: table::new(ctx), executed: table::new(ctx), accounted_balance: 0,
    });
}

public fun deposit(
    vault: &mut Vault, lock_id: address, agreement: address, borrower: address,
    leg_id: address, refund_recipient: address, purpose: u8, collateral: Coin<SUI>, ctx: &TxContext,
) {
    let amount = collateral.value();
    assert!(lock_id != @0x0 && agreement != @0x0 && borrower != @0x0 && leg_id != @0x0
        && refund_recipient != @0x0 && purpose <= 1 && amount > 0, EDeposit);
    assert!(!vault.locks.contains(lock_id), EDuplicate);
    let owner = ctx.sender();
    vault.locks.add(lock_id, Lock {agreement, borrower, leg_id, owner, refund_recipient,
        purpose, deposited: amount, balance: collateral.into_balance(), nonce: 0});
    vault.accounted_balance = vault.accounted_balance + amount;
    event::emit(LockAccepted {vault: object::id(vault), deployment: vault.deployment, network: vault.network,
        lock_id, agreement, borrower, leg_id, owner, refund_recipient, purpose, amount});
}

public fun execute(
    vault: &mut Vault, clock: &Clock, operation_id: address, lock_id: address,
    agreement: address, settlement_id: address, recipient: address, amount: u64,
    nonce: u64, deadline_seconds: u64, kind: u8, ctx: &mut TxContext,
) {
    assert!(ctx.sender() == vault.controller, EUnauthorized);
    assert!(!vault.executed.contains(operation_id), EDuplicate);
    assert!(operation_id != @0x0 && kind <= 2, ECommand);
    assert!(clock.timestamp_ms() / 1000 <= deadline_seconds, EExpired);
    let locked = &mut vault.locks[lock_id];
    assert!(agreement == locked.agreement, ECommand);
    assert!(nonce == locked.nonce, ENonce);
    if (kind == 2) {
        assert!(amount == 0 && recipient == @0x0 && settlement_id == @0x0, ECommand);
    } else {
        assert!(amount > 0 && recipient != @0x0 && (kind == 1) == (settlement_id != @0x0), ECommand);
        assert!(amount <= locked.balance.value(), EBalance);
    };
    locked.nonce = locked.nonce + 1;
    let output = locked.balance.split(amount);
    let remaining = locked.balance.value();
    vault.accounted_balance = vault.accounted_balance - amount;
    vault.executed.add(operation_id, true);
    if (amount > 0) { transfer::public_transfer(coin::from_balance(output, ctx), recipient); }
    else { output.destroy_zero(); };
    event::emit(CommandExecuted {vault: object::id(vault), deployment: vault.deployment, network: vault.network,
        operation_id, lock_id, agreement, settlement_id, recipient, amount, remaining, nonce, kind});
}

public fun remaining(vault: &Vault, lock_id: address): u64 {vault.locks[lock_id].balance.value()}
public fun nonce(vault: &Vault, lock_id: address): u64 {vault.locks[lock_id].nonce}
public fun accounted_balance(vault: &Vault): u64 {vault.accounted_balance}
public fun controller(vault: &Vault): address {vault.controller}
public fun is_executed(vault: &Vault, operation_id: address): bool {vault.executed.contains(operation_id)}
public fun deposit_terms(vault: &Vault, lock_id: address): (address, address, address, address, address, u8, u64) {
    let locked = &vault.locks[lock_id];
    (locked.agreement, locked.borrower, locked.leg_id, locked.owner, locked.refund_recipient, locked.purpose, locked.deposited)
}
