// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {CommitmentMerkleTree} from "../src/CommitmentMerkleTree.sol";
import {Vault} from "../src/Vault.sol";
import {PoseidonT3Hasher} from "../src/PoseidonT3Hasher.sol";
import {BetAuthVerifier} from "../src/verifiers/BetAuthVerifier.sol";
import {SettlementCreditVerifier} from "../src/verifiers/SettlementCreditVerifier.sol";
import {WithdrawalVerifier} from "../src/verifiers/WithdrawalVerifier.sol";
import {BetCancelVerifier} from "../src/verifiers/BetCancelVerifier.sol";
import {CancelCreditVerifier} from "../src/verifiers/CancelCreditVerifier.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockCTF} from "../src/mocks/MockCTF.sol";
import {MockCollateralOfframp} from "../src/mocks/MockCollateralOfframp.sol";
import {MockCollateralOnramp} from "../src/mocks/MockCollateralOnramp.sol";
import {MockPUSD} from "../src/mocks/MockPUSD.sol";

/// @notice Deploys all contracts + mocks on a local Anvil node for dev/integration testing.
/// Uses contract-level storage variables to stay within the Solidity stack limit.
///
/// Usage:
///   forge script script/MockDeploy.s.sol \
///     --rpc-url http://127.0.0.1:8545 --broadcast
///
/// Output: KEY=value lines on stdout, parsed by packages/backend/mock-env/src/deploy.ts
contract MockDeploy is Script {
    // ── Anvil deterministic accounts ─────────────────────────────────────────
    uint256 constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant ALICE_KEY    = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;
    uint256 constant BOB_KEY      = 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba;

    address constant OWNER          = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address constant OPERATOR       = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant DEPOSIT_WALLET = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address constant ALICE          = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65;
    address constant BOB            = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc;
    address constant ATTACKER       = 0x976EA74026E726554dB657fA54763abd0C3a0aa9;

    // ── Custom test addresses (funded with ETH + USDC for GUI testing) ─────────
    address constant USER_1 = 0x2d209040c031d4e2D4d9cb4D3aabf18F52260AB0;
    address constant USER_2 = 0x7D0A7d3a4508B33C6A0e9F3FCBc72562cC120e89;
    address constant USER_3 = 0x46458d7CE6157AE78BFF94D2096308f352c7edc8;

    // ── Contract storage (avoids Solidity stack-too-deep in run()) ────────────
    MockUSDC                internal s_usdc;
    MockPUSD                internal s_pusd;
    MockCTF                 internal s_ctf;
    MockCollateralOnramp  internal s_onramp;
    MockCollateralOfframp internal s_offramp;
    PoseidonT3Hasher        internal s_poseidon;
    NullifierRegistry       internal s_registry;
    CommitmentMerkleTree    internal s_tree;
    Vault                   internal s_vault;
    BetAuthVerifier         internal s_betAuth;
    SettlementCreditVerifier internal s_settlement;
    WithdrawalVerifier      internal s_withdrawal;
    BetCancelVerifier       internal s_betCancel;
    CancelCreditVerifier    internal s_cancelCredit;
    bytes32                 internal s_resolvedYesMarket;
    bytes32                 internal s_naMarket;

    bytes32 constant ALICE_COMMITMENT_1 = keccak256("alice_commitment_1");
    bytes32 constant BOB_COMMITMENT_1   = keccak256("bob_commitment_1");

    // ── Entry point ───────────────────────────────────────────────────────────

    function run() external {
        _deployMocks();
        _deployCore();
        _deployVerifiers();
        _seedCTF();
        _seedUSDC();
        _seedDeposits();
        _fundUsers();
        _log();
    }

    // ── Step 1: deploy mock tokens + real Poseidon hasher ────────────────────

    function _deployMocks() internal {
        vm.startBroadcast(DEPLOYER_KEY);
        s_usdc     = new MockUSDC();
        s_pusd     = new MockPUSD();
        s_ctf      = new MockCTF(address(s_pusd));
        s_poseidon = new PoseidonT3Hasher();   // real BN254 Poseidon2 — matches Noir
        s_onramp   = new MockCollateralOnramp(address(s_usdc), address(s_pusd));
        vm.stopBroadcast();
    }

    // ── Step 2: deploy core protocol ──────────────────────────────────────────

    function _deployCore() internal {
        address deployer = vm.addr(DEPLOYER_KEY);
        // After step 1, deployer nonce advanced by 3 (usdc, ctf, poseidon).
        // Core order: registry(+0), tree(+1), offramp(+2), vault(+3) relative to current nonce.
        uint64 nonce = vm.getNonce(deployer);
        address predictedOfframp = vm.computeCreateAddress(deployer, nonce + 2);
        address predictedVault = vm.computeCreateAddress(deployer, nonce + 3);

        vm.startBroadcast(DEPLOYER_KEY);
        s_registry = new NullifierRegistry(predictedVault);
        s_tree     = new CommitmentMerkleTree(predictedVault, address(s_poseidon));
        s_offramp  = new MockCollateralOfframp(address(s_usdc), address(s_pusd));
        require(address(s_offramp) == predictedOfframp, "MockDeploy: offramp addr mismatch");
        s_vault    = new Vault(
            address(s_usdc),
            address(s_tree),
            address(s_registry),
            address(s_onramp),
            address(s_offramp),
            address(s_ctf),
            OPERATOR,
            DEPOSIT_WALLET,
            OWNER
        );
        require(address(s_vault) == predictedVault, "MockDeploy: vault addr mismatch");
        vm.stopBroadcast();
    }

    // ── Step 3: deploy + wire real UltraPLONK verifiers ─────────────────────

    function _deployVerifiers() internal {
        vm.startBroadcast(DEPLOYER_KEY);
        s_betAuth      = new BetAuthVerifier();
        s_settlement   = new SettlementCreditVerifier();
        s_withdrawal   = new WithdrawalVerifier();
        s_betCancel    = new BetCancelVerifier();
        s_cancelCredit = new CancelCreditVerifier();

        s_vault.setVerifier(s_vault.BET_AUTH(),          address(s_betAuth));
        s_vault.setVerifier(s_vault.SETTLEMENT_CREDIT(), address(s_settlement));
        s_vault.setVerifier(s_vault.WITHDRAWAL(),        address(s_withdrawal));
        s_vault.setVerifier(s_vault.BET_CANCEL(),        address(s_betCancel));
        s_vault.setVerifier(s_vault.CANCEL_CREDIT(),     address(s_cancelCredit));
        vm.stopBroadcast();
    }

    // ── Step 4: configure CTF market resolutions ──────────────────────────────

    function _seedCTF() internal {
        s_resolvedYesMarket = keccak256("market_resolved_yes");
        s_naMarket          = keccak256("market_resolved_na");

        uint256[] memory yesNum = new uint256[](2);
        yesNum[0] = 1_000_000;
        yesNum[1] = 0;

        uint256[] memory naNum = new uint256[](2);
        // naNum stays all-zero

        vm.startBroadcast(DEPLOYER_KEY);
        s_ctf.setPayoutNumerators(s_resolvedYesMarket, yesNum);
        s_ctf.setPayoutDenominator(s_resolvedYesMarket, 1_000_000);
        s_ctf.setPayoutNumerators(s_naMarket, naNum);
        s_ctf.setPayoutDenominator(s_naMarket, 1_000_000);
        vm.stopBroadcast();
    }

    // ── Step 5: mint USDC ─────────────────────────────────────────────────────

    function _seedUSDC() internal {
        vm.startBroadcast(DEPLOYER_KEY);
        s_usdc.mint(ALICE,    100_000 * 1e6); // $100k
        s_usdc.mint(BOB,       10_000 * 1e6); // $10k
        s_usdc.mint(ATTACKER,   5_000 * 1e6); // $5k
        vm.stopBroadcast();
    }

    // ── Step 6: approve + deposit ─────────────────────────────────────────────

    function _seedDeposits() internal {
        vm.startBroadcast(ALICE_KEY);
        s_usdc.approve(address(s_vault), type(uint256).max);
        s_vault.deposit(ALICE_COMMITMENT_1, 1_000 * 1e6); // $1k
        vm.stopBroadcast();

        vm.startBroadcast(BOB_KEY);
        s_usdc.approve(address(s_vault), type(uint256).max);
        s_vault.deposit(BOB_COMMITMENT_1, 500 * 1e6); // $500
        vm.stopBroadcast();
    }

    // ── Step 7: fund custom GUI test addresses ────────────────────────────────

    function _fundUsers() internal {
        vm.startBroadcast(DEPLOYER_KEY);
        // ETH for gas (real transfers, not cheatcodes)
        payable(USER_1).transfer(2 ether);
        payable(USER_2).transfer(2 ether);
        payable(USER_3).transfer(2 ether);
        // MockUSDC — deployer is the minter
        s_usdc.mint(USER_1, 100_000 * 1e6); // $100k each
        s_usdc.mint(USER_2, 100_000 * 1e6);
        s_usdc.mint(USER_3, 100_000 * 1e6);
        vm.stopBroadcast();
    }

    // ── Step 8: log addresses for parse by mock-env/src/deploy.ts ────────────

    function _log() internal view {
        console2.log("USDC_ADDRESS=%s",          address(s_usdc));
        console2.log("PUSD_ADDRESS=%s",          address(s_pusd));
        console2.log("ONRAMP_ADDRESS=%s",        address(s_onramp));
        console2.log("OFFRAMP_ADDRESS=%s",       address(s_offramp));
        console2.log("CTF_ADDRESS=%s",            address(s_ctf));
        console2.log("POSEIDON_ADDRESS=%s",       address(s_poseidon));
        console2.log("REGISTRY_ADDRESS=%s",       address(s_registry));
        console2.log("TREE_ADDRESS=%s",           address(s_tree));
        console2.log("VAULT_ADDRESS=%s",          address(s_vault));
        console2.log("BET_AUTH_VERIFIER=%s",      address(s_betAuth));
        console2.log("SETTLEMENT_VERIFIER=%s",    address(s_settlement));
        console2.log("WITHDRAWAL_VERIFIER=%s",    address(s_withdrawal));
        console2.log("BET_CANCEL_VERIFIER=%s",    address(s_betCancel));
        console2.log("CANCEL_CREDIT_VERIFIER=%s", address(s_cancelCredit));
        console2.log("RESOLVED_YES_MARKET=%s",    vm.toString(s_resolvedYesMarket));
        console2.log("NA_MARKET=%s",              vm.toString(s_naMarket));
        console2.log("ALICE_COMMITMENT_1=%s",     vm.toString(ALICE_COMMITMENT_1));
        console2.log("BOB_COMMITMENT_1=%s",       vm.toString(BOB_COMMITMENT_1));
    }
}
