// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICollateralVault} from "./interfaces/ICollateralVault.sol";

interface IERC20Collateral {
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

contract CollateralVault is ICollateralVault {
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidDeposit();
    error DuplicateLock();
    error InvalidCommand();
    error CommandExpired();
    error CommandAlreadyExecuted();
    error NonceMismatch();
    error InsufficientCollateral();
    error TransferFailed();
    error ReentrantCall();

    bytes32 public immutable deployment;
    uint256 public immutable networkId;
    address public immutable controller;
    address public immutable asset;
    uint256 public accountedBalance;

    mapping(bytes32 => Lock) private locks;
    mapping(bytes32 => bool) public executed;
    bool private entered;

    constructor(bytes32 deployment_, uint256 networkId_, address controller_, address asset_) {
        if (
            deployment_ == bytes32(0) || networkId_ != block.chainid || controller_ == address(0)
                || controller_ == address(this) || (asset_ != address(0) && asset_.code.length == 0)
        ) {
            revert InvalidConfiguration();
        }
        deployment = deployment_;
        networkId = networkId_;
        controller = controller_;
        asset = asset_;
    }

    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    function depositNative(Deposit calldata deposit) external payable nonReentrant {
        if (asset != address(0) || msg.value == 0 || msg.value > type(uint128).max) revert InvalidDeposit();
        _deposit(deposit, uint128(msg.value));
    }

    function depositToken(Deposit calldata deposit, uint128 amount) external nonReentrant {
        if (asset == address(0) || amount == 0) revert InvalidDeposit();
        uint256 beforeBalance = IERC20Collateral(asset).balanceOf(address(this));
        _callToken(abi.encodeCall(IERC20Collateral.transferFrom, (msg.sender, address(this), amount)));
        uint256 received = IERC20Collateral(asset).balanceOf(address(this)) - beforeBalance;
        if (received == 0 || received > type(uint128).max) revert InvalidDeposit();
        _deposit(deposit, uint128(received));
    }

    function execute(Command calldata command) external nonReentrant {
        if (msg.sender != controller || block.chainid != networkId) revert Unauthorized();
        if (executed[command.operationId]) revert CommandAlreadyExecuted();
        if (block.timestamp > command.deadline) revert CommandExpired();
        Lock storage locked = locks[command.lockId];
        if (!locked.exists || command.operationId == bytes32(0) || command.agreement != locked.agreement) {
            revert InvalidCommand();
        }
        if (command.nonce != locked.nonce) revert NonceMismatch();
        if (command.kind == CommandKind.Invalidate) {
            if (command.amount != 0 || command.recipient != address(0) || command.settlementId != bytes32(0)) {
                revert InvalidCommand();
            }
        } else {
            if (
                command.amount == 0 || command.recipient == address(0) || command.recipient == address(this)
                    || (command.kind == CommandKind.Sale) != (command.settlementId != bytes32(0))
            ) {
                revert InvalidCommand();
            }
            if (command.amount > locked.remaining) revert InsufficientCollateral();
            locked.remaining -= command.amount;
            accountedBalance -= command.amount;
        }
        locked.nonce += 1;
        executed[command.operationId] = true;
        if (command.amount != 0) {
            if (asset == address(0)) {
                (bool success,) = command.recipient.call{value: command.amount}("");
                if (!success) revert TransferFailed();
            } else {
                uint256 beforeBalance = IERC20Collateral(asset).balanceOf(address(this));
                uint256 recipientBalance = IERC20Collateral(asset).balanceOf(command.recipient);
                _callToken(abi.encodeCall(IERC20Collateral.transfer, (command.recipient, command.amount)));
                if (
                    beforeBalance - IERC20Collateral(asset).balanceOf(address(this)) != command.amount
                        || IERC20Collateral(asset).balanceOf(command.recipient) - recipientBalance != command.amount
                ) {
                    revert TransferFailed();
                }
            }
        }
        emit CommandExecuted(
            command.operationId,
            command.lockId,
            command.agreement,
            deployment,
            command.settlementId,
            command.recipient,
            command.amount,
            locked.remaining,
            command.nonce,
            command.kind
        );
    }

    function getLock(bytes32 lockId) external view returns (Lock memory) {
        return locks[lockId];
    }

    function _deposit(Deposit calldata deposit, uint128 amount) private {
        if (
            block.chainid != networkId || deposit.lockId == bytes32(0) || deposit.agreement == bytes32(0)
                || deposit.borrower == bytes32(0) || deposit.legId == bytes32(0)
                || deposit.refundRecipient == address(0) || deposit.refundRecipient == address(this)
        ) {
            revert InvalidDeposit();
        }
        if (locks[deposit.lockId].exists) revert DuplicateLock();
        locks[deposit.lockId] = Lock(
            deposit.agreement,
            deposit.borrower,
            deposit.legId,
            msg.sender,
            deposit.refundRecipient,
            deposit.purpose,
            amount,
            amount,
            0,
            true
        );
        accountedBalance += amount;
        emit LockAccepted(
            deposit.lockId,
            deposit.agreement,
            deposit.borrower,
            deployment,
            deposit.legId,
            msg.sender,
            deposit.refundRecipient,
            asset,
            amount,
            deposit.purpose
        );
    }

    function _callToken(bytes memory data) private {
        (bool success, bytes memory result) = asset.call(data);
        if (!success || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert TransferFailed();
        }
    }
}
