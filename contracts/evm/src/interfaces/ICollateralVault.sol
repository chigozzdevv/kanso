// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface ICollateralVault {
    enum Purpose {
        Collateral,
        Payment
    }
    enum CommandKind {
        Release,
        Sale,
        Invalidate
    }

    struct Deposit {
        bytes32 lockId;
        bytes32 agreement;
        bytes32 borrower;
        bytes32 legId;
        address refundRecipient;
        Purpose purpose;
    }

    struct Lock {
        bytes32 agreement;
        bytes32 borrower;
        bytes32 legId;
        address owner;
        address refundRecipient;
        Purpose purpose;
        uint128 deposited;
        uint128 remaining;
        uint64 nonce;
        bool exists;
    }

    struct Command {
        bytes32 operationId;
        bytes32 lockId;
        bytes32 agreement;
        bytes32 settlementId;
        address recipient;
        uint128 amount;
        uint64 nonce;
        uint64 deadline;
        CommandKind kind;
    }

    event LockAccepted(
        bytes32 indexed lockId,
        bytes32 indexed agreement,
        bytes32 indexed borrower,
        bytes32 deployment,
        bytes32 legId,
        address owner,
        address refundRecipient,
        address asset,
        uint128 amount,
        Purpose purpose
    );

    event CommandExecuted(
        bytes32 indexed operationId,
        bytes32 indexed lockId,
        bytes32 indexed agreement,
        bytes32 deployment,
        bytes32 settlementId,
        address recipient,
        uint128 amount,
        uint128 remaining,
        uint64 nonce,
        CommandKind kind
    );

    function depositNative(Deposit calldata deposit) external payable;
    function depositToken(Deposit calldata deposit, uint128 amount) external;
    function execute(Command calldata command) external;
    function getLock(bytes32 lockId) external view returns (Lock memory);
}
