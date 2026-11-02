use kanso::collateral_vault::{ICollateralVaultDispatcher, ICollateralVaultDispatcherTrait};
use kanso::controller_account::{IControllerAccountDispatcher, IControllerAccountDispatcherTrait};
use snforge_std::signature::secp256k1_curve::{
    Secp256k1CurveKeyPair, Secp256k1CurveKeyPairImpl, Secp256k1CurveSignerImpl,
};
use snforge_std::signature::{KeyPairTrait, SignerTrait};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_chain_id_global,
    start_cheat_signature, start_cheat_transaction_hash, start_cheat_transaction_version_global,
};
use starknet::SyscallResultTrait;
use starknet::account::Call;
use starknet::secp256_trait::Secp256PointTrait;

fn setup() -> IControllerAccountDispatcher {
    start_cheat_chain_id_global('SN_SEPOLIA');
    start_cheat_transaction_version_global(3);
    let pair: Secp256k1CurveKeyPair = KeyPairTrait::from_secret_key(7_u256);
    let (x, y) = pair.public_key.get_coordinates().unwrap_syscall();
    let mut args = array![];
    x.serialize(ref args);
    y.serialize(ref args);
    let vault = declare("CollateralVault").unwrap_syscall().contract_class();
    args.append((*vault.class_hash).into());
    args.append(0xD);
    args.append(0x42);
    args.append(0x456);
    args.append('SN_SEPOLIA');
    let class = declare("ControllerAccount").unwrap_syscall().contract_class();
    let (address, _) = class.deploy(@args).unwrap_syscall();
    let hash: felt252 = 0xabc;
    let (r, mut s) = pair.sign(hash.into()).unwrap();
    let order: u256 = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    if s > order / 2 {
        s = order - s;
    }
    start_cheat_transaction_hash(address, hash);
    start_cheat_signature(
        address, array![r.low.into(), r.high.into(), s.low.into(), s.high.into()].span(),
    );
    IControllerAccountDispatcher { contract_address: address }
}
fn command(to: felt252, selector: felt252) -> Array<Call> {
    array![Call { to: to.try_into().unwrap(), selector, calldata: array![1, 2, 3].span() }]
}
#[test]
fn validates_actual_secp256k1_signature_over_starknet_transaction_hash() {
    let account = setup();
    assert(
        account
            .__validate__(
                command(account.get_vault().into(), selector!("execute")),
            ) == starknet::VALIDATED,
        'NOT_VALIDATED',
    );
}
#[test]
#[should_panic(expected: 'INVALID_SIGNATURE')]
fn backend_cannot_substitute_the_transaction_hash() {
    let account = setup();
    start_cheat_transaction_hash(account.contract_address, 0xdef);
    account.__validate__(command(account.get_vault().into(), selector!("execute")));
}
#[test]
#[should_panic(expected: 'COMMAND_ONLY')]
fn key_cannot_sign_arbitrary_contract_calls() {
    let account = setup();
    account.__validate__(command(0x999, selector!("execute")));
}
#[test]
#[should_panic(expected: 'COMMAND_ONLY')]
fn key_cannot_call_an_unapproved_vault_entrypoint() {
    let account = setup();
    account.__validate__(command(account.get_vault().into(), selector!("deposit")));
}
#[test]
#[should_panic(expected: 'ONE_COMMAND_REQUIRED')]
fn account_rejects_hidden_batch_calls() {
    let account = setup();
    let mut calls = command(account.get_vault().into(), selector!("execute"));
    calls
        .append(
            Call {
                to: account.get_vault(), selector: selector!("execute"), calldata: array![].span(),
            },
        );
    account.__validate__(calls);
}
#[test]
#[should_panic(expected: 'DECLARATION_DISABLED')]
fn account_has_no_declaration_escape_hatch() {
    let account = setup();
    account.__validate_declare__(1);
}

#[test]
fn constructor_creates_a_vault_bound_to_the_controller() {
    let account = setup();
    let vault = account.get_vault();
    assert(vault != account.contract_address, 'SELF_VAULT');
    let config = ICollateralVaultDispatcher { contract_address: vault }.get_config();
    assert(config.0 == 0xD && config.1 == 'SN_SEPOLIA', 'WRONG_DOMAIN');
    assert(config.2 == account.contract_address, 'WRONG_CONTROLLER');
    assert(config.3 == 0x456.try_into().unwrap(), 'WRONG_TOKEN');
}
