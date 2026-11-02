// Generated from contract artifacts and source by codegen.ts.
export const evm_vault_abi = [
  {
    type: 'constructor',
    inputs: [
      {
        name: 'deployment_',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'networkId_',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'controller_',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'asset_',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'accountedBalance',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'asset',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'controller',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'deployment',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'depositNative',
    inputs: [
      {
        name: 'deposit',
        type: 'tuple',
        internalType: 'struct ICollateralVault.Deposit',
        components: [
          {
            name: 'lockId',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'agreement',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'borrower',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'legId',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'refundRecipient',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'purpose',
            type: 'uint8',
            internalType: 'enum ICollateralVault.Purpose',
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'depositToken',
    inputs: [
      {
        name: 'deposit',
        type: 'tuple',
        internalType: 'struct ICollateralVault.Deposit',
        components: [
          {
            name: 'lockId',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'agreement',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'borrower',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'legId',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'refundRecipient',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'purpose',
            type: 'uint8',
            internalType: 'enum ICollateralVault.Purpose',
          },
        ],
      },
      {
        name: 'amount',
        type: 'uint128',
        internalType: 'uint128',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'execute',
    inputs: [
      {
        name: 'command',
        type: 'tuple',
        internalType: 'struct ICollateralVault.Command',
        components: [
          {
            name: 'operationId',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'lockId',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'agreement',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'settlementId',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'recipient',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'amount',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'nonce',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'deadline',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'kind',
            type: 'uint8',
            internalType: 'enum ICollateralVault.CommandKind',
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'executed',
    inputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getLock',
    inputs: [
      {
        name: 'lockId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct ICollateralVault.Lock',
        components: [
          {
            name: 'agreement',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'borrower',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'legId',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'owner',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'refundRecipient',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'purpose',
            type: 'uint8',
            internalType: 'enum ICollateralVault.Purpose',
          },
          {
            name: 'deposited',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'remaining',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'nonce',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'exists',
            type: 'bool',
            internalType: 'bool',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'networkId',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'CommandExecuted',
    inputs: [
      {
        name: 'operationId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'lockId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'agreement',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'deployment',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'settlementId',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'recipient',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint128',
        indexed: false,
        internalType: 'uint128',
      },
      {
        name: 'remaining',
        type: 'uint128',
        indexed: false,
        internalType: 'uint128',
      },
      {
        name: 'nonce',
        type: 'uint64',
        indexed: false,
        internalType: 'uint64',
      },
      {
        name: 'kind',
        type: 'uint8',
        indexed: false,
        internalType: 'enum ICollateralVault.CommandKind',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'LockAccepted',
    inputs: [
      {
        name: 'lockId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'agreement',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'borrower',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'deployment',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'legId',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'owner',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'refundRecipient',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'asset',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint128',
        indexed: false,
        internalType: 'uint128',
      },
      {
        name: 'purpose',
        type: 'uint8',
        indexed: false,
        internalType: 'enum ICollateralVault.Purpose',
      },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'CommandAlreadyExecuted',
    inputs: [],
  },
  {
    type: 'error',
    name: 'CommandExpired',
    inputs: [],
  },
  {
    type: 'error',
    name: 'DuplicateLock',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InsufficientCollateral',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidCommand',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidConfiguration',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidDeposit',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NonceMismatch',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ReentrantCall',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TransferFailed',
    inputs: [],
  },
  {
    type: 'error',
    name: 'Unauthorized',
    inputs: [],
  },
] as const;
export const starknet_vault_abi = [
  {
    type: 'impl',
    name: 'VaultImpl',
    interface_name: 'kanso::collateral_vault::ICollateralVault',
  },
  {
    type: 'struct',
    name: 'kanso::collateral_vault::Deposit',
    members: [
      {
        name: 'lock_id',
        type: 'core::felt252',
      },
      {
        name: 'agreement',
        type: 'core::felt252',
      },
      {
        name: 'borrower',
        type: 'core::felt252',
      },
      {
        name: 'leg_id',
        type: 'core::felt252',
      },
      {
        name: 'refund_recipient',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'purpose',
        type: 'core::integer::u8',
      },
      {
        name: 'amount',
        type: 'core::integer::u128',
      },
    ],
  },
  {
    type: 'struct',
    name: 'kanso::collateral_vault::Command',
    members: [
      {
        name: 'operation_id',
        type: 'core::felt252',
      },
      {
        name: 'lock_id',
        type: 'core::felt252',
      },
      {
        name: 'agreement',
        type: 'core::felt252',
      },
      {
        name: 'settlement_id',
        type: 'core::felt252',
      },
      {
        name: 'recipient',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'amount',
        type: 'core::integer::u128',
      },
      {
        name: 'nonce',
        type: 'core::integer::u64',
      },
      {
        name: 'deadline',
        type: 'core::integer::u64',
      },
      {
        name: 'kind',
        type: 'core::integer::u8',
      },
    ],
  },
  {
    type: 'enum',
    name: 'core::bool',
    variants: [
      {
        name: 'False',
        type: '()',
      },
      {
        name: 'True',
        type: '()',
      },
    ],
  },
  {
    type: 'struct',
    name: 'kanso::collateral_vault::Lock',
    members: [
      {
        name: 'agreement',
        type: 'core::felt252',
      },
      {
        name: 'borrower',
        type: 'core::felt252',
      },
      {
        name: 'leg_id',
        type: 'core::felt252',
      },
      {
        name: 'owner',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'refund_recipient',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'purpose',
        type: 'core::integer::u8',
      },
      {
        name: 'deposited',
        type: 'core::integer::u128',
      },
      {
        name: 'remaining',
        type: 'core::integer::u128',
      },
      {
        name: 'nonce',
        type: 'core::integer::u64',
      },
      {
        name: 'exists',
        type: 'core::bool',
      },
    ],
  },
  {
    type: 'interface',
    name: 'kanso::collateral_vault::ICollateralVault',
    items: [
      {
        type: 'function',
        name: 'deposit',
        inputs: [
          {
            name: 'deposit',
            type: 'kanso::collateral_vault::Deposit',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'execute',
        inputs: [
          {
            name: 'command',
            type: 'kanso::collateral_vault::Command',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'get_lock',
        inputs: [
          {
            name: 'lock_id',
            type: 'core::felt252',
          },
        ],
        outputs: [
          {
            type: 'kanso::collateral_vault::Lock',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'get_config',
        inputs: [],
        outputs: [
          {
            type: '(core::felt252, core::felt252, core::starknet::contract_address::ContractAddress, core::starknet::contract_address::ContractAddress)',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'accounted_balance',
        inputs: [],
        outputs: [
          {
            type: 'core::integer::u128',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'is_executed',
        inputs: [
          {
            name: 'operation_id',
            type: 'core::felt252',
          },
        ],
        outputs: [
          {
            type: 'core::bool',
          },
        ],
        state_mutability: 'view',
      },
    ],
  },
  {
    type: 'constructor',
    name: 'constructor',
    inputs: [
      {
        name: 'deployment',
        type: 'core::felt252',
      },
      {
        name: 'chain_id',
        type: 'core::felt252',
      },
      {
        name: 'controller',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'token',
        type: 'core::starknet::contract_address::ContractAddress',
      },
    ],
  },
  {
    type: 'event',
    name: 'kanso::collateral_vault::CollateralVault::LockAccepted',
    kind: 'struct',
    members: [
      {
        name: 'lock_id',
        type: 'core::felt252',
        kind: 'key',
      },
      {
        name: 'agreement',
        type: 'core::felt252',
        kind: 'key',
      },
      {
        name: 'borrower',
        type: 'core::felt252',
        kind: 'key',
      },
      {
        name: 'deployment',
        type: 'core::felt252',
        kind: 'data',
      },
      {
        name: 'leg_id',
        type: 'core::felt252',
        kind: 'data',
      },
      {
        name: 'owner',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'data',
      },
      {
        name: 'refund_recipient',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'data',
      },
      {
        name: 'asset',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'data',
      },
      {
        name: 'amount',
        type: 'core::integer::u128',
        kind: 'data',
      },
      {
        name: 'purpose',
        type: 'core::integer::u8',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'kanso::collateral_vault::CollateralVault::CommandExecuted',
    kind: 'struct',
    members: [
      {
        name: 'operation_id',
        type: 'core::felt252',
        kind: 'key',
      },
      {
        name: 'lock_id',
        type: 'core::felt252',
        kind: 'key',
      },
      {
        name: 'agreement',
        type: 'core::felt252',
        kind: 'key',
      },
      {
        name: 'deployment',
        type: 'core::felt252',
        kind: 'data',
      },
      {
        name: 'settlement_id',
        type: 'core::felt252',
        kind: 'data',
      },
      {
        name: 'recipient',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'data',
      },
      {
        name: 'amount',
        type: 'core::integer::u128',
        kind: 'data',
      },
      {
        name: 'remaining',
        type: 'core::integer::u128',
        kind: 'data',
      },
      {
        name: 'nonce',
        type: 'core::integer::u64',
        kind: 'data',
      },
      {
        name: 'kind',
        type: 'core::integer::u8',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'kanso::collateral_vault::CollateralVault::Event',
    kind: 'enum',
    variants: [
      {
        name: 'LockAccepted',
        type: 'kanso::collateral_vault::CollateralVault::LockAccepted',
        kind: 'nested',
      },
      {
        name: 'CommandExecuted',
        type: 'kanso::collateral_vault::CollateralVault::CommandExecuted',
        kind: 'nested',
      },
    ],
  },
] as const;
export const starknet_controller_abi = [
  {
    type: 'impl',
    name: 'AccountImpl',
    interface_name: 'kanso::controller_account::IControllerAccount',
  },
  {
    type: 'struct',
    name: 'core::array::Span::<core::felt252>',
    members: [
      {
        name: 'snapshot',
        type: '@core::array::Array::<core::felt252>',
      },
    ],
  },
  {
    type: 'struct',
    name: 'core::starknet::account::Call',
    members: [
      {
        name: 'to',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'selector',
        type: 'core::felt252',
      },
      {
        name: 'calldata',
        type: 'core::array::Span::<core::felt252>',
      },
    ],
  },
  {
    type: 'struct',
    name: 'core::integer::u256',
    members: [
      {
        name: 'low',
        type: 'core::integer::u128',
      },
      {
        name: 'high',
        type: 'core::integer::u128',
      },
    ],
  },
  {
    type: 'interface',
    name: 'kanso::controller_account::IControllerAccount',
    items: [
      {
        type: 'function',
        name: '__validate__',
        inputs: [
          {
            name: 'calls',
            type: 'core::array::Array::<core::starknet::account::Call>',
          },
        ],
        outputs: [
          {
            type: 'core::felt252',
          },
        ],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: '__execute__',
        inputs: [
          {
            name: 'calls',
            type: 'core::array::Array::<core::starknet::account::Call>',
          },
        ],
        outputs: [
          {
            type: 'core::array::Array::<core::array::Span::<core::felt252>>',
          },
        ],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: '__validate_deploy__',
        inputs: [
          {
            name: 'class_hash',
            type: 'core::felt252',
          },
          {
            name: 'salt',
            type: 'core::felt252',
          },
          {
            name: 'public_key_x',
            type: 'core::integer::u256',
          },
          {
            name: 'public_key_y',
            type: 'core::integer::u256',
          },
          {
            name: 'vault_class',
            type: 'core::starknet::class_hash::ClassHash',
          },
          {
            name: 'deployment',
            type: 'core::felt252',
          },
          {
            name: 'vault_salt',
            type: 'core::felt252',
          },
          {
            name: 'token',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'chain_id',
            type: 'core::felt252',
          },
        ],
        outputs: [
          {
            type: 'core::felt252',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'get_vault',
        inputs: [],
        outputs: [
          {
            type: 'core::starknet::contract_address::ContractAddress',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: '__validate_declare__',
        inputs: [
          {
            name: 'class_hash',
            type: 'core::felt252',
          },
        ],
        outputs: [
          {
            type: 'core::felt252',
          },
        ],
        state_mutability: 'view',
      },
    ],
  },
  {
    type: 'constructor',
    name: 'constructor',
    inputs: [
      {
        name: 'public_key_x',
        type: 'core::integer::u256',
      },
      {
        name: 'public_key_y',
        type: 'core::integer::u256',
      },
      {
        name: 'vault_class',
        type: 'core::starknet::class_hash::ClassHash',
      },
      {
        name: 'deployment',
        type: 'core::felt252',
      },
      {
        name: 'vault_salt',
        type: 'core::felt252',
      },
      {
        name: 'token',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'chain_id',
        type: 'core::felt252',
      },
    ],
  },
  {
    type: 'event',
    name: 'kanso::controller_account::ControllerAccount::Event',
    kind: 'enum',
    variants: [],
  },
] as const;
export const coordinator_methods = {
  commit_topup: {
    payable: true,
    private: false,
    signature:
      '(&mut self, operation_id: String, loan_id: String, leg: BasketLeg) -> TopUp',
  },
  lock_native_topup: {
    payable: true,
    private: false,
    signature: '(&mut self, operation_id: String) -> Loan',
  },
  withdraw_excess: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        loan_id: String,\n        leg_id: String,\n        amount_atomic: U128,\n        transfer_id: String,\n        expected_revision: String,) -> Transfer',
  },
  commit_replacement: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        operation_id: String,\n        loan_id: String,\n        incoming_topup_id: String,\n        outgoing_leg_id: String,\n        outgoing_amount_atomic: U128,) -> Replacement',
  },
  finalize_replacement: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        operation_id: String,\n        transfer_id: String,\n        expected_revision: String,) -> Transfer',
  },
  get_topup: {
    payable: false,
    private: false,
    signature: '(&self, operation_id: String) -> Option<TopUp>',
  },
  get_replacement: {
    payable: false,
    private: false,
    signature: '(&self, operation_id: String) -> Option<Replacement>',
  },
  prepare_remote_replacement: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        operation_id: String,\n        remote_operation_id: String,\n        expected_revision: String,\n        deadline: u64,) -> crate::operation::RemoteOperation',
  },
  prepare_bitcoin_replacement: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        operation_id: String,\n        spend_id: String,\n        max_fee_atomic: U128,\n        expected_revision: String,) -> crate::collateral::bitcoin::BitcoinSpend',
  },
  register_bitcoin_verifier: {
    payable: true,
    private: false,
    signature:
      '(&mut self, manifest_version: u32, verifier: BitcoinVerifier) -> ()',
  },
  get_bitcoin_verifier: {
    payable: false,
    private: false,
    signature: '(&self, manifest_version: u32) -> Option<BitcoinVerifier>',
  },
  submit_bitcoin_lock: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        loan_id: String,\n        leg_id: String,\n        proof: BitcoinInclusionProof,\n        raw_transaction: Vec<u8>,\n        vout: u32,) -> Promise',
  },
  submit_bitcoin_delivery: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        operation_id: String,\n        proof: BitcoinInclusionProof,\n        raw_transaction: Vec<u8>,) -> Promise',
  },
  register_bitcoin_recovery: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        recovery_id: String,\n        loan_id: String,\n        leg_id: String,\n        proof: BitcoinInclusionProof,\n        raw_transaction: Vec<u8>,\n        vout: u32,) -> Promise',
  },
  complete_bitcoin_verification: {
    payable: false,
    private: true,
    signature:
      '(&mut self,\n        action: BitcoinProofAction,\n        raw_transaction: Vec<u8>,\n        payer: AccountId,) -> serde_json::Value',
  },
  fund_loan: {
    payable: true,
    private: false,
    signature: '(&mut self, loan_id: String, transfer_id: String) -> Transfer',
  },
  record_transfer_result: {
    payable: false,
    private: true,
    signature: '(&mut self, transfer_id: String) -> bool',
  },
  finalize_transfer: {
    payable: false,
    private: false,
    signature: '(&mut self, transfer_id: String) -> Transfer',
  },
  get_transfer: {
    payable: false,
    private: false,
    signature: '(&self, transfer_id: String) -> Option<Transfer>',
  },
  withdraw_storage: {
    payable: true,
    private: false,
    signature:
      '(&mut self, amount_atomic: U128, transfer_id: String) -> Transfer',
  },
  derive_bitcoin_deposit_key: {
    payable: true,
    private: false,
    signature: '(&mut self, loan_id: String, leg_id: String) -> Promise',
  },
  record_bitcoin_key: {
    payable: false,
    private: true,
    signature: '(&mut self, loan_id: String, leg_id: String) -> bool',
  },
  bitcoin_deposit_script: {
    payable: false,
    private: false,
    signature: '(&self, loan_id: String, leg_id: String) -> Vec<u8>',
  },
  prepare_bitcoin_release: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        operation_id: String,\n        loan_id: String,\n        leg_id: String,\n        amount_atomic: U128,\n        max_fee_atomic: U128,\n        expected_revision: String,) -> BitcoinSpend',
  },
  request_bitcoin_signature: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        operation_id: String,\n        attempt_id: String,\n        fee_atomic: U128,\n        cancellation: bool,) -> Promise',
  },
  record_bitcoin_signature: {
    payable: false,
    private: true,
    signature: '(&mut self, operation_id: String, attempt_id: String) -> bool',
  },
  submit_bitcoin_signature: {
    payable: false,
    private: false,
    signature:
      '(&mut self,\n        operation_id: String,\n        attempt_id: String,\n        signature: SignatureResponse,) -> bool',
  },
  get_bitcoin_spend: {
    payable: false,
    private: false,
    signature: '(&self, operation_id: String) -> Option<BitcoinSpend>',
  },
  cancel_unsigned_bitcoin_spend: {
    payable: true,
    private: false,
    signature: '(&mut self, operation_id: String) -> BitcoinSpend',
  },
  signed_bitcoin_transaction: {
    payable: false,
    private: false,
    signature: '(&self, operation_id: String, attempt_id: String) -> Vec<u8>',
  },
  prepare_bitcoin_recovery: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        recovery_id: String,\n        operation_id: String,\n        max_fee_atomic: U128,) -> BitcoinSpend',
  },
  get_bitcoin_recovery: {
    payable: false,
    private: false,
    signature: '(&self, recovery_id: String) -> Option<BitcoinRecovery>',
  },
  lock_native: {
    payable: true,
    private: false,
    signature: '(&mut self, loan_id: String, leg_id: String) -> Loan',
  },
  release_collateral: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        loan_id: String,\n        leg_id: String,\n        transfer_id: String,) -> Transfer',
  },
  submit_remote_lock: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        loan_id: String,\n        leg_id: String,\n        proof: ReadProof,) -> Loan',
  },
  set_conditional_repayment: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        loan_id: String,\n        expected_version: u32,\n        terms: ConditionalTerms,) -> ConditionalAuthorization',
  },
  get_conditional_repayment: {
    payable: false,
    private: false,
    signature: '(&self, loan_id: String) -> Option<ConditionalAuthorization>',
  },
  set_pause_flags: {
    payable: true,
    private: false,
    signature: '(&mut self, flags: PauseFlags) -> ()',
  },
  get_pause_flags: {
    payable: false,
    private: false,
    signature: '(&self) -> PauseFlags',
  },
  get_upgrade_status: {
    payable: false,
    private: false,
    signature: '(&self) -> UpgradeStatus',
  },
  propose_owner: {
    payable: true,
    private: false,
    signature: '(&mut self, new_owner: AccountId) -> ()',
  },
  accept_owner: {
    payable: true,
    private: false,
    signature: '(&mut self) -> ()',
  },
  cancel_owner_transfer: {
    payable: true,
    private: false,
    signature: '(&mut self) -> ()',
  },
  schedule_upgrade: {
    payable: true,
    private: false,
    signature:
      '(&mut self, code_hash: Vec<u8>, execute_after: u64) -> UpgradeProposal',
  },
  cancel_upgrade: {
    payable: true,
    private: false,
    signature: '(&mut self, code_hash: Vec<u8>) -> ()',
  },
  stage_upgrade_chunk: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        code_hash: Vec<u8>,\n        offset: u32,\n        chunk: Base64VecU8,) -> u32',
  },
  execute_upgrade: {
    payable: true,
    private: false,
    signature: '(&mut self, code: Option<Base64VecU8>) -> Promise',
  },
  migrate: {
    payable: false,
    private: true,
    signature: '(expected_code_hash: Vec<u8>, from_state_version: u32) -> Self',
  },
  get_pending_pool_manager: {
    payable: false,
    private: false,
    signature: '(&self, pool_id: String) -> Option<AccountId>',
  },
  propose_pool_manager: {
    payable: true,
    private: false,
    signature: '(&mut self, pool_id: String, new_manager: AccountId) -> ()',
  },
  accept_pool_manager: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        pool_id: String,\n        expected_revision: String,) -> crate::state::Pool',
  },
  cancel_pool_manager_transfer: {
    payable: true,
    private: false,
    signature: '(&mut self, pool_id: String) -> ()',
  },
  new: {
    payable: false,
    private: false,
    signature: '(config: Config) -> Self',
  },
  get_config: {
    payable: false,
    private: false,
    signature: '(&self) -> Config',
  },
  storage_deposit: {
    payable: true,
    private: false,
    signature: '(&mut self, account_id: Option<AccountId>) -> U128',
  },
  storage_balance: {
    payable: false,
    private: false,
    signature: '(&self, account_id: AccountId) -> U128',
  },
  recognize_loss: {
    payable: true,
    private: false,
    signature:
      '(&mut self, loan_id: String, expected_revision: String) -> Loan',
  },
  loan_summary: {
    payable: false,
    private: false,
    signature: '(&self, loan_id: String) -> LoanSummary',
  },
  register_chain_manifest: {
    payable: true,
    private: false,
    signature: '(&mut self, manifest: ChainManifest) -> ()',
  },
  get_chain_manifest: {
    payable: false,
    private: false,
    signature:
      '(&self, chain_id: String, version: Option<u32>) -> ChainManifest',
  },
  request_read_attestation: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        chain_id: String,\n        manifest_version: u32,\n        payload: ForeignTxSignPayload,) -> near_sdk::Promise',
  },
  accept_offer: {
    payable: true,
    private: false,
    signature: '(&mut self, offer: Offer) -> Loan',
  },
  abort_setup: {
    payable: true,
    private: false,
    signature: '(&mut self, loan_id: String) -> Loan',
  },
  get_loan: {
    payable: false,
    private: false,
    signature: '(&self, loan_id: String) -> Loan',
  },
  debt_state: {
    payable: false,
    private: false,
    signature: '(&self, loan_id: String) -> String',
  },
  verify_controller_key: {
    payable: true,
    private: false,
    signature: '(&mut self, chain_id: String, version: u32) -> Promise',
  },
  record_controller_key: {
    payable: false,
    private: true,
    signature: '(&mut self, chain_id: String, version: u32) -> bool',
  },
  prepare_remote_release: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        operation_id: String,\n        loan_id: String,\n        leg_id: String,\n        amount_atomic: U128,\n        expected_revision: String,\n        deadline: u64,) -> RemoteOperation',
  },
  cancel_unsigned_remote_operation: {
    payable: true,
    private: false,
    signature: '(&mut self, operation_id: String) -> RemoteOperation',
  },
  request_remote_signature: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        operation_id: String,\n        attempt_id: String,\n        context: crate::transaction::TransactionContext,\n        invalidation: bool,) -> Promise',
  },
  record_remote_signature: {
    payable: false,
    private: true,
    signature: '(&mut self, operation_id: String, attempt_id: String) -> bool',
  },
  submit_remote_delivery: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        operation_id: String,\n        proof: ReadProof,) -> RemoteOperation',
  },
  get_remote_operation: {
    payable: false,
    private: false,
    signature: '(&self, operation_id: String) -> Option<RemoteOperation>',
  },
  submit_remote_signature: {
    payable: false,
    private: false,
    signature:
      '(&mut self,\n        operation_id: String,\n        attempt_id: String,\n        signature: SignatureResponse,) -> bool',
  },
  remote_broadcast_transaction: {
    payable: false,
    private: false,
    signature:
      '(&self,\n        operation_id: String,\n        attempt_id: String,) -> BroadcastTransaction',
  },
  publish_price: {
    payable: false,
    private: false,
    signature: '(&mut self, price: Price) -> ()',
  },
  publish_asset_price: {
    payable: false,
    private: false,
    signature: '(&mut self, asset_id: String, price: Price) -> ()',
  },
  get_asset_price: {
    payable: false,
    private: false,
    signature: '(&self, asset_id: String) -> Option<Price>',
  },
  get_price: {
    payable: false,
    private: false,
    signature: '(&self) -> Option<Price>',
  },
  borrowing_capacity: {
    payable: false,
    private: false,
    signature: '(&self, loan_id: String) -> U128',
  },
  create_pool: {
    payable: true,
    private: false,
    signature: '(&mut self, pool_id: String, policy: PoolPolicy) -> Pool',
  },
  close_pool: {
    payable: true,
    private: false,
    signature: '(&mut self, pool_id: String) -> ()',
  },
  migrate_testnet_usdc: {
    payable: true,
    private: false,
    signature: '(&mut self) -> crate::config::Config',
  },
  update_pool_policy: {
    payable: true,
    private: false,
    signature: '(&mut self, pool_id: String, policy: PoolPolicy) -> Pool',
  },
  get_pool: {
    payable: false,
    private: false,
    signature: '(&self, pool_id: String) -> Pool',
  },
  get_pool_count: {
    payable: false,
    private: false,
    signature: '(&self) -> u64',
  },
  pool_nav: {
    payable: false,
    private: false,
    signature: '(&self, pool_id: String) -> U128',
  },
  pool_available_cash: {
    payable: false,
    private: false,
    signature: '(&self, pool_id: String) -> U128',
  },
  get_position: {
    payable: false,
    private: false,
    signature: '(&self, pool_id: String, account_id: AccountId) -> Position',
  },
  get_withdrawal: {
    payable: false,
    private: false,
    signature: '(&self, withdrawal_id: String) -> Option<Withdrawal>',
  },
  request_withdrawal: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        withdrawal_id: String,\n        pool_id: String,\n        shares: U128,) -> Withdrawal',
  },
  cancel_withdrawal: {
    payable: true,
    private: false,
    signature: '(&mut self, withdrawal_id: String) -> Withdrawal',
  },
  claim_withdrawal: {
    payable: true,
    private: false,
    signature:
      '(&mut self, withdrawal_id: String, transfer_id: String) -> Transfer',
  },
  configure_recovery: {
    payable: true,
    private: false,
    signature: '(&mut self, policy: RecoveryPolicy) -> ()',
  },
  recovery_message: {
    payable: false,
    private: false,
    signature: '(&self, attestation: OutcomeAttestation) -> Vec<u8>',
  },
  recover_transfer_outcome: {
    payable: false,
    private: false,
    signature: '(&mut self, attestation: OutcomeAttestation) -> Transfer',
  },
  get_recovery_policy: {
    payable: false,
    private: false,
    signature: '(&self) -> Option<RecoveryPolicy>',
  },
  ft_on_transfer: {
    payable: false,
    private: false,
    signature:
      '(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128',
  },
  get_payment: {
    payable: false,
    private: false,
    signature:
      '(&self,\n        sender_id: AccountId,\n        operation_id: String,) -> Option<PaymentReceipt>',
  },
  basket_risk: {
    payable: false,
    private: false,
    signature: '(&self, loan_id: String) -> RiskSnapshot',
  },
  quote_settlement: {
    payable: true,
    private: false,
    signature: '(&mut self, plan: SettlementPlan) -> Settlement',
  },
  commit_settlement: {
    payable: true,
    private: false,
    signature:
      '(&mut self, operation_id: String, transfer_id: String) -> Settlement',
  },
  apply_settlement: {
    payable: false,
    private: false,
    signature: '(&mut self, operation_id: String) -> Settlement',
  },
  cancel_settlement: {
    payable: true,
    private: false,
    signature: '(&mut self, operation_id: String) -> Settlement',
  },
  get_settlement: {
    payable: false,
    private: false,
    signature: '(&self, operation_id: String) -> Option<Settlement>',
  },
  get_refund: {
    payable: false,
    private: false,
    signature: '(&self, refund_id: String) -> Option<Refund>',
  },
  settlement_liabilities: {
    payable: false,
    private: false,
    signature: '(&self) -> (U128, U128)',
  },
  claim_refund: {
    payable: true,
    private: false,
    signature:
      '(&mut self, refund_id: String, transfer_id: String) -> Transfer',
  },
  wallet_payment_leg_id: {
    payable: false,
    private: false,
    signature:
      '(&self,\n        loan_id: String,\n        payer: AccountId,\n        payment_id: String,) -> String',
  },
  create_wallet_payment: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        loan_id: String,\n        payment_id: String,\n        leg: BasketLeg,) -> Lock',
  },
  refund_native_wallet_payment: {
    payable: true,
    private: false,
    signature:
      '(&mut self,\n        loan_id: String,\n        leg_id: String,\n        transfer_id: String,) -> Transfer',
  },
} as const;
export const solana_layouts = {
  Config: [
    {
      name: 'tag',
      type: '[u8; 8]',
    },
    {
      name: 'deployment',
      type: '[u8; 32]',
    },
    {
      name: 'network',
      type: '[u8; 32]',
    },
    {
      name: 'controller',
      type: '[u8; 32]',
    },
  ],
  Lock: [
    {
      name: 'tag',
      type: '[u8; 8]',
    },
    {
      name: 'config',
      type: '[u8; 32]',
    },
    {
      name: 'lock_id',
      type: '[u8; 32]',
    },
    {
      name: 'agreement',
      type: '[u8; 32]',
    },
    {
      name: 'borrower',
      type: '[u8; 32]',
    },
    {
      name: 'leg_id',
      type: '[u8; 32]',
    },
    {
      name: 'owner',
      type: '[u8; 32]',
    },
    {
      name: 'refund_recipient',
      type: '[u8; 32]',
    },
    {
      name: 'purpose',
      type: 'u8',
    },
    {
      name: 'deposited',
      type: 'u64',
    },
    {
      name: 'remaining',
      type: 'u64',
    },
    {
      name: 'nonce',
      type: 'u64',
    },
  ],
  Receipt: [
    {
      name: 'tag',
      type: '[u8; 8]',
    },
    {
      name: 'config',
      type: '[u8; 32]',
    },
    {
      name: 'operation_id',
      type: '[u8; 32]',
    },
    {
      name: 'lock_id',
      type: '[u8; 32]',
    },
    {
      name: 'agreement',
      type: '[u8; 32]',
    },
    {
      name: 'settlement_id',
      type: '[u8; 32]',
    },
    {
      name: 'recipient',
      type: '[u8; 32]',
    },
    {
      name: 'amount',
      type: 'u64',
    },
    {
      name: 'remaining',
      type: 'u64',
    },
    {
      name: 'nonce',
      type: 'u64',
    },
    {
      name: 'kind',
      type: 'u8',
    },
  ],
} as const;
export const source_hashes = {
  'contracts/near/src/encoding.rs':
    '1e84fea4202c06dc5f02ff0719c209614a336b77dd65ad5904b50af34bd8cb5d',
  'contracts/solana/src/state.rs':
    '5682e73aea12139a47ccec5477d2c051bdb8739c20c185a69194f9409333bbcf',
  'contracts/solana/src/instruction.rs':
    '9a6b42f13b6b8808e8ad7a05606e721ba9054aef0a06e713dd41bf2169c34b6c',
  'contracts/sui/sources/collateral_vault.move':
    'e1f25c289e77db261163d767cd97bbce0228a36be1e13c96a5562d4aaa1884ab',
} as const;
