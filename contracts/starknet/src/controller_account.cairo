use starknet::account::Call;
use starknet::{ClassHash, ContractAddress};

#[starknet::interface]
pub trait IControllerAccount<T> {
    fn __validate__(ref self: T, calls: Array<Call>) -> felt252;
    fn __execute__(ref self: T, calls: Array<Call>) -> Array<Span<felt252>>;
    fn __validate_deploy__(
        self: @T,
        class_hash: felt252,
        salt: felt252,
        public_key_x: u256,
        public_key_y: u256,
        vault_class: ClassHash,
        deployment: felt252,
        vault_salt: felt252,
        token: ContractAddress,
        chain_id: felt252,
    ) -> felt252;
    fn get_vault(self: @T) -> ContractAddress;
    fn __validate_declare__(self: @T, class_hash: felt252) -> felt252;
}

#[starknet::contract(account)]
pub mod ControllerAccount {
    use core::num::traits::Zero;
    use starknet::account::Call;
    use starknet::secp256_trait::{Secp256Trait, is_valid_signature};
    use starknet::secp256k1::Secp256k1Point;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{
        ClassHash, ContractAddress, SyscallResultTrait, VALIDATED, get_caller_address,
        get_contract_address, get_tx_info,
    };
    #[storage]
    struct Storage {
        public_key_x: u256,
        public_key_y: u256,
        vault: ContractAddress,
        chain_id: felt252,
    }
    #[constructor]
    fn constructor(
        ref self: ContractState,
        public_key_x: u256,
        public_key_y: u256,
        vault_class: ClassHash,
        deployment: felt252,
        vault_salt: felt252,
        token: ContractAddress,
        chain_id: felt252,
    ) {
        assert(
            !vault_class.is_zero()
                && deployment != 0
                && !token.is_zero()
                && chain_id != 0
                && chain_id == get_tx_info().unbox().chain_id,
            'INVALID_CONFIG',
        );
        assert(
            Secp256Trait::<Secp256k1Point>::secp256_ec_new_syscall(public_key_x, public_key_y)
                .unwrap_syscall()
                .is_some(),
            'INVALID_KEY',
        );
        let (vault, _) = starknet::syscalls::deploy_syscall(
            vault_class,
            vault_salt,
            array![deployment, chain_id, get_contract_address().into(), token.into()].span(),
            false,
        )
            .unwrap_syscall();
        self.public_key_x.write(public_key_x);
        self.public_key_y.write(public_key_y);
        self.vault.write(vault);
        self.chain_id.write(chain_id);
    }
    fn check_signature(self: @ContractState) {
        let info = get_tx_info().unbox();
        assert(info.chain_id == self.chain_id.read(), 'WRONG_CHAIN');
        assert(
            info.version == 3 || info.version == 0x100000000000000000000000000000003, 'V3_REQUIRED',
        );
        assert(info.signature.len() == 4, 'INVALID_SIGNATURE');
        let r = u256 {
            low: (*info.signature.at(0)).try_into().unwrap(),
            high: (*info.signature.at(1)).try_into().unwrap(),
        };
        let s = u256 {
            low: (*info.signature.at(2)).try_into().unwrap(),
            high: (*info.signature.at(3)).try_into().unwrap(),
        };
        assert(s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0, 'HIGH_S');
        let key = Secp256Trait::<
            Secp256k1Point,
        >::secp256_ec_new_syscall(self.public_key_x.read(), self.public_key_y.read())
            .unwrap_syscall()
            .unwrap();
        assert(
            is_valid_signature::<Secp256k1Point>(info.transaction_hash.into(), r, s, key),
            'INVALID_SIGNATURE',
        );
    }
    fn check_calls(self: @ContractState, calls: @Array<Call>) {
        assert(calls.len() == 1, 'ONE_COMMAND_REQUIRED');
        let call = calls.at(0);
        assert(
            *call.to == self.vault.read() && *call.selector == selector!("execute"), 'COMMAND_ONLY',
        );
    }
    #[abi(embed_v0)]
    impl AccountImpl of super::IControllerAccount<ContractState> {
        fn get_vault(self: @ContractState) -> ContractAddress {
            self.vault.read()
        }
        fn __validate__(ref self: ContractState, calls: Array<Call>) -> felt252 {
            check_calls(@self, @calls);
            check_signature(@self);
            VALIDATED
        }
        fn __execute__(ref self: ContractState, calls: Array<Call>) -> Array<Span<felt252>> {
            assert(get_caller_address().is_zero(), 'PROTOCOL_ONLY');
            check_calls(@self, @calls);
            check_signature(@self);
            let call = calls.at(0);
            array![
                starknet::syscalls::call_contract_syscall(*call.to, *call.selector, *call.calldata)
                    .unwrap_syscall()
            ]
        }
        fn __validate_deploy__(
            self: @ContractState,
            class_hash: felt252,
            salt: felt252,
            public_key_x: u256,
            public_key_y: u256,
            vault_class: ClassHash,
            deployment: felt252,
            vault_salt: felt252,
            token: ContractAddress,
            chain_id: felt252,
        ) -> felt252 {
            assert(
                class_hash != 0
                    && public_key_x == self.public_key_x.read()
                    && public_key_y == self.public_key_y.read()
                    && !self.vault.read().is_zero()
                    && !vault_class.is_zero()
                    && deployment != 0
                    && !token.is_zero()
                    && chain_id == self.chain_id.read(),
                'WRONG_DEPLOYMENT',
            );
            check_signature(self);
            VALIDATED
        }
        fn __validate_declare__(self: @ContractState, class_hash: felt252) -> felt252 {
            assert(false, 'DECLARATION_DISABLED');
            0
        }
    }
}
