// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../src/Vault.sol";
// FC types moved to file scope (VaultInputs.sol) so the external VaultLogic library can reference them.
import {BetStatus, BetRecord, OperatorAttestation, FeeConfig} from "../src/VaultInputs.sol";
// FEE/EIP-170: public-input structs are now file-level in VaultInputs.sol (no longer
// nested under Vault). Import the ones these tests construct.
import {
    BetAuthPublicInputs,
    SettlementPublicInputs,
    WithdrawalPublicInputs,
    BetCancelPublicInputs,
    NACancelPublicInputs,
    ClosePublicInputs,
    PartialFillPublicInputs,
    ConsolidatePublicInputs
} from "../src/VaultInputs.sol";
import {CommitmentMerkleTree} from "../src/CommitmentMerkleTree.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {MockVerifier} from "../src/mocks/MockVerifier.sol";
import {MockPoseidonT3} from "../src/mocks/MockPoseidonT3.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockCTF} from "../src/mocks/MockCTF.sol";
import {MockPUSD} from "../src/mocks/MockPUSD.sol";
import {MockCollateralOnramp} from "../src/mocks/MockCollateralOnramp.sol";
import {MockCollateralOfframp} from "../src/mocks/MockCollateralOfframp.sol";
import {DeployLib} from "../script/DeployLib.sol";

contract VaultTest is Test {
    Vault public vault;
    CommitmentMerkleTree public tree;
    NullifierRegistry public registry;
    MockVerifier public betAuthVerifier;
    MockVerifier public settlementVerifier;
    MockVerifier public withdrawalVerifier;
    MockVerifier public betCancelVerifier;
    MockVerifier public cancelCreditVerifier;
    MockVerifier public depositVerifier;
    MockVerifier public positionCloseVerifier;
    MockVerifier public partialCreditVerifier;
    MockVerifier public consolidateVerifier;
    MockPoseidonT3 public poseidon;
    MockUSDC public usdc;
    MockCTF public ctf;
    MockCollateralOnramp public onramp;
    MockCollateralOfframp public offramp;

    uint256 internal constant OPERATOR_PK = 0xA11CE00000000000000000000000000000000000000000000000000000000001;
    address public owner = address(0x1111);
    address public operator;
    address public depositWallet = address(0x3333);
    address public alice = address(0xA1CE);
    address public bob = address(0xB0B0);
    address public attacker = address(0xBAD0);
    address public recipient = address(0xBEEF);

    // Shared test data
    bytes32 constant COMMITMENT_1 = keccak256("commitment_1");
    bytes32 constant COMMITMENT_2 = keccak256("commitment_2");
    bytes32 constant COMMITMENT_3 = keccak256("commitment_3");
    bytes32 constant NULLIFIER_1 = keccak256("nullifier_1");
    bytes32 constant NULLIFIER_2 = keccak256("nullifier_2");
    bytes32 constant MARKET_ID = keccak256("market_1");
    bytes32 constant POSITION_ID = keccak256("position_1");
    uint256 constant DEPOSIT_AMOUNT = 1000 * 1e6; // $1k USDC
    uint256 constant DEPOSIT_CAP = 50_000 * 1e6;  // $50k USDC

    bytes public constant DUMMY_PROOF = hex"deadbeef";

    function setUp() public {
        operator = vm.addr(OPERATOR_PK);
        poseidon = new MockPoseidonT3();
        usdc = new MockUSDC();
        ctf = new MockCTF(address(new MockPUSD()));
        MockPUSD pusd = new MockPUSD();
        onramp = new MockCollateralOnramp(address(usdc), address(pusd));
        offramp = new MockCollateralOfframp(address(usdc), address(pusd));

        // UUPS: deploy implementations, then proxies. Predict the Vault PROXY address so
        // the registry/tree proxies can initialize against it (registryProxy, treeProxy,
        // vaultProxy are the next three CREATEs by address(this)).
        address registryImpl = address(new NullifierRegistry());
        address treeImpl = address(new CommitmentMerkleTree());
        address vaultImpl = address(new Vault());
        address predictedVault = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);

        registry = NullifierRegistry(
            DeployLib.deployProxy(registryImpl, abi.encodeCall(NullifierRegistry.initialize, (predictedVault, owner)))
        );
        tree = CommitmentMerkleTree(
            DeployLib.deployProxy(
                treeImpl, abi.encodeCall(CommitmentMerkleTree.initialize, (predictedVault, address(poseidon), owner))
            )
        );
        vault = Vault(
            DeployLib.deployVaultProxy(
                vaultImpl,
                DeployLib.VaultInit({
                    usdc: address(usdc),
                    tree: address(tree),
                    registry: address(registry),
                    onramp: address(onramp),
                    offramp: address(offramp),
                    ctf: address(ctf),
                    operator: operator,
                    depositWallet: depositWallet,
                    owner: owner
                })
            )
        );
        require(address(vault) == predictedVault, "VaultTest: vault proxy addr mismatch");

        // FC-9: set up the EIP-712 domain used to verify operator fill attestations.
        vault.initializeV2();

        // Deploy mock verifiers
        betAuthVerifier = new MockVerifier(true);
        settlementVerifier = new MockVerifier(true);
        withdrawalVerifier = new MockVerifier(true);
        betCancelVerifier = new MockVerifier(true);
        cancelCreditVerifier = new MockVerifier(true);
        depositVerifier = new MockVerifier(true);
        positionCloseVerifier = new MockVerifier(true);
        partialCreditVerifier = new MockVerifier(true);
        consolidateVerifier = new MockVerifier(true);

        // Wire verifiers — propose then accept after timelock
        vm.startPrank(owner);
        vault.proposeVerifier(vault.BET_AUTH(), address(betAuthVerifier));
        vault.proposeVerifier(vault.SETTLEMENT_CREDIT(), address(settlementVerifier));
        vault.proposeVerifier(vault.WITHDRAWAL(), address(withdrawalVerifier));
        vault.proposeVerifier(vault.BET_CANCEL(), address(betCancelVerifier));
        vault.proposeVerifier(vault.CANCEL_CREDIT(), address(cancelCreditVerifier));
        vault.proposeVerifier(vault.DEPOSIT(), address(depositVerifier));
        vault.proposeVerifier(vault.POSITION_CLOSE(), address(positionCloseVerifier));
        vault.proposeVerifier(vault.PARTIAL_CREDIT(), address(partialCreditVerifier));
        vault.proposeVerifier(vault.CONSOLIDATE(), address(consolidateVerifier));
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours + 1);
        vm.startPrank(owner);
        vault.acceptVerifier(vault.BET_AUTH());
        vault.acceptVerifier(vault.SETTLEMENT_CREDIT());
        vault.acceptVerifier(vault.WITHDRAWAL());
        vault.acceptVerifier(vault.BET_CANCEL());
        vault.acceptVerifier(vault.CANCEL_CREDIT());
        vault.acceptVerifier(vault.DEPOSIT());
        vault.acceptVerifier(vault.POSITION_CLOSE());
        vault.acceptVerifier(vault.PARTIAL_CREDIT());
        vault.acceptVerifier(vault.CONSOLIDATE());
        vm.stopPrank();

        // Fund Alice with USDC
        usdc.mint(alice, DEPOSIT_CAP + DEPOSIT_AMOUNT);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);

        // Fund Bob
        usdc.mint(bob, DEPOSIT_AMOUNT);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
    }

    // =========================================================================
    // Helper: current Merkle root for use in proof inputs
    // =========================================================================

    function _currentRoot() internal view returns (bytes32) {
        return tree.currentRoot();
    }

    // =========================================================================
    // FC-9: operator attestation helpers (EIP-712 OperatorAttestation)
    // =========================================================================

    bytes32 internal constant ATT_TYPEHASH =
        keccak256("OperatorAttestation(bytes32 nullifierOfBet,uint8 reportType,uint64 amountA,uint64 amountB)");

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Polyshield")),
                keccak256(bytes("1")),
                block.chainid,
                address(vault)
            )
        );
    }

    /// @dev Build + operator-sign an attestation bound to `nob`.
    function _attest(bytes32 nob, uint8 rType, uint64 a, uint64 b)
        internal
        view
        returns (OperatorAttestation memory att, bytes memory sig)
    {
        att = OperatorAttestation({nullifierOfBet: nob, reportType: rType, amountA: a, amountB: b});
        bytes32 structHash = keccak256(abi.encode(ATT_TYPEHASH, att.nullifierOfBet, att.reportType, att.amountA, att.amountB));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPERATOR_PK, digest);
        sig = abi.encodePacked(r, s, v);
    }

    /// @dev An empty attestation, used on the FILLED/FAILED no-attestation branches.
    function _noAtt() internal pure returns (OperatorAttestation memory att, bytes memory sig) {
        att = OperatorAttestation({nullifierOfBet: bytes32(0), reportType: 0, amountA: 0, amountB: 0});
        sig = "";
    }

    // =========================================================================
    // Deposit
    // =========================================================================

    function test_deposit_succeeds() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        assertEq(vault.cumulativeDeposits(alice), DEPOSIT_AMOUNT);
        assertEq(usdc.balanceOf(address(vault)), DEPOSIT_AMOUNT);
    }

    function test_deposit_emitsEvent() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit Vault.Deposited(alice, COMMITMENT_1, DEPOSIT_AMOUNT);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
    }

    function test_deposit_exactCapSucceeds() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_CAP);
    }

    function test_deposit_revert_capExceeded() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_CAP);
        vm.prank(alice);
        vm.expectRevert(Vault.DepositCapExceeded.selector);
        vault.deposit(DUMMY_PROOF, COMMITMENT_2, 1);
    }

    function test_deposit_capPerAddress() public {
        // Alice hits cap
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_CAP);
        // Bob can still deposit
        vm.prank(bob);
        vault.deposit(DUMMY_PROOF, COMMITMENT_2, DEPOSIT_AMOUNT);
    }

    // FC-2 / T20: deposit must verify the binding proof. A rejected proof (e.g.
    // committed balance != transferred amount) must revert before any state change.
    function test_deposit_revert_invalidProof() public {
        MockVerifier badDeposit = new MockVerifier(false);
        vm.startPrank(owner);
        vault.proposeVerifier(vault.DEPOSIT(), address(badDeposit));
        vm.warp(block.timestamp + 48 hours + 1);
        vault.acceptVerifier(vault.DEPOSIT());
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);

        // No leaf inserted, no USDC pulled, no cumulative increment.
        assertEq(vault.cumulativeDeposits(alice), 0);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    // =========================================================================
    // authorizeBet
    // =========================================================================

    function _depositAndGetRoot() internal returns (bytes32 root) {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        root = _currentRoot();
    }

    function _betAuthInputs(bytes32 root) internal pure returns (BetAuthPublicInputs memory) {
        return BetAuthPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_1,
            new_commitment: COMMITMENT_2,
            bet_amount: 100 * 1e6,
            price: 50_000_000,
            expected_shares: 200_000_000,
            market_id: MARKET_ID,
            outcome_side: 0,
            position_id: POSITION_ID
        });
    }

    function test_authorizeBet_succeeds() public {
        bytes32 root = _depositAndGetRoot();
        vault.authorizeBet(DUMMY_PROOF, _betAuthInputs(root));
        assertTrue(registry.isSpent(NULLIFIER_1));
    }

    function test_authorizeBet_emitsBetAuthorized() public {
        bytes32 root = _depositAndGetRoot();
        BetAuthPublicInputs memory inputs = _betAuthInputs(root);
        vm.expectEmit(true, false, false, true);
        emit Vault.BetAuthorized(
            NULLIFIER_1,
            MARKET_ID,
            POSITION_ID,
            200_000_000,
            100 * 1e6,
            50_000_000,
            0,           // outcome_side (matches _betAuthInputs)
            COMMITMENT_2
        );
        vault.authorizeBet(DUMMY_PROOF, inputs);
    }

    function test_authorizeBet_storesBetRecord() public {
        bytes32 root = _depositAndGetRoot();
        vault.authorizeBet(DUMMY_PROOF, _betAuthInputs(root));
        (bytes32 mktId, bytes32 condId, bytes32 posId, uint64 shares, uint64 betAmt, uint8 outcomeSide, BetStatus status,,,,) =
            vault.betRecords(NULLIFIER_1);
        assertEq(mktId, MARKET_ID);
        assertEq(condId, MARKET_ID);
        assertEq(posId, POSITION_ID);
        assertEq(shares, 200_000_000);
        assertEq(betAmt, 100 * 1e6);
        assertEq(outcomeSide, 0);
        assertEq(uint8(status), uint8(BetStatus.ACTIVE));
    }

    function test_authorizeBet_revert_nullifierSpent() public {
        bytes32 root = _depositAndGetRoot();
        vault.authorizeBet(DUMMY_PROOF, _betAuthInputs(root));
        // Second call should fail: nullifier already spent
        bytes32 root2 = _currentRoot();
        BetAuthPublicInputs memory inputs2 = _betAuthInputs(root2);
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.authorizeBet(DUMMY_PROOF, inputs2);
    }

    function test_authorizeBet_revert_unknownRoot() public {
        BetAuthPublicInputs memory inputs = _betAuthInputs(keccak256("stale_root"));
        vm.expectRevert(Vault.UnknownRoot.selector);
        vault.authorizeBet(DUMMY_PROOF, inputs);
    }

    function test_authorizeBet_revert_invalidProof() public {
        bytes32 root = _depositAndGetRoot();
        betAuthVerifier.setShouldPass(false);
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.authorizeBet(DUMMY_PROOF, _betAuthInputs(root));
    }

    // =========================================================================
    // Bet setup helpers (FC-9: status is advanced via attestations, not report* calls)
    // =========================================================================

    function _authorizeBetAndGetNullifier() internal returns (bytes32) {
        bytes32 root = _depositAndGetRoot();
        vault.authorizeBet(DUMMY_PROOF, _betAuthInputs(root));
        return NULLIFIER_1;
    }

    // =========================================================================
    // creditSettlement
    // =========================================================================

    function _settlementInputs(bytes32 root) internal pure returns (SettlementPublicInputs memory) {
        return SettlementPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            new_commitment: COMMITMENT_3,
            nullifier_of_bet: NULLIFIER_1,
            market_id: MARKET_ID,
            // payout_per_share removed — read from pendingCredit[market_id]
            // expected_shares = 200_000_000, payout_per_share = 1 => total_credit = 200_000_000
            total_credit: 200_000_000
        });
    }

    // Set up CTF so resolveMarket(MARKET_ID) succeeds with YES win.
    // numerators[0]/denominator = 1_000_000/1_000_000 = 1 for outcome_side=0 (YES).
    function _setupResolvableMarket() internal {
        uint256[] memory numerators = new uint256[](2);
        numerators[0] = 1_000_000; // YES wins
        numerators[1] = 0;
        ctf.setPayoutNumerators(MARKET_ID, numerators);
        ctf.setPayoutDenominator(MARKET_ID, 1_000_000);
    }

    // FC-9: a "filled" bet stays ACTIVE on-chain; the FILLED operator attestation
    // authorizes the credit at action time. This helper leaves the bet ACTIVE.
    function _setupFilledBet() internal {
        _authorizeBetAndGetNullifier();
    }

    function _setupFilledAndResolvedBet() internal {
        _setupFilledBet();
        _setupResolvableMarket();
        vm.prank(operator);
        vault.resolveMarket(MARKET_ID);
    }

    // FILLED attestation for the active-path credit (full fill on NULLIFIER_1).
    function _filledAtt() internal view returns (OperatorAttestation memory att, bytes memory sig) {
        return _attest(NULLIFIER_1, vault.REPORT_FILLED(), 0, 0);
    }

    function test_creditSettlement_succeeds() public {
        _setupFilledAndResolvedBet();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _filledAtt();
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root), att, sig);
        assertTrue(registry.isSpent(NULLIFIER_2));
        (,,,,,, BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(BetStatus.CREDITED));
    }

    function test_creditSettlement_revert_nullifierSpent() public {
        _setupFilledAndResolvedBet();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _filledAtt();
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root), att, sig);
        bytes32 root2 = _currentRoot();
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root2), att, sig);
    }

    function test_creditSettlement_revert_betNotFound() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        SettlementPublicInputs memory inputs = _settlementInputs(root);
        inputs.nullifier_of_bet = keccak256("nonexistent");
        (OperatorAttestation memory att, bytes memory sig) = _attest(inputs.nullifier_of_bet, vault.REPORT_FILLED(), 0, 0);
        vm.expectRevert(Vault.BetNotFound.selector);
        vault.creditSettlement(DUMMY_PROOF, inputs, att, sig);
    }

    function test_creditSettlement_revert_wrongMarket() public {
        _setupFilledAndResolvedBet();
        bytes32 root = _currentRoot();
        SettlementPublicInputs memory inputs = _settlementInputs(root);
        inputs.market_id = keccak256("wrong_market");
        (OperatorAttestation memory att, bytes memory sig) = _filledAtt();
        vm.expectRevert(Vault.WrongMarket.selector);
        vault.creditSettlement(DUMMY_PROOF, inputs, att, sig);
    }

    function test_creditSettlement_revert_marketNotResolved() public {
        // Bet is ACTIVE (filled-but-unclaimed) but resolveMarket was never called.
        _setupFilledBet();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _filledAtt();
        vm.expectRevert(Vault.MarketNotResolved.selector);
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root), att, sig);
    }

    function test_creditSettlement_revert_invalidProof() public {
        _setupFilledAndResolvedBet();
        bytes32 root = _currentRoot();
        settlementVerifier.setShouldPass(false);
        (OperatorAttestation memory att, bytes memory sig) = _filledAtt();
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root), att, sig);
    }

    function test_creditSettlement_revert_doubleCreditAfterCredited() public {
        _setupFilledAndResolvedBet();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _filledAtt();
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root), att, sig);
        // Try to credit again with a new nullifier -- bet status is CREDITED, not ACTIVE/FILLED
        bytes32 root2 = _currentRoot();
        SettlementPublicInputs memory inputs2 = _settlementInputs(root2);
        inputs2.nullifier = keccak256("nullifier_3");
        vm.expectRevert(Vault.BetNotFilled.selector);
        vault.creditSettlement(DUMMY_PROOF, inputs2, att, sig);
    }

    function test_creditSettlement_succeeds_marketIdAboveBN254P() public {
        // Exercise the BN254 reduction path: when market_id >= BN254_P,
        // resolveMarket writes pendingCredit at the reduced key, so creditSettlement
        // must read from the same reduced key or it always reverts MarketNotResolved.
        uint256 BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        bytes32 large_market_id = bytes32(BN254_P + 1);

        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();

        vault.authorizeBet(DUMMY_PROOF, BetAuthPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_1,
            new_commitment: COMMITMENT_2,
            bet_amount: 100 * 1e6,
            price: 50_000_000,
            expected_shares: 200_000_000,
            market_id: large_market_id,
            outcome_side: 0,
            position_id: POSITION_ID
        }));

        uint256[] memory numerators = new uint256[](2);
        numerators[0] = 1_000_000;
        numerators[1] = 0;
        ctf.setPayoutNumerators(large_market_id, numerators);
        ctf.setPayoutDenominator(large_market_id, 1_000_000);
        vm.prank(operator);
        vault.resolveMarket(large_market_id);

        bytes32 root2 = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _filledAtt();
        vault.creditSettlement(DUMMY_PROOF, SettlementPublicInputs({
            merkle_root: root2,
            nullifier: NULLIFIER_2,
            new_commitment: COMMITMENT_3,
            nullifier_of_bet: NULLIFIER_1,
            market_id: large_market_id,
            total_credit: 200_000_000
        }), att, sig);

        (,,,,,, BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(BetStatus.CREDITED));
    }

    // =========================================================================
    // resolveMarket
    // =========================================================================

    function test_resolveMarket_succeeds() public {
        _setupResolvableMarket();
        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit Vault.MarketResolved(MARKET_ID, uint64(block.timestamp));
        vault.resolveMarket(MARKET_ID);
        assertEq(vault.pendingCredit(MARKET_ID, 0), 1); // YES side payout = 1
        assertEq(vault.pendingCredit(MARKET_ID, 1), 0); // NO side payout = 0
        assertEq(vault.marketResolvedAt(MARKET_ID), block.timestamp);
    }

    function test_resolveMarket_revert_conditionNotResolved() public {
        vm.prank(operator);
        vm.expectRevert(Vault.ConditionNotResolved.selector);
        vault.resolveMarket(MARKET_ID);
    }

    function test_resolveMarket_revert_notNA_market() public {
        // All-zero numerators = N/A; resolveMarket should revert NotNA
        uint256[] memory numerators = new uint256[](2);
        numerators[0] = 0;
        numerators[1] = 0;
        ctf.setPayoutNumerators(MARKET_ID, numerators);
        ctf.setPayoutDenominator(MARKET_ID, 1_000_000);
        vm.prank(operator);
        vm.expectRevert(Vault.NotNA.selector);
        vault.resolveMarket(MARKET_ID);
    }

    function test_resolveMarket_revert_alreadyResolved() public {
        _setupResolvableMarket();
        vm.prank(operator);
        vault.resolveMarket(MARKET_ID);
        // Second call should revert
        vm.prank(operator);
        vm.expectRevert(Vault.MarketAlreadyResolved.selector);
        vault.resolveMarket(MARKET_ID);
    }

    function test_resolveMarket_revert_onlyOperator() public {
        _setupResolvableMarket();
        vm.prank(attacker);
        vm.expectRevert(Vault.OnlyOperator.selector);
        vault.resolveMarket(MARKET_ID);
    }

    // =========================================================================
    // withdraw
    // =========================================================================

    function _withdrawInputs(bytes32 root, bytes32 recipientHash, bytes32 newCommitment)
        internal
        pure
        returns (WithdrawalPublicInputs memory)
    {
        return WithdrawalPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            withdrawal_amount: 500 * 1e6,
            recipient_hash: recipientHash,
            new_commitment: newCommitment
        });
    }

    function _recipientHash(address addr) internal view returns (bytes32) {
        return tree.hashTwo(bytes32(uint256(uint160(addr))), bytes32(0));
    }

    function test_withdraw_succeeds() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        bytes32 nextCommitment = COMMITMENT_2;
        uint256 balBefore = usdc.balanceOf(recipient);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash, nextCommitment), recipient);
        // FEE: recipient receives withdrawal_amount - withdrawalFeeUSDC ($0.10 default);
        // the fee stays in the pool and is tracked in feeAccumulator.
        assertEq(usdc.balanceOf(recipient) - balBefore, 500 * 1e6 - 100_000);
        assertEq(vault.feeAccumulator(), 100_000);
        assertTrue(registry.isSpent(NULLIFIER_2));
        assertTrue(tree.isKnownRoot(_currentRoot()));
    }

    function test_withdraw_emitsEvent() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        bytes32 nextCommitment = COMMITMENT_2;
        vm.expectEmit(true, false, false, true);
        emit Vault.Withdrawn(NULLIFIER_2, recipient, 500 * 1e6, nextCommitment);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash, nextCommitment), recipient);
    }

    function test_withdraw_partial_insertsRemainderCommitment() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        bytes32 nextCommitment = COMMITMENT_2;
        uint64 rootCountBefore = tree.rootCount();

        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash, nextCommitment), recipient);

        // The remainder commitment was inserted, so exactly one new root was produced.
        assertEq(tree.rootCount(), rootCountBefore + 1);
        assertTrue(tree.isKnownRoot(_currentRoot()));
    }

    function test_withdraw_full_skipsRemainderInsert() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        WithdrawalPublicInputs memory inputs = WithdrawalPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            withdrawal_amount: uint64(DEPOSIT_AMOUNT),
            recipient_hash: rHash,
            new_commitment: bytes32(0)
        });
        uint64 rootCountBefore = tree.rootCount();
        uint256 balBefore = usdc.balanceOf(recipient);

        vault.withdraw(DUMMY_PROOF, inputs, recipient);

        // FEE: net of the $0.10 withdrawal fee.
        assertEq(usdc.balanceOf(recipient) - balBefore, DEPOSIT_AMOUNT - 100_000);
        // Full withdrawal (new_commitment == 0) inserts no leaf → no new root.
        assertEq(tree.rootCount(), rootCountBefore);
    }

    function test_withdraw_revert_nullifierSpent() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash, COMMITMENT_2), recipient);
        bytes32 root2 = _currentRoot();
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root2, rHash, COMMITMENT_3), recipient);
    }

    function test_withdraw_revert_unknownRoot() public {
        bytes32 rHash = _recipientHash(recipient);
        vm.expectRevert(Vault.UnknownRoot.selector);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(keccak256("stale"), rHash, COMMITMENT_2), recipient);
    }

    function test_withdraw_revert_badRecipient() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        // Supply bob's address instead of recipient
        vm.expectRevert(Vault.BadRecipient.selector);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash, COMMITMENT_2), bob);
    }

    function test_withdraw_revert_invalidProof() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        withdrawalVerifier.setShouldPass(false);
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash, COMMITMENT_2), recipient);
    }

    // =========================================================================
    // betCancellationCredit
    // =========================================================================

    function _betCancelInputs(bytes32 root) internal pure returns (BetCancelPublicInputs memory) {
        return BetCancelPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            new_commitment: COMMITMENT_3,
            nullifier_of_bet: NULLIFIER_1
        });
    }

    // FC-9: a "failed" bet stays ACTIVE on-chain; the FAILED operator attestation
    // authorizes the cancellation credit at action time. This helper leaves it ACTIVE.
    function _setupFailedBet() internal {
        _authorizeBetAndGetNullifier();
    }

    // FAILED attestation for the active-path cancellation credit on NULLIFIER_1.
    function _failedAtt() internal view returns (OperatorAttestation memory att, bytes memory sig) {
        return _attest(NULLIFIER_1, vault.REPORT_FAILED(), 0, 0);
    }

    function test_betCancellationCredit_succeeds() public {
        _setupFailedBet();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _failedAtt();
        vault.betCancellationCredit(DUMMY_PROOF, _betCancelInputs(root), att, sig);
        assertTrue(registry.isSpent(NULLIFIER_2));
        (,,,,,, BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(BetStatus.CANCELLED_CREDITED));
    }

    function test_betCancellationCredit_revert_alreadyCredited() public {
        _setupFailedBet();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _failedAtt();
        vault.betCancellationCredit(DUMMY_PROOF, _betCancelInputs(root), att, sig);
        // Status is now CANCELLED_CREDITED, not ACTIVE/FAILED
        bytes32 root2 = _currentRoot();
        BetCancelPublicInputs memory inputs2 = _betCancelInputs(root2);
        inputs2.nullifier = keccak256("null_3");
        vm.expectRevert(Vault.BetNotFailed.selector);
        vault.betCancellationCredit(DUMMY_PROOF, inputs2, att, sig);
    }

    function test_betCancellationCredit_revert_betNotFailed() public {
        // Bet is ACTIVE with no attestation -> AttestationMismatch (empty att.nullifierOfBet).
        _authorizeBetAndGetNullifier();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _noAtt();
        vm.expectRevert(Vault.AttestationMismatch.selector);
        vault.betCancellationCredit(DUMMY_PROOF, _betCancelInputs(root), att, sig);
    }

    function test_betCancellationCredit_revert_invalidProof() public {
        _setupFailedBet();
        bytes32 root = _currentRoot();
        betCancelVerifier.setShouldPass(false);
        (OperatorAttestation memory att, bytes memory sig) = _failedAtt();
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.betCancellationCredit(DUMMY_PROOF, _betCancelInputs(root), att, sig);
    }

    // =========================================================================
    // naCancellationCredit
    // =========================================================================

    function _naCancelInputs(bytes32 root) internal pure returns (NACancelPublicInputs memory) {
        return NACancelPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            new_commitment: COMMITMENT_3,
            nullifier_of_bet: NULLIFIER_1,
            market_id: MARKET_ID
        });
    }

    // FC-9: the bet stays ACTIVE on-chain; a FILLED (or FAILED) operator attestation
    // authorizes the N/A credit. This helper leaves the bet ACTIVE and resolves N/A.
    function _setupNAMarket() internal {
        _authorizeBetAndGetNullifier();
        // Set all-zero numerators with non-zero denominator (N/A resolution)
        uint256[] memory numerators = new uint256[](2);
        numerators[0] = 0;
        numerators[1] = 0;
        ctf.setPayoutNumerators(MARKET_ID, numerators);
        ctf.setPayoutDenominator(MARKET_ID, 1_000_000); // C2: denominator > 0 confirms condition resolved
        // FC-11: operator registers the real conditionId so naCancellation queries CTF correctly.
        vm.prank(operator);
        vault.registerCondition(MARKET_ID);
    }

    function test_naCancellationCredit_succeeds() public {
        _setupNAMarket();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _filledAtt();
        vault.naCancellationCredit(DUMMY_PROOF, _naCancelInputs(root), att, sig);
        assertTrue(registry.isSpent(NULLIFIER_2));
        (,,,,,, BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(BetStatus.CANCELLED_CREDITED));
    }

    function test_naCancellationCredit_revert_notNA() public {
        _authorizeBetAndGetNullifier();
        // Non-zero numerators = not N/A; denominator must be set so C2 passes
        uint256[] memory numerators = new uint256[](2);
        numerators[0] = 0;
        numerators[1] = 1_000_000; // YES wins
        ctf.setPayoutNumerators(MARKET_ID, numerators);
        ctf.setPayoutDenominator(MARKET_ID, 1_000_000);
        vm.prank(operator);
        vault.registerCondition(MARKET_ID); // FC-11
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _filledAtt();
        vm.expectRevert(Vault.NotNA.selector);
        vault.naCancellationCredit(DUMMY_PROOF, _naCancelInputs(root), att, sig);
    }

    function test_naCancellationCredit_revert_nullifierSpent() public {
        _setupNAMarket();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _filledAtt();
        vault.naCancellationCredit(DUMMY_PROOF, _naCancelInputs(root), att, sig);
        // Second call with the same nullifier (NULLIFIER_2) → NullifierSpent
        bytes32 root2 = _currentRoot();
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.naCancellationCredit(DUMMY_PROOF, _naCancelInputs(root2), att, sig);
    }

    function test_naCancellationCredit_revert_wrongMarket() public {
        _setupNAMarket();
        bytes32 root = _currentRoot();
        NACancelPublicInputs memory inputs = _naCancelInputs(root);
        inputs.market_id = keccak256("wrong");
        (OperatorAttestation memory att, bytes memory sig) = _filledAtt();
        vm.expectRevert(Vault.WrongMarket.selector);
        vault.naCancellationCredit(DUMMY_PROOF, inputs, att, sig);
    }

    function test_naCancellationCredit_revert_invalidProof() public {
        _setupNAMarket();
        bytes32 root = _currentRoot();
        cancelCreditVerifier.setShouldPass(false);
        (OperatorAttestation memory att, bytes memory sig) = _filledAtt();
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.naCancellationCredit(DUMMY_PROOF, _naCancelInputs(root), att, sig);
    }

    // SEC-004: an ACTIVE bet with NO attestation must NOT be N/A-creditable — this prevents a
    // full refund while a Polymarket fill could still be in flight (pool-accounting race).
    function test_naCancellationCredit_revert_activeBet() public {
        _authorizeBetAndGetNullifier(); // leaves the bet ACTIVE (no operator attestation)
        uint256[] memory numerators = new uint256[](2);
        numerators[0] = 0;
        numerators[1] = 0;
        ctf.setPayoutNumerators(MARKET_ID, numerators);
        ctf.setPayoutDenominator(MARKET_ID, 1_000_000);
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _noAtt();
        vm.expectRevert(Vault.AttestationMismatch.selector);
        vault.naCancellationCredit(DUMMY_PROOF, _naCancelInputs(root), att, sig);
    }

    // SEC-004: a FAILED attestation is also accepted for the N/A credit path.
    function test_naCancellationCredit_fromFailed_succeeds() public {
        _authorizeBetAndGetNullifier();
        uint256[] memory numerators = new uint256[](2);
        numerators[0] = 0;
        numerators[1] = 0;
        ctf.setPayoutNumerators(MARKET_ID, numerators);
        ctf.setPayoutDenominator(MARKET_ID, 1_000_000);
        vm.prank(operator);
        vault.registerCondition(MARKET_ID); // FC-11
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _failedAtt();
        vault.naCancellationCredit(DUMMY_PROOF, _naCancelInputs(root), att, sig);
        (,,,,,, BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(BetStatus.CANCELLED_CREDITED));
    }

    // =========================================================================
    // Merkle root window edge cases
    // =========================================================================

    function test_oldRootStillAccepted() public {
        // Capture the initial (empty-tree) root, then insert 29 more leaves.
        // FC-3: with the 1024 window it is comfortably still accepted.
        bytes32 initialRoot = tree.currentRoot();

        for (uint32 i = 0; i < 29; i++) {
            vm.prank(alice);
            vault.deposit(DUMMY_PROOF, bytes32(uint256(i + 1)), DEPOSIT_CAP / 30);
        }
        assertTrue(tree.isKnownRoot(initialRoot));
    }

    /// FC-3: a root far older than the legacy 30-root window is still accepted
    /// (the liveness headroom the bigger window buys), while a never-seen root is
    /// still rejected at the Vault entrypoint. Real eviction mechanics are covered
    /// by the tree unit test (SmallWindowTree) without inserting 1024+ leaves here.
    function test_rootPastLegacyWindowStillAccepted() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 oldRoot = _currentRoot();

        // 50 more inserts — well beyond the old 30-root window.
        for (uint256 i = 0; i < 50; i++) {
            address user = address(uint160(0x1000 + i));
            usdc.mint(user, DEPOSIT_AMOUNT);
            vm.prank(user);
            usdc.approve(address(vault), DEPOSIT_AMOUNT);
            vm.prank(user);
            vault.deposit(DUMMY_PROOF, bytes32(uint256(i + 100)), DEPOSIT_AMOUNT);
        }
        assertTrue(tree.isKnownRoot(oldRoot), "root 50 inserts deep still in the 1024 window");

        // A fabricated, never-inserted root is rejected.
        BetAuthPublicInputs memory inputs = _betAuthInputs(keccak256("never_seen"));
        inputs.nullifier = keccak256("fresh_nullifier");
        vm.expectRevert(Vault.UnknownRoot.selector);
        vault.authorizeBet(DUMMY_PROOF, inputs);
    }

    // =========================================================================
    // Status transition safety
    // =========================================================================

    // FC-9: ACTIVE bet -> FAILED attestation -> CANCELLED_CREDITED via betCancellationCredit.
    function test_statusTransition_activeToFailed() public {
        _authorizeBetAndGetNullifier();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _failedAtt();
        vault.betCancellationCredit(DUMMY_PROOF, _betCancelInputs(root), att, sig);
        (,,,,,, BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(BetStatus.CANCELLED_CREDITED));
    }

    function test_cannotDoubleCreditAfterCancelledCredited() public {
        _setupFailedBet();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _failedAtt();
        vault.betCancellationCredit(DUMMY_PROOF, _betCancelInputs(root), att, sig);

        bytes32 root2 = _currentRoot();
        BetCancelPublicInputs memory inputs2 = _betCancelInputs(root2);
        inputs2.nullifier = keccak256("null_3");
        // status is now CANCELLED_CREDITED, not ACTIVE/FAILED -> revert BetNotFailed
        vm.expectRevert(Vault.BetNotFailed.selector);
        vault.betCancellationCredit(DUMMY_PROOF, inputs2, att, sig);
    }

    // =========================================================================
    // Admin
    // =========================================================================

    function test_proposeVerifier_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        vault.proposeVerifier(0, address(betAuthVerifier));
    }

    function test_proposeVerifier_rejectsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(Vault.ZeroAddress.selector);
        vault.proposeVerifier(0, address(0));
    }

    function test_acceptVerifier_rejectsBeforeTimelock() public {
        address newVerifier = address(new MockVerifier(true));
        vm.prank(owner);
        vault.proposeVerifier(0, newVerifier);
        vm.prank(owner);
        vm.expectRevert(Vault.VerifierTimelockActive.selector);
        vault.acceptVerifier(0);
    }

    function test_setSigningLayerOperator_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        vault.setSigningLayerOperator(attacker);
    }

    // SEC-006: accepting a verifier slot that was never proposed must revert (pending == 0),
    // not silently blank the active verifier for that proof type.
    function test_acceptVerifier_revert_neverProposed() public {
        vm.prank(owner);
        vm.expectRevert(Vault.ZeroAddress.selector);
        vault.acceptVerifier(200); // slot 200 was never proposed
    }

    // =========================================================================
    // fundPolymarketWallet (SEC-007)
    // =========================================================================

    function _fundVault() internal {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_CAP); // vault now holds $50k USDC
    }

    function test_fundPolymarketWallet_happyPath() public {
        _fundVault();
        uint256 amount = 10_000 * 1e6;
        vm.prank(operator);
        vault.fundPolymarketWallet(amount);
        assertEq(vault.deployedToPolymarket(), amount);
        assertEq(usdc.balanceOf(address(vault)), DEPOSIT_CAP - amount);
    }

    function test_fundPolymarketWallet_revert_whenPaused() public {
        _fundVault();
        vm.prank(owner);
        vault.pause();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        vault.fundPolymarketWallet(1_000 * 1e6);
    }

    function test_fundPolymarketWallet_revert_capExceeded() public {
        _fundVault();
        vm.prank(owner);
        vault.setDeploymentCap(5_000 * 1e6);
        vm.prank(operator);
        vm.expectRevert(Vault.DeployCapExceeded.selector);
        vault.fundPolymarketWallet(5_000 * 1e6 + 1);
    }

    function test_fundPolymarketWallet_revert_onlyOperator() public {
        _fundVault();
        vm.prank(attacker);
        vm.expectRevert(Vault.OnlyOperator.selector);
        vault.fundPolymarketWallet(1_000 * 1e6);
    }

    function test_setDeploymentCap_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        vault.setDeploymentCap(1);
    }

    // =========================================================================
    // adminCancelBet
    // =========================================================================

    function test_adminCancelBet_happyPath() public {
        _authorizeBetAndGetNullifier();
        vm.warp(block.timestamp + vault.adminCancelTimelock() + 1);
        vm.prank(owner);
        vm.expectEmit(true, false, false, false);
        emit Vault.AdminBetCancelled(NULLIFIER_1);
        vault.adminCancelBet(NULLIFIER_1);
        (,,,,,, BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(BetStatus.FAILED));
    }

    function test_adminCancelBet_revertBeforeTimelock() public {
        _authorizeBetAndGetNullifier();
        vm.warp(block.timestamp + vault.adminCancelTimelock() - 1);
        vm.prank(owner);
        vm.expectRevert(Vault.BetTimeoutNotElapsed.selector);
        vault.adminCancelBet(NULLIFIER_1);
    }

    // FC-9: a credited bet is no longer ACTIVE, so adminCancelBet reverts BetNotActive.
    function test_adminCancelBet_revertNotActive() public {
        _setupFailedBet();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _failedAtt();
        vault.betCancellationCredit(DUMMY_PROOF, _betCancelInputs(root), att, sig); // -> CANCELLED_CREDITED
        vm.warp(block.timestamp + vault.adminCancelTimelock() + 1);
        vm.prank(owner);
        vm.expectRevert(Vault.BetNotActive.selector);
        vault.adminCancelBet(NULLIFIER_1);
    }

    function test_adminCancelBet_revertNotOwner() public {
        _authorizeBetAndGetNullifier();
        vm.warp(block.timestamp + vault.adminCancelTimelock() + 1);
        vm.prank(attacker);
        vm.expectRevert();
        vault.adminCancelBet(NULLIFIER_1);
    }

    // =========================================================================
    // FC-1: reportSold + closePosition (pre-settlement secondary sale)
    // =========================================================================

    uint64 constant EXPECTED_SHARES = 200_000_000; // matches _betAuthInputs
    uint64 constant CLOSE_PROCEEDS  = 80 * 1e6;

    function _closeInputs(bytes32 root) internal pure returns (ClosePublicInputs memory) {
        return ClosePublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            new_commitment: COMMITMENT_3,
            nullifier_of_bet: NULLIFIER_1
        });
    }

    // SOLD attestation covering the full position on NULLIFIER_1.
    function _soldAtt(uint64 shares, uint64 proceeds)
        internal
        view
        returns (OperatorAttestation memory att, bytes memory sig)
    {
        return _attest(NULLIFIER_1, vault.REPORT_SOLD(), shares, proceeds);
    }

    function test_closePosition_fullClose_credited() public {
        _setupFilledBet(); // ACTIVE (full fill)
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _soldAtt(EXPECTED_SHARES, CLOSE_PROCEEDS);

        vm.expectEmit(true, false, false, true);
        emit Vault.BetSold(NULLIFIER_1, EXPECTED_SHARES, CLOSE_PROCEEDS);
        vm.expectEmit(true, false, false, true);
        emit Vault.PositionClosed(NULLIFIER_2, NULLIFIER_1, COMMITMENT_3, true);
        vault.closePosition(DUMMY_PROOF, _closeInputs(root), att, sig);

        assertTrue(registry.isSpent(NULLIFIER_2));
        (,,, uint64 shares,,, BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(BetStatus.CLOSED_CREDITED));
        assertEq(shares, EXPECTED_SHARES); // unchanged on full close
    }

    function test_closePosition_revert_onlyOperatorSig() public {
        _setupFilledBet();
        bytes32 root = _currentRoot();
        // SOLD attestation signed by a non-operator key -> InvalidAttestation.
        OperatorAttestation memory att =
            OperatorAttestation({nullifierOfBet: NULLIFIER_1, reportType: vault.REPORT_SOLD(), amountA: EXPECTED_SHARES, amountB: CLOSE_PROCEEDS});
        bytes32 structHash = keccak256(abi.encode(ATT_TYPEHASH, att.nullifierOfBet, att.reportType, att.amountA, att.amountB));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xBAD), digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.expectRevert(Vault.InvalidAttestation.selector);
        vault.closePosition(DUMMY_PROOF, _closeInputs(root), att, sig);
    }

    function test_closePosition_revert_invalidShares_zero() public {
        _setupFilledBet();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _soldAtt(0, CLOSE_PROCEEDS);
        vm.expectRevert(Vault.InvalidSoldShares.selector);
        vault.closePosition(DUMMY_PROOF, _closeInputs(root), att, sig);
    }

    function test_closePosition_revert_invalidShares_tooMany() public {
        _setupFilledBet();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _soldAtt(EXPECTED_SHARES + 1, CLOSE_PROCEEDS);
        vm.expectRevert(Vault.InvalidSoldShares.selector);
        vault.closePosition(DUMMY_PROOF, _closeInputs(root), att, sig);
    }

    // FC-1: a partial sell (sold_shares < expected_shares) now SUCCEEDS — it credits the proceeds,
    // records cumulative sold_shares/sell_proceeds, and leaves the record FILLED so the unsold
    // remainder still settles at resolution. expected_shares stays the original committed size.
    function test_closePosition_partialClose_creditsAndStaysFilled() public {
        _setupFilledBet(); // ACTIVE (full fill), expected_shares = 200e6
        bytes32 root = _currentRoot();
        uint64 soldShares = 120_000_000;
        (OperatorAttestation memory att, bytes memory sig) = _soldAtt(soldShares, CLOSE_PROCEEDS);

        vm.expectEmit(true, false, false, true);
        emit Vault.BetSold(NULLIFIER_1, soldShares, CLOSE_PROCEEDS); // delta == cumulative on the first close
        vm.expectEmit(true, false, false, true);
        emit Vault.PositionClosed(NULLIFIER_2, NULLIFIER_1, COMMITMENT_3, false); // partial → not full
        vault.closePosition(DUMMY_PROOF, _closeInputs(root), att, sig);

        assertTrue(registry.isSpent(NULLIFIER_2));
        (,,, uint64 shares,,, BetStatus status, uint64 proceeds, uint64 sold,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(BetStatus.FILLED)); // stays open for the remainder
        assertEq(shares, EXPECTED_SHARES);                // original committed size unchanged
        assertEq(sold, soldShares);                       // cumulative sold recorded
        assertEq(proceeds, CLOSE_PROCEEDS);               // cumulative proceeds recorded
    }

    // Settlement race: a resolved market settles, it cannot be closed.
    function test_closePosition_revert_resolvedMarket() public {
        _setupFilledAndResolvedBet();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _soldAtt(EXPECTED_SHARES, CLOSE_PROCEEDS);
        vm.expectRevert(Vault.CannotCloseResolvedMarket.selector);
        vault.closePosition(DUMMY_PROOF, _closeInputs(root), att, sig);
    }

    // Double-credit regression: a fully-closed bet is terminal (CLOSED_CREDITED) and cannot
    // be re-credited via any path (e.g. betCancellationCredit reverts BetNotFailed).
    function test_closePosition_thenCancel_reverts() public {
        _setupFilledBet();
        (OperatorAttestation memory sold, bytes memory soldSig) = _soldAtt(EXPECTED_SHARES, CLOSE_PROCEEDS);
        vault.closePosition(DUMMY_PROOF, _closeInputs(_currentRoot()), sold, soldSig);

        bytes32 root = _currentRoot();
        BetCancelPublicInputs memory inputs = _betCancelInputs(root);
        inputs.nullifier = keccak256("cancel_after_close");
        (OperatorAttestation memory att, bytes memory sig) = _failedAtt();
        vm.expectRevert(Vault.BetNotFailed.selector);
        vault.betCancellationCredit(DUMMY_PROOF, inputs, att, sig);
    }

    // A position with no SOLD attestation (empty att) cannot be closed.
    function test_closePosition_revert_noAttestation() public {
        _setupFilledBet();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _noAtt();
        vm.expectRevert(Vault.AttestationMismatch.selector);
        vault.closePosition(DUMMY_PROOF, _closeInputs(root), att, sig);
    }

    // Double-close: after a full close the record is terminal; a second close with a
    // fresh note nullifier reverts on the status guard (no second credit).
    function test_closePosition_revert_doubleClose() public {
        _setupFilledBet();
        (OperatorAttestation memory sold, bytes memory soldSig) = _soldAtt(EXPECTED_SHARES, CLOSE_PROCEEDS);
        bytes32 root = _currentRoot();
        vault.closePosition(DUMMY_PROOF, _closeInputs(root), sold, soldSig);

        ClosePublicInputs memory again = ClosePublicInputs({
            merkle_root: _currentRoot(),
            nullifier: keccak256("nullifier_fresh"),
            new_commitment: keccak256("commitment_fresh"),
            nullifier_of_bet: NULLIFIER_1
        });
        vm.expectRevert(Vault.BetNotClosing.selector);
        vault.closePosition(DUMMY_PROOF, again, sold, soldSig);
    }

    function test_closePosition_revert_nullifierSpent() public {
        _setupFilledBet();
        (OperatorAttestation memory sold, bytes memory soldSig) = _soldAtt(EXPECTED_SHARES, CLOSE_PROCEEDS);
        bytes32 root = _currentRoot();
        vault.closePosition(DUMMY_PROOF, _closeInputs(root), sold, soldSig);
        // Re-using the same note nullifier must revert (it is already spent).
        ClosePublicInputs memory replay = _closeInputs(_currentRoot());
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.closePosition(DUMMY_PROOF, replay, sold, soldSig);
    }

    // Replay defense (FC-1): after a partial close records sold_shares, re-submitting the SAME SOLD
    // attestation (even with a fresh note nullifier) reverts — att.amountA == rec.sold_shares.
    function test_closePosition_replaySameSold_reverts() public {
        _setupFilledBet();
        (OperatorAttestation memory att, bytes memory sig) = _soldAtt(120_000_000, CLOSE_PROCEEDS);
        vault.closePosition(DUMMY_PROOF, _closeInputs(_currentRoot()), att, sig);

        ClosePublicInputs memory replay = ClosePublicInputs({
            merkle_root: _currentRoot(),
            nullifier: keccak256("close_replay_nullifier"),
            new_commitment: keccak256("close_replay_commitment"),
            nullifier_of_bet: NULLIFIER_1
        });
        vm.expectRevert(Vault.InvalidSoldShares.selector);
        vault.closePosition(DUMMY_PROOF, replay, att, sig);
    }

    // Cumulative delta (v2-facing): a second close reporting higher cumulative sold credits only the
    // delta proceeds and, when it reaches expected_shares, completes the position (CLOSED_CREDITED).
    function test_closePosition_secondClose_creditsDeltaAndCompletes() public {
        _setupFilledBet();
        (OperatorAttestation memory a1, bytes memory s1) = _soldAtt(120_000_000, CLOSE_PROCEEDS); // 80e6
        vault.closePosition(DUMMY_PROOF, _closeInputs(_currentRoot()), a1, s1);

        (OperatorAttestation memory a2, bytes memory s2) = _soldAtt(EXPECTED_SHARES, 130_000_000); // cumulative
        ClosePublicInputs memory inputs2 = ClosePublicInputs({
            merkle_root: _currentRoot(),
            nullifier: keccak256("close_2_nullifier"),
            new_commitment: keccak256("close_2_commitment"),
            nullifier_of_bet: NULLIFIER_1
        });
        vm.expectEmit(true, false, false, true);
        emit Vault.BetSold(NULLIFIER_1, EXPECTED_SHARES - 120_000_000, 130_000_000 - CLOSE_PROCEEDS); // delta
        vault.closePosition(DUMMY_PROOF, inputs2, a2, s2);

        (,,,,,, BetStatus status, uint64 proceeds, uint64 sold,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(BetStatus.CLOSED_CREDITED));
        assertEq(sold, EXPECTED_SHARES);
        assertEq(proceeds, 130_000_000);
    }

    // v2-facing guard: a second close must not report LOWER cumulative proceeds.
    function test_closePosition_revert_nonMonotonicProceeds() public {
        _setupFilledBet();
        (OperatorAttestation memory a1, bytes memory s1) = _soldAtt(120_000_000, CLOSE_PROCEEDS); // 80e6
        vault.closePosition(DUMMY_PROOF, _closeInputs(_currentRoot()), a1, s1);

        (OperatorAttestation memory a2, bytes memory s2) = _soldAtt(150_000_000, 70_000_000); // more shares, less proceeds
        ClosePublicInputs memory inputs2 = ClosePublicInputs({
            merkle_root: _currentRoot(),
            nullifier: keccak256("close_nm_nullifier"),
            new_commitment: keccak256("close_nm_commitment"),
            nullifier_of_bet: NULLIFIER_1
        });
        vm.expectRevert(Vault.NonMonotonicProceeds.selector);
        vault.closePosition(DUMMY_PROOF, inputs2, a2, s2);
    }

    // FC-1: after a partial close, settlement credits ONLY the unsold remainder (expected - sold).
    function test_settlement_afterPartialClose_creditsRemainderOnly() public {
        _setupFilledBet();
        (OperatorAttestation memory sold, bytes memory soldSig) = _soldAtt(120_000_000, CLOSE_PROCEEDS);
        vault.closePosition(DUMMY_PROOF, _closeInputs(_currentRoot()), sold, soldSig);

        _setupResolvableMarket();
        vm.prank(operator);
        vault.resolveMarket(MARKET_ID); // payout_per_share = 1

        // Remainder = 200e6 - 120e6 = 80e6; total_credit must match (80e6 * 1).
        (OperatorAttestation memory fatt, bytes memory fsig) = _filledAtt();
        SettlementPublicInputs memory ok = SettlementPublicInputs({
            merkle_root: _currentRoot(),
            nullifier: keccak256("settle_remainder_nullifier"),
            new_commitment: keccak256("settle_remainder_commitment"),
            nullifier_of_bet: NULLIFIER_1,
            market_id: MARKET_ID,
            total_credit: 80_000_000
        });
        vault.creditSettlement(DUMMY_PROOF, ok, fatt, fsig);
        (,,,,,, BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(BetStatus.CREDITED));
    }

    // BUG-1 regression: settling a partially-closed position with the FULL (pre-close) credit reverts.
    function test_settlement_afterPartialClose_fullCredit_reverts() public {
        _setupFilledBet();
        (OperatorAttestation memory sold, bytes memory soldSig) = _soldAtt(120_000_000, CLOSE_PROCEEDS);
        vault.closePosition(DUMMY_PROOF, _closeInputs(_currentRoot()), sold, soldSig);
        _setupResolvableMarket();
        vm.prank(operator);
        vault.resolveMarket(MARKET_ID);

        SettlementPublicInputs memory bad = _settlementInputs(_currentRoot()); // total_credit = 200e6 (full)
        bad.nullifier = keccak256("settle_bad_nullifier");
        bad.new_commitment = keccak256("settle_bad_commitment");
        (OperatorAttestation memory fatt, bytes memory fsig) = _filledAtt();
        vm.expectRevert(bytes("Invalid total_credit"));
        vault.creditSettlement(DUMMY_PROOF, bad, fatt, fsig);
    }

    // FC-1: once a position was (partially) closed, N/A cancellation is blocked (would double-pay).
    function test_naCancel_afterPartialClose_reverts() public {
        _setupFilledBet();
        (OperatorAttestation memory sold, bytes memory soldSig) = _soldAtt(120_000_000, CLOSE_PROCEEDS);
        vault.closePosition(DUMMY_PROOF, _closeInputs(_currentRoot()), sold, soldSig);

        NACancelPublicInputs memory inputs = _naCancelInputs(_currentRoot());
        inputs.nullifier = keccak256("na_after_close_nullifier");
        inputs.new_commitment = keccak256("na_after_close_commitment");
        (OperatorAttestation memory att, bytes memory sig) = _noAtt(); // ignored (status FILLED → sold>0 reverts first)
        vm.expectRevert(Vault.AlreadyPartiallyClosed.selector);
        vault.naCancellationCredit(DUMMY_PROOF, inputs, att, sig);
    }

    // BUG-2 / ordering: partialFillCredit requires ACTIVE; a (partially) closed bet is FILLED → reverts.
    function test_partialFillCredit_afterPartialClose_reverts() public {
        _setupFilledBet(); // ACTIVE
        (OperatorAttestation memory sold, bytes memory soldSig) = _soldAtt(120_000_000, CLOSE_PROCEEDS);
        vault.closePosition(DUMMY_PROOF, _closeInputs(_currentRoot()), sold, soldSig); // → FILLED

        PartialFillPublicInputs memory inputs = _partialInputs(_currentRoot());
        inputs.nullifier = keccak256("pf_after_close_nullifier");
        (OperatorAttestation memory att, bytes memory sig) = _partialAtt(PF_FILLED_SHARES, PF_SPENT_AMOUNT);
        vm.expectRevert(Vault.BetNotPartialFilled.selector);
        vault.partialFillCredit(DUMMY_PROOF, inputs, att, sig);
    }

    // ─── FC-4: native limit orders (RESTING / partial-fill credit) ───────────────

    uint64 constant PF_FILLED_SHARES = 120_000_000; // < EXPECTED_SHARES (200_000_000)
    uint64 constant PF_SPENT_AMOUNT  = 60 * 1e6;    // < bet_amount (100 * 1e6); refund = 40 * 1e6

    function _partialInputs(bytes32 root) internal pure returns (PartialFillPublicInputs memory) {
        return PartialFillPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            new_commitment: COMMITMENT_3,
            nullifier_of_bet: NULLIFIER_1
        });
    }

    // PARTIAL attestation on NULLIFIER_1 (filled_shares, spent_amount).
    function _partialAtt(uint64 filled, uint64 spent)
        internal
        view
        returns (OperatorAttestation memory att, bytes memory sig)
    {
        return _attest(NULLIFIER_1, vault.REPORT_PARTIAL(), filled, spent);
    }

    function test_partialFillCredit_succeeds_normalizesToFilled() public {
        _authorizeBetAndGetNullifier(); // ACTIVE
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _partialAtt(PF_FILLED_SHARES, PF_SPENT_AMOUNT);

        vm.expectEmit(true, false, false, true);
        emit Vault.PartialFillCredited(NULLIFIER_2, NULLIFIER_1, COMMITMENT_3);
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(root), att, sig);

        assertTrue(registry.isSpent(NULLIFIER_2));
        (,,, uint64 shares, uint64 amount,, BetStatus status,,, uint64 filled, uint64 spent) =
            vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(BetStatus.FILLED));
        assertEq(shares, PF_FILLED_SHARES);   // normalized to the shares actually bought
        assertEq(amount, PF_SPENT_AMOUNT);    // normalized to the amount actually spent
        assertEq(filled, 0);
        assertEq(spent, 0);
    }

    // Strict partial: filled_shares must be 0 < filled < expected_shares.
    function test_partialFillCredit_revert_invalidFilledShares_zero() public {
        _authorizeBetAndGetNullifier();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _partialAtt(0, PF_SPENT_AMOUNT);
        vm.expectRevert(Vault.InvalidFilledShares.selector);
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(root), att, sig);
    }

    function test_partialFillCredit_revert_invalidFilledShares_full() public {
        _authorizeBetAndGetNullifier();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _partialAtt(EXPECTED_SHARES, PF_SPENT_AMOUNT);
        vm.expectRevert(Vault.InvalidFilledShares.selector);
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(root), att, sig);
    }

    // B-relax: spent_amount must be 0 < spent <= bet_amount. Zero reverts; spent == bet is a valid
    // short fill (full budget spent, fewer shares); spent > bet is rejected.
    function test_partialFillCredit_revert_invalidSpentAmount_zero() public {
        _authorizeBetAndGetNullifier();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _partialAtt(PF_FILLED_SHARES, 0);
        vm.expectRevert(Vault.InvalidSpentAmount.selector);
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(root), att, sig);
    }

    // L3 (B-relax): spent_amount == bet_amount with filled < expected is a VALID short fill (full
    // budget spent, fewer shares bought) — refund 0, normalize expected_shares down, bet_amount
    // unchanged. A round-number market order hits this; the old strict `<` reverted it and left
    // settlement to over-credit on the committed expected_shares.
    function test_partialFillCredit_succeeds_spentEqualsBet() public {
        _authorizeBetAndGetNullifier();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _partialAtt(PF_FILLED_SHARES, uint64(100 * 1e6));
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(root), att, sig);

        (,,, uint64 shares, uint64 amount,, BetStatus status,,, uint64 filled, uint64 spent) =
            vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(BetStatus.FILLED));
        assertEq(shares, PF_FILLED_SHARES);   // normalized down to shares actually bought
        assertEq(amount, uint64(100 * 1e6));  // full budget spent → bet_amount unchanged (refund 0)
        assertEq(filled, 0);
        assertEq(spent, 0);
    }

    // spent_amount STRICTLY greater than bet_amount is impossible (the on-chain debit caps it) and
    // is rejected — guards against an operator over-refund.
    function test_partialFillCredit_revert_invalidSpentAmount_overBet() public {
        _authorizeBetAndGetNullifier();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _partialAtt(PF_FILLED_SHARES, uint64(100 * 1e6 + 1));
        vm.expectRevert(Vault.InvalidSpentAmount.selector);
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(root), att, sig);
    }

    function test_partialFillCredit_revert_notActive() public {
        // After a first partial credit the record is FILLED; a second partial credit reverts.
        _authorizeBetAndGetNullifier();
        (OperatorAttestation memory att, bytes memory sig) = _partialAtt(PF_FILLED_SHARES, PF_SPENT_AMOUNT);
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(_currentRoot()), att, sig);

        PartialFillPublicInputs memory inputs = _partialInputs(_currentRoot());
        inputs.nullifier = keccak256("partial_again");
        vm.expectRevert(Vault.BetNotPartialFilled.selector);
        vault.partialFillCredit(DUMMY_PROOF, inputs, att, sig);
    }

    function test_partialFillCredit_revert_invalidProof() public {
        _authorizeBetAndGetNullifier();
        bytes32 root = _currentRoot();
        partialCreditVerifier.setShouldPass(false);
        (OperatorAttestation memory att, bytes memory sig) = _partialAtt(PF_FILLED_SHARES, PF_SPENT_AMOUNT);
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(root), att, sig);
    }

    function test_partialFillCredit_revert_nullifierSpent() public {
        _authorizeBetAndGetNullifier();
        (OperatorAttestation memory att, bytes memory sig) = _partialAtt(PF_FILLED_SHARES, PF_SPENT_AMOUNT);
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(_currentRoot()), att, sig);
        // Replaying the same note nullifier must revert (already spent).
        PartialFillPublicInputs memory replay = _partialInputs(_currentRoot());
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.partialFillCredit(DUMMY_PROOF, replay, att, sig);
    }

    // After partial credit normalizes the record to FILLED, settlement works on the
    // reduced (filled) shares with NO attestation (status is on-chain FILLED).
    function test_partialFillCredit_thenSettleRemainder() public {
        _authorizeBetAndGetNullifier();
        (OperatorAttestation memory pAtt, bytes memory pSig) = _partialAtt(PF_FILLED_SHARES, PF_SPENT_AMOUNT);
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(_currentRoot()), pAtt, pSig);

        _setupResolvableMarket();
        vm.prank(operator);
        vault.resolveMarket(MARKET_ID);

        SettlementPublicInputs memory s = SettlementPublicInputs({
            merkle_root: _currentRoot(),
            nullifier: keccak256("nullifier_settle_pf"),
            new_commitment: keccak256("commitment_settle_pf"),
            nullifier_of_bet: NULLIFIER_1,
            market_id: MARKET_ID,
            total_credit: PF_FILLED_SHARES // payout_per_share = 1
        });
        (OperatorAttestation memory att, bytes memory sig) = _noAtt();
        vault.creditSettlement(DUMMY_PROOF, s, att, sig);
        (,,,,,, BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(BetStatus.CREDITED));
    }

    // =========================================================================
    // Consolidate (FC-8: merge up to 4 notes into one)
    // =========================================================================

    function _consolidateInputs(bytes32[4] memory nulls, bytes32 newCommitment)
        internal
        view
        returns (ConsolidatePublicInputs memory)
    {
        return ConsolidatePublicInputs({
            merkle_root: _currentRoot(),
            nullifier: nulls,
            new_commitment: newCommitment
        });
    }

    function test_consolidate_happyPath_twoActive() public {
        uint64 idxBefore = tree.nextIndex();
        bytes32[4] memory nulls;
        nulls[0] = NULLIFIER_1;
        nulls[1] = NULLIFIER_2;
        // slots 2,3 left as bytes32(0) (inactive)

        vm.expectEmit(false, false, false, true);
        emit Vault.Consolidated(nulls, COMMITMENT_3);
        vault.consolidate(DUMMY_PROOF, _consolidateInputs(nulls, COMMITMENT_3));

        assertTrue(registry.isSpent(NULLIFIER_1), "slot 0 nullifier spent");
        assertTrue(registry.isSpent(NULLIFIER_2), "slot 1 nullifier spent");
        assertEq(tree.nextIndex(), idxBefore + 1, "exactly one new leaf inserted");
    }

    function test_consolidate_happyPath_fourActive() public {
        bytes32 n3 = keccak256("consolidate_n3");
        bytes32 n4 = keccak256("consolidate_n4");
        bytes32[4] memory nulls = [NULLIFIER_1, NULLIFIER_2, n3, n4];

        vault.consolidate(DUMMY_PROOF, _consolidateInputs(nulls, COMMITMENT_3));

        assertTrue(registry.isSpent(NULLIFIER_1));
        assertTrue(registry.isSpent(NULLIFIER_2));
        assertTrue(registry.isSpent(n3));
        assertTrue(registry.isSpent(n4));
    }

    function test_consolidate_noBetRecordNoTokenMovement() public {
        uint256 vaultUsdcBefore = usdc.balanceOf(address(vault));
        bytes32[4] memory nulls;
        nulls[0] = NULLIFIER_1;
        vault.consolidate(DUMMY_PROOF, _consolidateInputs(nulls, COMMITMENT_3));
        // No bet record is created (market_id stays zero) and no USDC moves.
        (bytes32 marketId,,,,,,,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(marketId, bytes32(0), "consolidate must not create a bet record");
        assertEq(usdc.balanceOf(address(vault)), vaultUsdcBefore, "consolidate must not move USDC");
    }

    function test_consolidate_duplicateNullifierReverts() public {
        // Same note in two active slots -> identical nullifier -> second markSpent reverts.
        bytes32[4] memory nulls;
        nulls[0] = NULLIFIER_1;
        nulls[1] = NULLIFIER_1;
        // Build inputs first (reads the tree) so expectRevert targets only consolidate().
        ConsolidatePublicInputs memory inputs = _consolidateInputs(nulls, COMMITMENT_3);
        vm.expectRevert(NullifierRegistry.AlreadySpent.selector);
        vault.consolidate(DUMMY_PROOF, inputs);
    }

    function test_consolidate_alreadySpentNullifierReverts() public {
        bytes32[4] memory first;
        first[0] = NULLIFIER_1;
        vault.consolidate(DUMMY_PROOF, _consolidateInputs(first, COMMITMENT_2));

        // Re-using NULLIFIER_1 in a later consolidate must revert at the pre-check.
        bytes32[4] memory second;
        second[0] = NULLIFIER_1;
        second[1] = keccak256("fresh_nullifier");
        ConsolidatePublicInputs memory inputs = _consolidateInputs(second, COMMITMENT_3);
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.consolidate(DUMMY_PROOF, inputs);
    }

    function test_consolidate_unknownRootReverts() public {
        bytes32[4] memory nulls;
        nulls[0] = NULLIFIER_1;
        ConsolidatePublicInputs memory inputs = ConsolidatePublicInputs({
            merkle_root: keccak256("bogus_root"),
            nullifier: nulls,
            new_commitment: COMMITMENT_3
        });
        vm.expectRevert(Vault.UnknownRoot.selector);
        vault.consolidate(DUMMY_PROOF, inputs);
    }

    function test_consolidate_zeroSlot0Reverts() public {
        // slot 0 inactive -> EmptyConsolidation (belt-and-suspenders; circuit also forbids it).
        bytes32[4] memory nulls;
        nulls[1] = NULLIFIER_1;
        ConsolidatePublicInputs memory inputs = _consolidateInputs(nulls, COMMITMENT_3);
        vm.expectRevert(Vault.EmptyConsolidation.selector);
        vault.consolidate(DUMMY_PROOF, inputs);
    }

    function test_consolidate_invalidProofReverts() public {
        consolidateVerifier.setShouldPass(false);
        bytes32[4] memory nulls;
        nulls[0] = NULLIFIER_1;
        ConsolidatePublicInputs memory inputs = _consolidateInputs(nulls, COMMITMENT_3);
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.consolidate(DUMMY_PROOF, inputs);
    }

    function test_consolidate_whenPausedReverts() public {
        vm.prank(owner);
        vault.pause();
        bytes32[4] memory nulls;
        nulls[0] = NULLIFIER_1;
        ConsolidatePublicInputs memory inputs = _consolidateInputs(nulls, COMMITMENT_3);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        vault.consolidate(DUMMY_PROOF, inputs);
    }

    // =========================================================================
    // FC-9: operator attestation security
    // =========================================================================

    // A correctly-shaped attestation signed by a NON-operator key must be rejected.
    function test_attestation_forgedSig_reverts() public {
        _setupFilledAndResolvedBet(); // ACTIVE + resolved
        bytes32 root = _currentRoot();
        OperatorAttestation memory att =
            OperatorAttestation({nullifierOfBet: NULLIFIER_1, reportType: vault.REPORT_FILLED(), amountA: 0, amountB: 0});
        bytes32 structHash = keccak256(abi.encode(ATT_TYPEHASH, att.nullifierOfBet, att.reportType, att.amountA, att.amountB));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xBAD), digest); // non-operator key
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.expectRevert(Vault.InvalidAttestation.selector);
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root), att, sig);
    }

    // A FILLED attestation presented to partialFillCredit (which expects PARTIAL) must revert.
    function test_attestation_wrongType_reverts() public {
        _authorizeBetAndGetNullifier(); // ACTIVE
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _filledAtt(); // type FILLED, not PARTIAL
        vm.expectRevert(Vault.AttestationMismatch.selector);
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(root), att, sig);
    }

    // An attestation bound to a different bet than the call's nullifier_of_bet must revert.
    function test_attestation_crossBet_reverts() public {
        _setupFilledAndResolvedBet(); // ACTIVE on NULLIFIER_1 + resolved
        bytes32 root = _currentRoot();
        // Valid FILLED attestation, but bound to a different nullifier_of_bet.
        (OperatorAttestation memory att, bytes memory sig) =
            _attest(keccak256("some_other_bet"), vault.REPORT_FILLED(), 0, 0);
        vm.expectRevert(Vault.AttestationMismatch.selector);
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root), att, sig);
    }

    // Two-stage: ACTIVE bet -> partialFillCredit (PARTIAL att) normalizes to on-chain FILLED ->
    // creditSettlement with NO attestation succeeds (status is already FILLED).
    function test_partialThenSettle_twoStage() public {
        _authorizeBetAndGetNullifier(); // ACTIVE
        (OperatorAttestation memory pAtt, bytes memory pSig) = _partialAtt(PF_FILLED_SHARES, PF_SPENT_AMOUNT);
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(_currentRoot()), pAtt, pSig);
        (,,,,,, BetStatus statusAfterPartial,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(statusAfterPartial), uint8(BetStatus.FILLED));

        _setupResolvableMarket();
        vm.prank(operator);
        vault.resolveMarket(MARKET_ID);

        SettlementPublicInputs memory s = SettlementPublicInputs({
            merkle_root: _currentRoot(),
            nullifier: keccak256("two_stage_settle"),
            new_commitment: keccak256("two_stage_commit"),
            nullifier_of_bet: NULLIFIER_1,
            market_id: MARKET_ID,
            total_credit: PF_FILLED_SHARES
        });
        (OperatorAttestation memory att, bytes memory sig) = _noAtt();
        vault.creditSettlement(DUMMY_PROOF, s, att, sig);
        (,,,,,, BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(BetStatus.CREDITED));
    }

    // After a successful settlement (CREDITED), a second credit attempt on the same bet
    // (here naCancellationCredit) reverts because the status is no longer ACTIVE/FILLED/FAILED.
    function test_doubleCredit_blocked() public {
        _setupFilledAndResolvedBet();
        bytes32 root = _currentRoot();
        (OperatorAttestation memory att, bytes memory sig) = _filledAtt();
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root), att, sig); // -> CREDITED

        // Try to drain again via naCancellationCredit with a fresh note nullifier.
        NACancelPublicInputs memory na = _naCancelInputs(_currentRoot());
        na.nullifier = keccak256("double_credit_na");
        (OperatorAttestation memory att2, bytes memory sig2) = _filledAtt();
        vm.expectRevert(Vault.BetNotCancellable.selector);
        vault.naCancellationCredit(DUMMY_PROOF, na, att2, sig2);
    }

    // initializeV2 is reinitializer(2): a second call must revert.
    function test_initializeV2_onlyOnce() public {
        vm.expectRevert();
        vault.initializeV2();
    }

    // =========================================================================
    // FEE (P2/P4): bet fee, withdrawal fee, minimums, setFeeParams, withdrawFees
    // =========================================================================

    // Default config from initialize(): betFeeBps=5 (0.05%), withdrawalFeeUSDC=$0.10,
    // minBet=$1, minWithdrawal=$1, relayGasFeeUSDC=0, feeRecipient=owner.

    function test_authorizeBet_accruesBetFee() public {
        bytes32 root = _depositAndGetRoot();
        // bet_amount = $100 → fee = 100e6 * 5 / 10000 = 50_000 ($0.05)
        vault.authorizeBet(DUMMY_PROOF, _betAuthInputs(root));
        assertEq(vault.feeAccumulator(), 50_000);
    }

    function test_authorizeBet_relayGasFeeBundledIntoFee() public {
        // Set a flat relay-gas reimbursement and confirm it adds on top of the bps fee.
        vm.prank(owner);
        vault.setFeeParams(FeeConfig(5, 20_000, 1_000_000, 100_000, 1_000_000, owner));
        bytes32 root = _depositAndGetRoot();
        // fee = 100e6 * 5 / 10000 + 20_000 = 50_000 + 20_000 = 70_000
        vault.authorizeBet(DUMMY_PROOF, _betAuthInputs(root));
        assertEq(vault.feeAccumulator(), 70_000);
    }

    function test_authorizeBet_revertBelowMinBet() public {
        bytes32 root = _depositAndGetRoot();
        BetAuthPublicInputs memory inputs = _betAuthInputs(root);
        inputs.bet_amount = 999_999; // < $1
        vm.expectRevert(Vault.BelowMinimum.selector);
        vault.authorizeBet(DUMMY_PROOF, inputs);
    }

    function test_authorizeBet_minBetExactlyOneDollarOk() public {
        bytes32 root = _depositAndGetRoot();
        BetAuthPublicInputs memory inputs = _betAuthInputs(root);
        inputs.bet_amount = 1_000_000; // exactly $1
        vault.authorizeBet(DUMMY_PROOF, inputs);
        assertTrue(registry.isSpent(NULLIFIER_1));
    }

    function test_withdraw_revertBelowMinWithdrawal() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        WithdrawalPublicInputs memory inputs = _withdrawInputs(root, rHash, COMMITMENT_2);
        inputs.withdrawal_amount = 999_999; // < $1
        vm.expectRevert(Vault.BelowMinimum.selector);
        vault.withdraw(DUMMY_PROOF, inputs, recipient);
    }

    function test_withdrawFees_byFeeRecipient() public {
        // Accrue the $0.10 withdrawal fee, then the feeRecipient (owner) claims it.
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash, COMMITMENT_2), recipient);
        assertEq(vault.feeAccumulator(), 100_000);

        uint256 ownerBefore = usdc.balanceOf(owner);
        vm.prank(owner);
        vault.withdrawFees(100_000);
        assertEq(usdc.balanceOf(owner) - ownerBefore, 100_000);
        assertEq(vault.feeAccumulator(), 0);
    }

    function test_withdrawFees_revertNotRecipient() public {
        vm.prank(attacker);
        vm.expectRevert(Vault.NotFeeRecipient.selector);
        vault.withdrawFees(1);
    }

    function test_withdrawFees_revertOverAccrued() public {
        vm.prank(owner);
        vm.expectRevert(Vault.InvalidAmount.selector);
        vault.withdrawFees(1); // feeAccumulator == 0
    }

    function test_setFeeParams_updatesConfig() public {
        vm.prank(owner);
        vault.setFeeParams(FeeConfig(100, 0, 5_000_000, 250_000, 10_000_000, bob));
        (uint16 bps, uint64 gas, uint64 minBet, uint64 wFee, uint64 minW, address recip) = vault.feeConfig();
        assertEq(bps, 100);
        assertEq(gas, 0);
        assertEq(minBet, 5_000_000);
        assertEq(wFee, 250_000);
        assertEq(minW, 10_000_000);
        assertEq(recip, bob);
    }

    function test_setFeeParams_newBetFeeApplies() public {
        vm.prank(owner);
        vault.setFeeParams(FeeConfig(100, 0, 1_000_000, 100_000, 1_000_000, owner)); // 1%
        bytes32 root = _depositAndGetRoot();
        // fee = 100e6 * 100 / 10000 = 1_000_000 ($1)
        vault.authorizeBet(DUMMY_PROOF, _betAuthInputs(root));
        assertEq(vault.feeAccumulator(), 1_000_000);
    }

    function test_setFeeParams_revertNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", attacker));
        vault.setFeeParams(FeeConfig(5, 0, 1_000_000, 100_000, 1_000_000, owner));
    }

    function test_setFeeParams_revertZeroRecipient() public {
        vm.prank(owner);
        vm.expectRevert(Vault.ZeroAddress.selector);
        vault.setFeeParams(FeeConfig(5, 0, 1_000_000, 100_000, 1_000_000, address(0)));
    }

    function test_setFeeParams_revertMinWithdrawalBelowFee() public {
        vm.prank(owner);
        // minWithdrawal (50_000) < withdrawalFeeUSDC (100_000) would underflow the payout.
        vm.expectRevert(Vault.InvalidAmount.selector);
        vault.setFeeParams(FeeConfig(5, 0, 1_000_000, 100_000, 50_000, owner));
    }
}
