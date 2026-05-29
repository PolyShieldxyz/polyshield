// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {CommitmentMerkleTree} from "./CommitmentMerkleTree.sol";
import {NullifierRegistry} from "./NullifierRegistry.sol";
import {IVerifier} from "./interfaces/IVerifier.sol";
import {ICollateralOnramp} from "./interfaces/ICollateralOnramp.sol";
import {ICollateralOfframp} from "./interfaces/ICollateralOfframp.sol";
import {ICTF} from "./interfaces/ICTF.sol";

/// @notice Privacy-preserving vault for Polymarket positions.
/// Users deposit USDC, then authorize bets, credit settlements, and withdraw
/// using ZK proofs that hide which depositor authorized which bet.
contract Vault is ReentrancyGuard, Ownable2Step, Pausable {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Proof type identifiers (index into verifiers mapping)
    // -------------------------------------------------------------------------
    uint8 public constant BET_AUTH = 0;
    uint8 public constant SETTLEMENT_CREDIT = 1;
    uint8 public constant WITHDRAWAL = 2;
    uint8 public constant BET_CANCEL = 3;
    uint8 public constant CANCEL_CREDIT = 4;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------
    enum BetStatus {
        ACTIVE,
        FILLED,
        FAILED,
        CREDITED,
        CANCELLED_CREDITED
    }

    struct BetRecord {
        bytes32 market_id; // circuit-safe field element (conditionId % BN254_P)
        bytes32 condition_id; // same as market_id at authorizeBet time
        bytes32 position_id;
        uint64 expected_shares;
        uint64 bet_amount;
        uint8 outcome_side;  // 0 = YES, 1 = NO
        BetStatus status;
    }

    // Public input structs — mirror the Noir circuit's `pub` parameters in order.
    struct BetAuthPublicInputs {
        bytes32 merkle_root;
        bytes32 nullifier;
        bytes32 new_commitment;
        uint64 bet_amount;
        uint64 price;
        uint64 expected_shares;
        bytes32 market_id;
        uint8 outcome_side;
        bytes32 position_id;
    }

    struct SettlementPublicInputs {
        bytes32 merkle_root;
        bytes32 nullifier;
        bytes32 new_commitment;
        bytes32 nullifier_of_bet;
        bytes32 market_id;
        // payout_per_share REMOVED — read from pendingCredit[market_id]
        // shares_held is NOT here — injected from betRecords[nullifier_of_bet]
        uint64 total_credit;
    }

    struct WithdrawalPublicInputs {
        bytes32 merkle_root;
        bytes32 nullifier;
        uint64 withdrawal_amount;
        bytes32 recipient_hash;
        bytes32 new_commitment;
    }

    struct BetCancelPublicInputs {
        bytes32 merkle_root;
        bytes32 nullifier;
        bytes32 new_commitment;
        bytes32 nullifier_of_bet;
        // bet_amount is NOT here — it is injected from betRecords[nullifier_of_bet]
    }

    struct NACancelPublicInputs {
        bytes32 merkle_root;
        bytes32 nullifier;
        bytes32 new_commitment;
        bytes32 nullifier_of_bet;
        bytes32 market_id;
        // bet_amount is NOT here — it is injected from betRecords[nullifier_of_bet]
    }

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------
    uint256 public constant DEPOSIT_CAP = 50_000 * 1e6; // $50k USDC (6 decimals)
    // BN254 scalar field prime — conditionIds that exceed this are reduced before
    // use as circuit Field inputs and as pendingCredit keys.
    uint256 private constant BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------
    CommitmentMerkleTree public tree;
    NullifierRegistry public nullifiers;
    IERC20 public usdc;
    ICollateralOnramp public onramp;
    ICollateralOfframp public offramp;
    ICTF public ctf;

    address public signingLayerOperator;
    address public depositWallet;

    mapping(uint8 => address) public verifiers;
    mapping(uint8 => address) public pendingVerifiers;
    mapping(uint8 => uint256) public verifierUpdateAt;
    uint256 public constant VERIFIER_TIMELOCK = 48 hours;
    mapping(bytes32 => BetRecord) public betRecords;
    mapping(address => uint256) public cumulativeDeposits;
    // circuit_key (conditionId % BN254_P) => outcome_side => payout_per_share
    // payout_per_share = numerators[outcome_side] / denominator (0 or 1 for binary markets)
    mapping(bytes32 => mapping(uint8 => uint64)) public pendingCredit;
    mapping(bytes32 => uint64) public marketResolvedAt; // conditionId => block.timestamp
    mapping(bytes32 => uint64) public betCreatedAt;    // nullifier_of_bet => block.timestamp at authorizeBet
    uint256 public adminCancelTimelock = 86_400;        // seconds; default 24 hours; governance-mutable
    uint256 public deployedToPolymarket;               // USDC-equivalent currently held in depositWallet

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------
    error DepositCapExceeded();
    error NullifierSpent();
    error UnknownRoot();
    error InvalidProof();
    error BetNotFound();
    error WrongMarket();
    error BetNotFilled();
    error BetNotFailed();
    error NotNA();
    error BadRecipient();
    error OnlyOperator();
    error MarketAlreadyResolved();
    error MarketNotResolved();
    error ConditionNotResolved();
    error BetNotCancellable();
    error BetNotActive();
    error BetTimeoutNotElapsed();
    error InsufficientVaultLiquidity();
    error InsufficientLiquidity(uint256 available, uint256 requested);
    error InvalidAmount();
    error ZeroAddress();
    error VerifierTimelockActive();
    error PayoutRoundsToZero();

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------
    event Deposited(address indexed depositor, bytes32 commitment, uint256 amount);
    event MarketResolved(bytes32 indexed market_id, uint64 resolvedAt);
    event VerifierProposed(uint8 indexed proofType, address verifier, uint256 availableAt);
    event VerifierAccepted(uint8 indexed proofType, address verifier);
    event BetAuthorized(
        bytes32 indexed nullifier,
        bytes32 market_id,
        bytes32 position_id,
        uint64 expected_shares,
        uint256 bet_amount,
        uint64 price,
        uint8 outcome_side,
        bytes32 new_commitment
    );
    event FundedPolymarketWallet(uint256 amount);
    event PolymarketReturnAcknowledged(uint256 amount, uint256 vaultUsdcBalance);
    event BetFilled(bytes32 indexed nullifier_of_bet);
    event FOKFailed(bytes32 indexed nullifier_of_bet);
    event SettlementCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment);
    event Withdrawn(bytes32 indexed nullifier, address recipient, uint256 amount, bytes32 new_commitment);
    event BetCancellationCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment);
    event NACancellationCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment);
    event AdminBetCancelled(bytes32 indexed nullifier_of_bet);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(
        address _usdc,
        address _tree,
        address _nullifiers,
        address _onramp,
        address _offramp,
        address _ctf,
        address _signingLayerOperator,
        address _depositWallet,
        address _owner
    ) Ownable(_owner) {
        if (_usdc == address(0) || _tree == address(0) || _nullifiers == address(0) ||
            _onramp == address(0) || _offramp == address(0) || _ctf == address(0) ||
            _signingLayerOperator == address(0) || _depositWallet == address(0) ||
            _owner == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        tree = CommitmentMerkleTree(_tree);
        nullifiers = NullifierRegistry(_nullifiers);
        onramp = ICollateralOnramp(_onramp);
        offramp = ICollateralOfframp(_offramp);
        ctf = ICTF(_ctf);
        signingLayerOperator = _signingLayerOperator;
        depositWallet = _depositWallet;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------
    /// @notice Propose a new verifier. Takes effect after VERIFIER_TIMELOCK (48 h).
    function proposeVerifier(uint8 proofType, address verifier) external onlyOwner {
        if (verifier == address(0)) revert ZeroAddress();
        pendingVerifiers[proofType] = verifier;
        verifierUpdateAt[proofType] = block.timestamp + VERIFIER_TIMELOCK;
        emit VerifierProposed(proofType, verifier, verifierUpdateAt[proofType]);
    }

    /// @notice Accept a proposed verifier after the timelock has elapsed.
    function acceptVerifier(uint8 proofType) external onlyOwner {
        if (block.timestamp < verifierUpdateAt[proofType]) revert VerifierTimelockActive();
        verifiers[proofType] = pendingVerifiers[proofType];
        emit VerifierAccepted(proofType, verifiers[proofType]);
    }

    function setSigningLayerOperator(address operator) external onlyOwner {
        signingLayerOperator = operator;
    }

    /// @notice Update the timelock duration for adminCancelBet. Owner-controlled.
    function setAdminCancelTimelock(uint256 _seconds) external onlyOwner {
        require(_seconds >= 1 hours, "timelock too short");
        adminCancelTimelock = _seconds;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Convert vault USDC to pUSD via onramp and forward to the Polymarket
    /// deposit wallet. Operator-callable; tracks deployed amount in deployedToPolymarket.
    function fundPolymarketWallet(uint256 amount) external nonReentrant {
        if (msg.sender != signingLayerOperator) revert OnlyOperator();
        if (usdc.balanceOf(address(this)) < amount) revert InsufficientVaultLiquidity();
        deployedToPolymarket += amount;

        IERC20 pusd = IERC20(onramp.pusdAddress());
        usdc.forceApprove(address(onramp), amount);
        onramp.deposit(amount); // USDC leaves vault, pUSD arrives at vault

        pusd.safeTransfer(depositWallet, amount); // forward pUSD to deposit wallet
        emit FundedPolymarketWallet(amount);
    }

    /// @notice Acknowledge that USDC has returned to the vault from Polymarket settlement.
    /// Called by operator after the full redemption pipeline completes.
    /// @dev TRUST: This function does not verify that USDC actually returned to the
    /// vault. It relies on the operator (signingLayerOperator) to call it honestly
    /// after the redemption pipeline completes. A compromised operator can call it
    /// with inflated amounts, overstating available liquidity. Mitigate by using a
    /// multisig or TEE for the operator role (v2 roadmap).
    function acknowledgePolymarketReturn(uint256 amount) external {
        if (msg.sender != signingLayerOperator) revert OnlyOperator();
        if (amount > deployedToPolymarket) revert InvalidAmount();
        deployedToPolymarket -= amount;
        emit PolymarketReturnAcknowledged(amount, usdc.balanceOf(address(this)));
    }

    // -------------------------------------------------------------------------
    // Deposit
    // -------------------------------------------------------------------------

    /// @notice Deposit USDC and insert a commitment leaf.
    /// The commitment must equal Poseidon4(secret, initial_balance, 0, owner_address)
    /// computed client-side (see docs/zk-design.md §2). The vault does not verify
    /// the preimage on-chain; the depositor is bound by the commitment they submit.
    function deposit(bytes32 commitment, uint256 amount) external nonReentrant whenNotPaused {
        if (cumulativeDeposits[msg.sender] + amount > DEPOSIT_CAP) revert DepositCapExceeded();
        cumulativeDeposits[msg.sender] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        tree.insert(commitment);
        emit Deposited(msg.sender, commitment, amount);
    }

    // -------------------------------------------------------------------------
    // Bet Authorization
    // -------------------------------------------------------------------------

    /// @notice Authorize a Polymarket bet. Verifies the Bet Auth ZK proof,
    /// nullifies the user's current note, and creates a new note with the
    /// post-bet balance. Emits BetAuthorized which the Signing Layer monitors.
    function authorizeBet(
        bytes calldata proof,
        BetAuthPublicInputs calldata inputs
    ) external nonReentrant whenNotPaused {
        // Nullifier check FIRST (checks-effects-interactions)
        if (nullifiers.isSpent(inputs.nullifier)) revert NullifierSpent();
        if (!tree.isKnownRoot(inputs.merkle_root)) revert UnknownRoot();
        if (!IVerifier(verifiers[BET_AUTH]).verify(proof, _betAuthPublicInputs(inputs))) revert InvalidProof();

        nullifiers.markSpent(inputs.nullifier);
        tree.insert(inputs.new_commitment);

        betRecords[inputs.nullifier] = BetRecord({
            market_id: inputs.market_id,
            condition_id: inputs.market_id,
            position_id: inputs.position_id,
            expected_shares: inputs.expected_shares,
            bet_amount: inputs.bet_amount,
            outcome_side: inputs.outcome_side,
            status: BetStatus.ACTIVE
        });
        betCreatedAt[inputs.nullifier] = uint64(block.timestamp);

        emit BetAuthorized(
            inputs.nullifier,
            inputs.market_id,
            inputs.position_id,
            inputs.expected_shares,
            uint256(inputs.bet_amount),
            inputs.price,
            inputs.outcome_side,
            inputs.new_commitment
        );
    }

    // -------------------------------------------------------------------------
    // Operator: FOK status reporting
    // -------------------------------------------------------------------------

    /// @notice Called by the Signing Layer when a FOK order is confirmed filled.
    /// Intentionally not gated by whenNotPaused: in-flight bets must be resolvable
    /// even during an emergency pause so the operator can record fill status and
    /// users can proceed to creditSettlement after unpause.
    function reportFilled(bytes32 nullifier_of_bet) external {
        if (msg.sender != signingLayerOperator) revert OnlyOperator();
        BetRecord storage rec = betRecords[nullifier_of_bet];
        if (rec.market_id == bytes32(0)) revert BetNotFound();
        rec.status = BetStatus.FILLED;
        emit BetFilled(nullifier_of_bet);
    }

    /// @notice Called by the Signing Layer when a FOK order was not filled.
    /// Intentionally not gated by whenNotPaused: same rationale as reportFilled —
    /// FOK failures must be recordable during a pause so users can reclaim funds
    /// via betCancellationCredit after the vault is unpaused.
    function reportFOKFailure(bytes32 nullifier_of_bet) external {
        if (msg.sender != signingLayerOperator) revert OnlyOperator();
        BetRecord storage rec = betRecords[nullifier_of_bet];
        if (rec.market_id == bytes32(0)) revert BetNotFound();
        rec.status = BetStatus.FAILED;
        emit FOKFailed(nullifier_of_bet);
    }

    /// @notice Emergency cancel for in-flight bets when the Signing Layer EOA is
    /// banned or otherwise unable to report fill status. Sets the bet to FAILED so
    /// the depositor can call betCancellationCredit to recover their funds.
    ///
    /// Only callable on ACTIVE bets (not yet reported by the operator). A 24-hour
    /// timelock (adminCancelTimelock) prevents the owner from cancelling bets
    /// before the signing layer has had a reasonable chance to submit or report.
    /// See docs/open-questions.md Q14.
    function adminCancelBet(bytes32 nullifier_of_bet) external onlyOwner {
        BetRecord storage rec = betRecords[nullifier_of_bet];
        if (rec.market_id == bytes32(0)) revert BetNotFound();
        if (rec.status != BetStatus.ACTIVE) revert BetNotActive();
        if (block.timestamp < uint256(betCreatedAt[nullifier_of_bet]) + adminCancelTimelock)
            revert BetTimeoutNotElapsed();
        rec.status = BetStatus.FAILED;
        emit AdminBetCancelled(nullifier_of_bet);
    }

    // -------------------------------------------------------------------------
    // Market Resolution
    // -------------------------------------------------------------------------

    /// @notice Called by the operator after a Polymarket market resolves (non-N/A).
    /// Reads payout from the CTF contract and stores per-outcome payouts keyed by
    /// the BN254-reduced circuit_key so settlement proofs can use it directly.
    /// payout_per_share for each outcome = numerators[i] / denominator (0 or 1 for
    /// standard binary Polymarket markets).
    function resolveMarket(bytes32 market_id) external {
        if (msg.sender != signingLayerOperator) revert OnlyOperator();

        // Reduce conditionId to BN254 field range for use as circuit-compatible key.
        bytes32 circuit_key = bytes32(uint256(market_id) % BN254_P);
        if (marketResolvedAt[circuit_key] != 0) revert MarketAlreadyResolved();

        uint256[] memory numerators = ctf.payoutNumerators(market_id);
        uint256 denominator = ctf.payoutDenominator(market_id);
        if (denominator == 0) revert ConditionNotResolved();

        bool anyNonZero = false;
        for (uint256 i = 0; i < numerators.length; i++) {
            if (numerators[i] > 0) { anyNonZero = true; break; }
        }
        if (!anyNonZero) revert NotNA();

        // Store payout for each outcome. For binary markets numerators[i]/denominator
        // is exactly 0 or 1. Users whose outcome_side lost get payout_per_share = 0
        // and their bet is treated as worthless (no settlement needed).
        bool anyNonZeroAfterDiv = false;
        for (uint256 i = 0; i < numerators.length; i++) {
            uint64 pps = uint64(numerators[i] / denominator);
            pendingCredit[circuit_key][uint8(i)] = pps;
            if (pps > 0) anyNonZeroAfterDiv = true;
        }
        if (!anyNonZeroAfterDiv) revert PayoutRoundsToZero();

        uint64 resolvedAt = uint64(block.timestamp);
        marketResolvedAt[circuit_key] = resolvedAt;
        emit MarketResolved(circuit_key, resolvedAt);
    }

    // -------------------------------------------------------------------------
    // Settlement Credit
    // -------------------------------------------------------------------------

    /// @notice Credit a settled bet's payout back into the user's note.
    /// The Vault injects shares_held from betRecords to prevent the user
    /// from claiming a different share count than what was recorded at bet time.
    function creditSettlement(
        bytes calldata proof,
        SettlementPublicInputs calldata inputs
    ) external nonReentrant whenNotPaused {
        if (nullifiers.isSpent(inputs.nullifier)) revert NullifierSpent();
        if (!tree.isKnownRoot(inputs.merkle_root)) revert UnknownRoot();

        BetRecord storage rec = betRecords[inputs.nullifier_of_bet];
        if (rec.market_id == bytes32(0)) revert BetNotFound();
        if (rec.market_id != inputs.market_id) revert WrongMarket();
        if (rec.status != BetStatus.FILLED) revert BetNotFilled();

        // Market must be resolved. Losing bets (payout_per_share == 0) proceed with total_credit = 0.
        // Use the same BN254-reduced key that resolveMarket wrote to storage.
        bytes32 circuit_key = bytes32(uint256(inputs.market_id) % BN254_P);
        if (marketResolvedAt[circuit_key] == 0) revert MarketNotResolved();
        uint64 payout_per_share = pendingCredit[circuit_key][rec.outcome_side];

        // Verify total_credit arithmetic on-chain — circuit trusts this as injected.
        // payout_per_share is 0 or 1 for binary markets; for a loss total_credit must be 0.
        uint64 shares_held = rec.expected_shares;
        require(uint256(shares_held) * uint256(payout_per_share) == uint256(inputs.total_credit), "Invalid total_credit");

        bytes32[] memory pubInputs = _settlementPublicInputs(inputs);
        if (!IVerifier(verifiers[SETTLEMENT_CREDIT]).verify(proof, pubInputs)) revert InvalidProof();

        nullifiers.markSpent(inputs.nullifier);
        tree.insert(inputs.new_commitment);
        rec.status = BetStatus.CREDITED;

        emit SettlementCredited(inputs.nullifier, inputs.nullifier_of_bet, inputs.new_commitment);
    }

    // -------------------------------------------------------------------------
    // Withdrawal
    // -------------------------------------------------------------------------

    /// @notice Withdraw USDC from the vault.
    /// `recipientAddress` must be a private input to the circuit; its Poseidon
    /// hash must equal `inputs.recipient_hash`. The Vault verifies this on-chain
    /// to prevent the relay from redirecting funds to a different address.
    function withdraw(
        bytes calldata proof,
        WithdrawalPublicInputs calldata inputs,
        address recipientAddress
    ) external nonReentrant whenNotPaused {
        if (nullifiers.isSpent(inputs.nullifier)) revert NullifierSpent();
        if (!tree.isKnownRoot(inputs.merkle_root)) revert UnknownRoot();
        if (!IVerifier(verifiers[WITHDRAWAL]).verify(proof, _withdrawalPublicInputs(inputs))) revert InvalidProof();

        // Verify recipientAddress matches the commitment in the proof
        bytes32 computedHash = tree.hashTwo(bytes32(uint256(uint160(recipientAddress))), bytes32(0));
        if (computedHash != inputs.recipient_hash) revert BadRecipient();

        // H1: explicit solvency guard — gives a meaningful error when funds are deployed.
        uint256 available = usdc.balanceOf(address(this));
        if (available < uint256(inputs.withdrawal_amount))
            revert InsufficientLiquidity(available, uint256(inputs.withdrawal_amount));

        nullifiers.markSpent(inputs.nullifier);
        if (inputs.new_commitment != bytes32(0)) {
            tree.insert(inputs.new_commitment);
        }
        usdc.safeTransfer(recipientAddress, uint256(inputs.withdrawal_amount));

        emit Withdrawn(inputs.nullifier, recipientAddress, uint256(inputs.withdrawal_amount), inputs.new_commitment);
    }

    // -------------------------------------------------------------------------
    // Bet Cancellation Credit (FOK failed)
    // -------------------------------------------------------------------------

    /// @notice Credit back the bet amount when a FOK order was not filled.
    /// The Vault injects bet_amount from betRecords to prevent the user
    /// from claiming a different amount than what was deducted.
    function betCancellationCredit(
        bytes calldata proof,
        BetCancelPublicInputs calldata inputs
    ) external nonReentrant whenNotPaused {
        if (nullifiers.isSpent(inputs.nullifier)) revert NullifierSpent();
        if (!tree.isKnownRoot(inputs.merkle_root)) revert UnknownRoot();

        BetRecord storage rec = betRecords[inputs.nullifier_of_bet];
        if (rec.market_id == bytes32(0)) revert BetNotFound();
        if (rec.status != BetStatus.FAILED) revert BetNotFailed();

        bytes32[] memory pubInputs = _betCancelPublicInputs(inputs, rec.bet_amount);
        if (!IVerifier(verifiers[BET_CANCEL]).verify(proof, pubInputs)) revert InvalidProof();

        nullifiers.markSpent(inputs.nullifier);
        tree.insert(inputs.new_commitment);
        rec.status = BetStatus.CANCELLED_CREDITED;

        emit BetCancellationCredited(inputs.nullifier, inputs.nullifier_of_bet, inputs.new_commitment);
    }

    // -------------------------------------------------------------------------
    // N/A Cancellation Credit (market resolved N/A)
    // -------------------------------------------------------------------------

    /// @notice Credit back the bet amount when the market resolved N/A.
    /// Verifies on-chain that CTF payoutNumerators are all zero (N/A resolution).
    function naCancellationCredit(
        bytes calldata proof,
        NACancelPublicInputs calldata inputs
    ) external nonReentrant whenNotPaused {
        if (nullifiers.isSpent(inputs.nullifier)) revert NullifierSpent();
        if (!tree.isKnownRoot(inputs.merkle_root)) revert UnknownRoot();

        BetRecord storage rec = betRecords[inputs.nullifier_of_bet];
        if (rec.market_id == bytes32(0)) revert BetNotFound();
        if (rec.market_id != inputs.market_id) revert WrongMarket();
        // C1: prevent double-credit — only ACTIVE and FILLED bets can be N/A-credited
        if (rec.status != BetStatus.ACTIVE && rec.status != BetStatus.FILLED) revert BetNotCancellable();
        // C2: confirm the condition has actually resolved (denominator > 0) before checking N/A
        uint256 denominator = ctf.payoutDenominator(inputs.market_id);
        if (denominator == 0) revert ConditionNotResolved();

        // Verify N/A: all payoutNumerators must be zero
        uint256[] memory numerators = ctf.payoutNumerators(inputs.market_id);
        for (uint256 i = 0; i < numerators.length; i++) {
            if (numerators[i] != 0) revert NotNA();
        }

        bytes32[] memory pubInputs = _naCancelPublicInputs(inputs, rec.bet_amount);
        if (!IVerifier(verifiers[CANCEL_CREDIT]).verify(proof, pubInputs)) revert InvalidProof();

        nullifiers.markSpent(inputs.nullifier);
        tree.insert(inputs.new_commitment);
        rec.status = BetStatus.CANCELLED_CREDITED;

        emit NACancellationCredited(inputs.nullifier, inputs.nullifier_of_bet, inputs.new_commitment);
    }

    // -------------------------------------------------------------------------
    // Public input assembly helpers
    // Each function packs the circuit's `pub` parameters in declaration order.
    // -------------------------------------------------------------------------

    function _betAuthPublicInputs(BetAuthPublicInputs calldata i) internal pure returns (bytes32[] memory) {
        bytes32[] memory p = new bytes32[](9);
        p[0] = i.merkle_root;
        p[1] = i.nullifier;
        p[2] = i.new_commitment;
        p[3] = bytes32(uint256(i.bet_amount));
        p[4] = bytes32(uint256(i.price));
        p[5] = bytes32(uint256(i.expected_shares));
        p[6] = i.market_id;
        p[7] = bytes32(uint256(i.outcome_side));
        p[8] = i.position_id;
        return p;
    }

    function _settlementPublicInputs(SettlementPublicInputs calldata i)
        internal
        pure
        returns (bytes32[] memory)
    {
        bytes32[] memory p = new bytes32[](6);
        p[0] = i.merkle_root;
        p[1] = i.nullifier;
        p[2] = i.new_commitment;
        p[3] = i.nullifier_of_bet;
        p[4] = i.market_id;
        p[5] = bytes32(uint256(i.total_credit));
        return p;
    }

    function _withdrawalPublicInputs(WithdrawalPublicInputs calldata i) internal pure returns (bytes32[] memory) {
        bytes32[] memory p = new bytes32[](5);
        p[0] = i.merkle_root;
        p[1] = i.nullifier;
        p[2] = bytes32(uint256(i.withdrawal_amount));
        p[3] = i.recipient_hash;
        p[4] = i.new_commitment;
        return p;
    }

    function _betCancelPublicInputs(BetCancelPublicInputs calldata i, uint64 bet_amount)
        internal
        pure
        returns (bytes32[] memory)
    {
        bytes32[] memory p = new bytes32[](5);
        p[0] = i.merkle_root;
        p[1] = i.nullifier;
        p[2] = i.new_commitment;
        p[3] = i.nullifier_of_bet;
        p[4] = bytes32(uint256(bet_amount)); // Vault-injected; uint64 → uint256 → bytes32
        return p;
    }

    function _naCancelPublicInputs(NACancelPublicInputs calldata i, uint64 bet_amount)
        internal
        pure
        returns (bytes32[] memory)
    {
        bytes32[] memory p = new bytes32[](6);
        p[0] = i.merkle_root;
        p[1] = i.nullifier;
        p[2] = i.new_commitment;
        p[3] = i.nullifier_of_bet;
        p[4] = i.market_id;
        p[5] = bytes32(uint256(bet_amount)); // Vault-injected; uint64 → uint256 → bytes32
        return p;
    }
}
