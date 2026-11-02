// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {Test} from "forge-std/Test.sol";
import {CollateralVault} from "../src/CollateralVault.sol";
import {ICollateralVault as Vault} from "../src/interfaces/ICollateralVault.sol";

contract TestCollateralToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public tax;
    bool public reject;

    function mint(address owner, uint256 amount) external {
        balanceOf[owner] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function configure(uint256 tax_, bool reject_) external {
        tax = tax_;
        reject = reject_;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, recipient, amount);
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        allowance[sender][msg.sender] -= amount;
        return _transfer(sender, recipient, amount);
    }

    function _transfer(address sender, address recipient, uint256 amount) private returns (bool) {
        if (reject) return false;
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount - tax;
        return true;
    }
}

contract ReenteringRecipient {
    CollateralVault private vault;
    bool public blocked;

    constructor(CollateralVault vault_) {
        vault = vault_;
    }

    receive() external payable {
        Vault.Deposit memory deposit = Vault.Deposit(
            keccak256("reentry"),
            keccak256("agreement"),
            keccak256("borrower"),
            keccak256("leg"),
            address(this),
            Vault.Purpose.Collateral
        );
        try vault.depositNative{value: 1}(deposit) {
            revert("REENTRY_SUCCEEDED");
        } catch {
            blocked = true;
        }
    }
}

contract TokenVaultTest is Test {
    TestCollateralToken private token;
    CollateralVault private vault;
    address private borrower = makeAddr("borrower");
    address private controller = makeAddr("controller");
    bytes32 private constant LOCK = keccak256("lock");

    function setUp() public {
        token = new TestCollateralToken();
        vault = new CollateralVault(keccak256("deployment"), block.chainid, controller, address(token));
        token.mint(borrower, 1000);
        vm.prank(borrower);
        token.approve(address(vault), 1000);
    }

    function testTokenDepositCreditsOnlyActualReceipt() public {
        token.configure(10, false);
        vm.prank(borrower);
        vault.depositToken(_deposit(), 1000);
        assertEq(vault.getLock(LOCK).deposited, 990);
        assertEq(vault.accountedBalance(), 990);
    }

    function testTokenDeliveryRequiresTheExactNetAmount() public {
        vm.prank(borrower);
        vault.depositToken(_deposit(), 1000);
        token.configure(10, false);
        vm.prank(controller);
        vm.expectRevert(CollateralVault.TransferFailed.selector);
        vault.execute(_command(500));
        assertEq(vault.getLock(LOCK).nonce, 0);
        assertEq(vault.getLock(LOCK).remaining, 1000);
        assertEq(token.balanceOf(address(vault)), 1000);
    }

    function testRejectedTokenDeliveryDoesNotConsumeTheCommand() public {
        vm.prank(borrower);
        vault.depositToken(_deposit(), 1000);
        token.configure(0, true);
        vm.prank(controller);
        vm.expectRevert(CollateralVault.TransferFailed.selector);
        vault.execute(_command(500));
        assertFalse(vault.executed(keccak256("release")));
        assertEq(vault.accountedBalance(), 1000);
    }

    function testPaymentPurposeAndRefundIdentityAreImmutable() public {
        Vault.Deposit memory deposit = _deposit();
        deposit.purpose = Vault.Purpose.Payment;
        vm.prank(borrower);
        vault.depositToken(deposit, 1000);
        Vault.Lock memory locked = vault.getLock(LOCK);
        assertEq(uint8(locked.purpose), 1);
        assertEq(locked.refundRecipient, borrower);
        assertEq(locked.owner, borrower);
    }

    function testNativeDeliveryCannotReenterCustody() public {
        CollateralVault nativeVault = new CollateralVault(keccak256("native"), block.chainid, controller, address(0));
        vm.deal(borrower, 1000);
        vm.prank(borrower);
        nativeVault.depositNative{value: 1000}(_deposit());
        ReenteringRecipient recipient = new ReenteringRecipient(nativeVault);
        Vault.Command memory command = _command(500);
        command.recipient = address(recipient);
        vm.prank(controller);
        nativeVault.execute(command);
        assertTrue(recipient.blocked());
        assertEq(nativeVault.accountedBalance(), 500);
        assertEq(nativeVault.getLock(LOCK).remaining, 500);
    }

    function _deposit() private view returns (Vault.Deposit memory) {
        return Vault.Deposit(
            LOCK, keccak256("agreement"), keccak256("borrower"), keccak256("leg"), borrower, Vault.Purpose.Collateral
        );
    }

    function _command(uint128 amount) private view returns (Vault.Command memory) {
        return Vault.Command(
            keccak256("release"),
            LOCK,
            keccak256("agreement"),
            bytes32(0),
            borrower,
            amount,
            0,
            uint64(block.timestamp + 600),
            Vault.CommandKind.Release
        );
    }
}
