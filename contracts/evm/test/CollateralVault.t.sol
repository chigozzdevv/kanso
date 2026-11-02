// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CollateralVault} from "../src/CollateralVault.sol";
import {ICollateralVault as Vault} from "../src/interfaces/ICollateralVault.sol";

contract RejectNative {
    receive() external payable {
        revert();
    }
}

contract ForceNative {
    constructor(address payable destination) payable {
        selfdestruct(destination);
    }
}

contract CollateralVaultTest is Test {
    CollateralVault private vault;
    address private controller = makeAddr("controller");
    address private borrower = makeAddr("borrower");
    address private solver = makeAddr("solver");
    bytes32 private constant LOCK = keccak256("lock");
    bytes32 private constant AGREEMENT = keccak256("agreement");

    function setUp() public {
        vault = new CollateralVault(keccak256("deployment"), block.chainid, controller, address(0));
        vm.deal(borrower, 100 ether);
        vm.prank(borrower);
        vault.depositNative{value: 10 ether}(_deposit(LOCK));
    }

    function testOwnerCannotWithdraw() public {
        vm.prank(borrower);
        vm.expectRevert(CollateralVault.Unauthorized.selector);
        vault.execute(_command(keccak256("release"), 10 ether, 0));
        assertEq(vault.getLock(LOCK).remaining, 10 ether);
    }

    function testPartialSaleThenRelease() public {
        Vault.Command memory sale = _command(keccak256("sale"), 3 ether, 0);
        sale.kind = Vault.CommandKind.Sale;
        sale.recipient = solver;
        sale.settlementId = keccak256("settlement");
        vm.prank(controller);
        vault.execute(sale);
        assertEq(solver.balance, 3 ether);
        vm.prank(controller);
        vault.execute(_command(keccak256("release"), 7 ether, 1));
        assertEq(vault.getLock(LOCK).remaining, 0);
        assertEq(vault.accountedBalance(), 0);
        assertEq(address(vault).balance, 0);
    }

    function testDuplicateOperationCannotSpendAgain() public {
        Vault.Command memory command = _command(keccak256("release"), 1 ether, 0);
        vm.prank(controller);
        vault.execute(command);
        command.nonce = 1;
        vm.prank(controller);
        vm.expectRevert(CollateralVault.CommandAlreadyExecuted.selector);
        vault.execute(command);
        assertEq(vault.getLock(LOCK).remaining, 9 ether);
    }

    function testInvalidationConsumesNonceWithoutSpending() public {
        Vault.Command memory command = _command(keccak256("invalidate"), 0, 0);
        command.kind = Vault.CommandKind.Invalidate;
        command.recipient = address(0);
        vm.prank(controller);
        vault.execute(command);
        vm.prank(controller);
        vm.expectRevert(CollateralVault.NonceMismatch.selector);
        vault.execute(_command(keccak256("old_signature"), 10 ether, 0));
        assertEq(vault.getLock(LOCK).remaining, 10 ether);
    }

    function testRejectedRecipientRollsBackNonceReceiptAndBalance() public {
        Vault.Command memory command = _command(keccak256("release"), 1 ether, 0);
        command.recipient = address(new RejectNative());
        vm.prank(controller);
        vm.expectRevert(CollateralVault.TransferFailed.selector);
        vault.execute(command);
        assertEq(vault.getLock(LOCK).nonce, 0);
        assertEq(vault.getLock(LOCK).remaining, 10 ether);
        assertFalse(vault.executed(command.operationId));
    }

    function testForcedNativeTransferCannotIncreaseRecordedCollateral() public {
        new ForceNative{value: 1 ether}(payable(address(vault)));
        assertEq(address(vault).balance, 11 ether);
        assertEq(vault.accountedBalance(), 10 ether);
        assertEq(vault.getLock(LOCK).deposited, 10 ether);
    }

    function testExpiredCommandCannotSpend() public {
        Vault.Command memory command = _command(keccak256("release"), 1 ether, 0);
        vm.warp(command.deadline + 1);
        vm.prank(controller);
        vm.expectRevert(CollateralVault.CommandExpired.selector);
        vault.execute(command);
    }

    function testWrongNetworkCannotExecute() public {
        vm.chainId(block.chainid + 1);
        vm.prank(controller);
        vm.expectRevert(CollateralVault.Unauthorized.selector);
        vault.execute(_command(keccak256("release"), 1 ether, 0));
    }

    function testDuplicateDepositCannotOverwriteOriginalOwner() public {
        vm.prank(borrower);
        vm.expectRevert(CollateralVault.DuplicateLock.selector);
        vault.depositNative{value: 1 ether}(_deposit(LOCK));
    }

    function testFuzzPartialSpendsPreserveCustody(uint128 first, uint128 second) public {
        first = uint128(bound(first, 1, 10 ether));
        second = uint128(bound(second, 0, 10 ether - first));
        vm.prank(controller);
        vault.execute(_command(keccak256("first"), first, 0));
        if (second > 0) {
            vm.prank(controller);
            vault.execute(_command(keccak256("second"), second, 1));
        }
        assertEq(vault.accountedBalance(), 10 ether - first - second);
        assertEq(vault.getLock(LOCK).remaining, vault.accountedBalance());
        assertEq(address(vault).balance, vault.accountedBalance());
    }

    function _deposit(bytes32 lockId) private view returns (Vault.Deposit memory) {
        return
            Vault.Deposit(
                lockId, AGREEMENT, keccak256("borrower"), keccak256("leg"), borrower, Vault.Purpose.Collateral
            );
    }

    function _command(bytes32 operationId, uint128 amount, uint64 nonce) private view returns (Vault.Command memory) {
        return Vault.Command(
            operationId,
            LOCK,
            AGREEMENT,
            bytes32(0),
            borrower,
            amount,
            nonce,
            uint64(block.timestamp + 600),
            Vault.CommandKind.Release
        );
    }
}
