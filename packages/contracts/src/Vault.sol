// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin-upgradeable/utils/PausableUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {CommitmentMerkleTree} from "./CommitmentMerkleTree.sol";
import {NullifierRegistry} from "./NullifierRegistry.sol";
// IVerifier dispatch now lives inside VaultInputs (verify-wrappers) to keep the Vault
// under the EIP-170 limit; the Vault no longer references IVerifier directly.
import {ICollateralOnramp} from "./interfaces/ICollateralOnramp.sol";
import {ICollateralOfframp} from "./interfaces/ICollateralOfframp.sol";
import {ICTF} from "./interfaces/ICTF.sol";
// FEE/EIP-170: the public-input structs and their pure assembly helpers live in an external
// library (DELEGATECALL-linked) to keep this contract under the 24576-byte runtime limit.
import {
    VaultInputs,
    BetStatus,
    BetRecord,
    OperatorAttestation,
    FeeConfig,
    BetAuthPublicInputs,
    SettlementPublicInputs,
    WithdrawalPublicInputs,
    BetCancelPublicInputs,
    NACancelPublicInputs,
    ClosePublicInputs,
    PartialFillPublicInputs,
    ConsolidatePublicInputs
} from "./VaultInputs.sol";
// EIP-170: bulkier spend-path function bodies live in this external (DELEGATECALL-linked)
// library so the Vault stays under the 24576-byte runtime limit.
import {VaultLogic} from "./VaultLogic.sol";

/// @notice Privacy-preserving vault for Polymarket positions.
/// Users deposit USDC, then authorize bets, credit settlements, and withdraw
/// using ZK proofs that hide which depositor authorized which bet.
contract Vault is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardTransient,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable
{
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Proof type identifiers (index into verifiers mapping)
    // -------------------------------------------------------------------------
    uint8 public constant BET_AUTH = 0;
    uint8 public constant SETTLEMENT_CREDIT = 1;
    uint8 public constant WITHDRAWAL = 2;
    uint8 public constant BET_CANCEL = 3;
    uint8 public constant CANCEL_CREDIT = 4;
    uint8 public constant DEPOSIT = 5;        // FC-2: mandatory deposit binding proof
    uint8 public constant POSITION_CLOSE = 6; // FC-1: secondary-sale position close
    uint8 public constant PARTIAL_CREDIT = 7; // FC-4: limit-order partial-fill refund
    uint8 public constant CONSOLIDATE = 8;    // FC-8: K=4 note consolidation (merge)

    // -------------------------------------------------------------------------
    // Types — BetStatus / BetRecord / OperatorAttestation / FeeConfig and the
    // public-input structs are defined at FILE SCOPE in VaultInputs.sol (imported
    // above) so the external VaultLogic library can also reference them. ABI unchanged.
    // -------------------------------------------------------------------------

    // Report-type constants for OperatorAttestation.reportType (1=FILLED, 2=FAILED, 3=PARTIAL, 4=SOLD).
    uint8 public constant REPORT_FILLED = 1;
    uint8 public constant REPORT_FAILED = 2;
    uint8 public constant REPORT_PARTIAL = 3;
    uint8 public constant REPORT_SOLD = 4;

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------
    uint256 public constant DEPOSIT_CAP = 50_000 * 1e6; // $50k USDC (6 decimals)
    // BN254 scalar field prime — conditionIds that exceed this are reduced before
    // use as circuit Field inputs and as pendingCredit keys.
    uint256 private constant BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // FC-9 attestation verification (typehash + ECDSA) now lives in VaultLogic.

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
    // ⚠ TEST-ONLY: lowered from `48 hours` to `15 minutes` so the mainnet TEST deploy does
    // not stall for two days between proposeVerifier and acceptVerifier. REVERT to `48 hours`
    // before the real launch. This delay is the public-notice window that lets users/watchers
    // detect a malicious or mistaken verifier swap before it goes live (see docs/threat-model.md).
    uint256 public constant VERIFIER_TIMELOCK = 15 minutes;
    mapping(bytes32 => BetRecord) public betRecords;
    mapping(address => uint256) public cumulativeDeposits;
    // circuit_key (conditionId % BN254_P) => outcome_side => payout_per_share
    // payout_per_share = numerators[outcome_side] / denominator (0 or 1 for binary markets)
    mapping(bytes32 => mapping(uint8 => uint64)) public pendingCredit;
    mapping(bytes32 => uint64) public marketResolvedAt; // conditionId => block.timestamp
    mapping(bytes32 => uint64) public betCreatedAt;    // nullifier_of_bet => block.timestamp at authorizeBet
    uint256 public adminCancelTimelock;                 // seconds; set to 24h in initialize(); governance-mutable
    uint256 public deployedToPolymarket;               // USDC-equivalent currently held in depositWallet
    // SEC-007: aggregate cap on USDC deployed to Polymarket via fundPolymarketWallet.
    // Defaults to "unlimited" to preserve existing behaviour; governance should set a
    // concrete limit post-deploy via setDeploymentCap to bound a compromised operator.
    uint256 public deploymentCap; // set to type(uint256).max in initialize()

    // FEE (P2/P4): governance-mutable fee parameters + accrued-fee balance. feeAccumulator is
    // USDC sitting in the pool that is owed to feeConfig.feeRecipient (claimable via withdrawFees).
    FeeConfig public feeConfig;
    uint256 public feeAccumulator;

    // FC-11: circuit_key (conditionId % BN254_P, the on-chain market_id) => REAL CTF conditionId.
    // On-chain market_id is the field-safe reduction of the conditionId, which is lossy and cannot
    // be used as a CTF lookup key. The operator records the real conditionId here (resolveMarket
    // for resolved markets; registerCondition for N/A markets) so naCancellationCredit can query
    // ctf.payout*(realConditionId). Trustless: writes verify conditionId % BN254_P == circuit_key.
    mapping(bytes32 => bytes32) public conditionIdOf;

    /// @dev Reserved storage slots for future UUPS upgrades. Append new state by
    /// shrinking this gap; never reorder or remove the state variables declared above.
    /// FEE added FeeConfig (2 slots) + feeAccumulator (1 slot): __gap 50 -> 47.
    /// FC-11 added conditionIdOf (1 slot): __gap 47 -> 46.
    uint256[46] private __gap;

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
    error ConditionNotRegistered();
    error BetNotActive();
    error BetTimeoutNotElapsed();
    error InsufficientVaultLiquidity();
    error InsufficientLiquidity(uint256 available, uint256 requested);
    error InvalidAmount();
    error DeployCapExceeded();      // SEC-007: fundPolymarketWallet would exceed deploymentCap
    error ZeroAddress();
    error VerifierTimelockActive();
    error PayoutRoundsToZero();
    error BetNotClosing();          // FC-1: closePosition requires status ACTIVE or FILLED
    error InvalidSoldShares();      // FC-1: cumulative sold_shares must be > prior and <= expected_shares
    error NonMonotonicProceeds();   // FC-1: cumulative sell_proceeds must not decrease across closes
    error AlreadyPartiallyClosed(); // FC-1: naCancellationCredit blocked once the position was (partly) sold
    error CannotCloseResolvedMarket(); // FC-1: resolved markets settle, they do not close
    error BetNotPartialFillable();  // FC-4: reportPartialFill requires status ACTIVE or RESTING
    error BetNotPartialFilled();    // FC-4: partialFillCredit requires status PARTIAL_FILLED
    error BetNotReportable();       // FC-4: reportFilled/reportFOKFailure require ACTIVE or RESTING
    error InvalidFilledShares();    // FC-4: filled_shares must be > 0 and < expected_shares (strict partial)
    error InvalidSpentAmount();     // FC-4: spent_amount must be > 0 and < bet_amount (strict partial)
    error EmptyConsolidation();     // FC-8: consolidate requires slot 0 active (nullifier[0] != 0)
    error InvalidAttestation();     // FC-9: operator signature did not recover to signingLayerOperator
    error AttestationMismatch();    // FC-9: attestation nullifier/type does not match the call
    error AttestationRequired();    // FC-9: an ACTIVE bet needs an operator attestation to credit
    error BelowMinimum();           // FEE: bet_amount < minBet or withdrawal_amount < minWithdrawal
    error NotFeeRecipient();        // FEE: withdrawFees caller is not feeConfig.feeRecipient

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------
    event Deposited(address indexed depositor, bytes32 commitment, uint256 amount);
    event MarketResolved(bytes32 indexed market_id, uint64 resolvedAt);
    event ConditionRegistered(bytes32 indexed circuit_key, bytes32 condition_id);
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
    event BetSold(bytes32 indexed nullifier_of_bet, uint64 sold_shares, uint64 proceeds);
    event PositionClosed(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment, bool fullClose);
    event BetResting(bytes32 indexed nullifier_of_bet);
    event BetPartialFilled(bytes32 indexed nullifier_of_bet, uint64 filled_shares, uint64 spent_amount);
    event PartialFillCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment);
    // FC-8: carries all 4 input nullifiers (zeros for inactive slots) + the merged output
    // commitment. Recovery matches a wallet's lineage by membership in `nullifiers`.
    event Consolidated(bytes32[4] nullifiers, bytes32 new_commitment);
    // FEE: governance updated the fee parameters / a recipient claimed accrued fees.
    event FeeParamsUpdated(FeeConfig config);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event AdminSwept(address indexed to, uint256 amount);

    // -------------------------------------------------------------------------
    // Initializer (UUPS)
    // -------------------------------------------------------------------------
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the Vault proxy. Replaces the former constructor.
    /// Callable exactly once (through the ERC1967 proxy), never on the implementation.
    function initialize(
        address _usdc,
        address _tree,
        address _nullifiers,
        address _onramp,
        address _offramp,
        address _ctf,
        address _signingLayerOperator,
        address _depositWallet,
        address _owner
    ) external initializer {
        if (_usdc == address(0) || _tree == address(0) || _nullifiers == address(0) ||
            _onramp == address(0) || _offramp == address(0) || _ctf == address(0) ||
            _signingLayerOperator == address(0) || _depositWallet == address(0) ||
            _owner == address(0)) revert ZeroAddress();
        __Ownable_init(_owner);
        __Ownable2Step_init();
        __Pausable_init();
        // ReentrancyGuardTransient is stateless (transient storage) — no init required.
        // UUPSUpgradeable has no initializer in OZ v5.

        usdc = IERC20(_usdc);
        tree = CommitmentMerkleTree(_tree);
        nullifiers = NullifierRegistry(_nullifiers);
        onramp = ICollateralOnramp(_onramp);
        offramp = ICollateralOfframp(_offramp);
        ctf = ICTF(_ctf);
        signingLayerOperator = _signingLayerOperator;
        depositWallet = _depositWallet;

        // Defaults formerly set via inline initializers (which do not run in a proxy).
        adminCancelTimelock = 86_400;          // 24 hours
        deploymentCap = type(uint256).max;     // unlimited until governance sets a cap (SEC-007)

        // FEE defaults (governance-mutable via setFeeParams). betFeeBps = 5 (0.05%);
        // relay gas reimbursement starts at 0 (governance sets the live USDC rate);
        // $1 min bet (Polymarket floor); $0.10 withdrawal fee; $1 min withdrawal (testing).
        // NOTE: proxies upgraded (not freshly initialized) into this version must call
        // setFeeParams once — initialize does not re-run on an existing proxy.
        feeConfig = FeeConfig({
            betFeeBps: 5,
            relayGasFeeUSDC: 0,
            minBet: 1_000_000,
            withdrawalFeeUSDC: 100_000,
            minWithdrawal: 1_000_000,
            feeRecipient: _owner
        });
    }

    /// @notice FC-9 upgrade initializer. Sets up the EIP-712 domain used to verify operator
    /// fill attestations. Run exactly once, after the implementation upgrade that introduces
    /// gasless operator reporting. EIP712Upgradeable uses ERC-7201 namespaced storage, so this
    /// does not disturb the existing sequential layout or __gap.
    function initializeV2() external reinitializer(2) {
        __EIP712_init("Polyshield", "1");
        // FC-9: lengthen the adminCancelBet timelock (see setAdminCancelTimelock) since an
        // ACTIVE bet may now be a healthy filled-but-unclaimed position.
        adminCancelTimelock = 7 days;
    }

    /// @dev Bundle the handles every spend-path VaultLogic function needs. The EIP-712 domain
    /// separator is computed here (EIP712Upgradeable) and passed so the library can verify
    /// operator attestations without the Vault's inherited internals.
    function _ctx() internal view returns (VaultLogic.Ctx memory) {
        return VaultLogic.Ctx(tree, nullifiers, signingLayerOperator, _domainSeparatorV4());
    }

    /// @notice UUPS upgrade authorization. Owner-gated, instant (no timelock).
    /// @dev See docs/threat-model.md — the owner can replace Vault logic in one tx;
    /// the owner role should be a multisig/HSM in production.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // -------------------------------------------------------------------------
    // Shared spend-path helpers
    // -------------------------------------------------------------------------
    // Every note-spending entry point runs the same prologue (nullifier unspent +
    // root known) and the same effects (mark spent + append the change leaf). These
    // are factored out so the (external-call-bearing) logic is emitted once rather
    // than inlined into each of the ~7 callers, keeping the Vault under the 24576-byte
    // EIP-170 limit. Behaviour is identical to the prior inline code — do not reorder.

    /// @dev Entry checks shared by every spend path: the input note's nullifier must be
    /// unspent and `root` must be a known historical Merkle root.
    function _requireUnspentKnownRoot(bytes32 nullifier, bytes32 root) internal view {
        if (nullifiers.isSpent(nullifier)) revert NullifierSpent();
        if (!tree.isKnownRoot(root)) revert UnknownRoot();
    }

    /// @dev Effects shared by every spend path (checks-effects-interactions): mark the
    /// input nullifier spent, then append the new commitment leaf if one was supplied.
    /// `commitment == 0` (no change note, e.g. a full withdrawal) skips the insert.
    function _spendAndInsert(bytes32 nullifier, bytes32 commitment) internal {
        nullifiers.markSpent(nullifier);
        if (commitment != bytes32(0)) tree.insert(commitment);
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
        // SEC-006: never finalize a slot that was never proposed. An un-proposed slot has
        // verifierUpdateAt == 0 (timelock check would pass) and pendingVerifiers == address(0),
        // which would otherwise blank the active verifier and brick that proof type.
        if (pendingVerifiers[proofType] == address(0)) revert ZeroAddress();
        if (block.timestamp < verifierUpdateAt[proofType]) revert VerifierTimelockActive();
        verifiers[proofType] = pendingVerifiers[proofType];
        emit VerifierAccepted(proofType, verifiers[proofType]);
    }

    function setSigningLayerOperator(address operator) external onlyOwner {
        signingLayerOperator = operator;
    }

    /// @notice Update the aggregate cap on USDC deployed to Polymarket. Owner-controlled (SEC-007).
    function setDeploymentCap(uint256 _cap) external onlyOwner {
        deploymentCap = _cap;
    }

    /// @notice Update all fee parameters at once (governance). One combined setter keeps the
    /// Vault under the EIP-170 limit vs. one setter per field.
    function setFeeParams(FeeConfig calldata c) external onlyOwner {
        if (c.feeRecipient == address(0)) revert ZeroAddress();
        // Prevent an underflow footgun in withdraw(): a withdrawal at the minimum must still
        // cover the fee (payout = withdrawal_amount - withdrawalFeeUSDC >= 0).
        if (c.minWithdrawal < c.withdrawalFeeUSDC) revert InvalidAmount();
        feeConfig = c;
        emit FeeParamsUpdated(c);
    }

    /// @notice Claim accrued protocol/withdrawal fees (USDC) to the feeRecipient. The fees
    /// already sit in the vault pool; this pays them out and decrements the accumulator.
    function withdrawFees(uint256 amount) external nonReentrant {
        if (msg.sender != feeConfig.feeRecipient) revert NotFeeRecipient();
        if (amount > feeAccumulator) revert InvalidAmount();
        feeAccumulator -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit FeesWithdrawn(msg.sender, amount);
    }

    /// @notice Update the timelock duration for adminCancelBet. Owner-controlled.
    /// FC-9: floor raised to 3 days — under gasless reporting an ACTIVE bet may be a healthy
    /// filled-but-unclaimed position, so adminCancelBet is an owner-trusted last resort and
    /// must give ample time before a force-cancel is permitted.
    function setAdminCancelTimelock(uint256 _seconds) external onlyOwner {
        require(_seconds >= 3 days, "timelock too short");
        adminCancelTimelock = _seconds;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice TESTING-PHASE escape hatch: sweep `amount` of the Vault's USDC to `to`. Recovers funds
    /// that are otherwise unspendable through the normal nullifier path — e.g. a note whose nullifier
    /// collided with an already-spent one (a nonce-0 deposit can never be re-spent), so no withdrawal
    /// proof can ever release it. onlyOwner; intentionally NOT whenNotPaused so funds can be rescued
    /// during a pause. `safeTransfer` reverts if `amount` exceeds the Vault's balance.
    ///
    /// TRUST: this lets the owner move pool USDC arbitrarily. It grants NO capability the owner does
    /// not already hold via the instant `onlyOwner` UUPS upgrade (threat-model T21) — but it is an
    /// explicit fund-drain lever. The owner MUST be a multisig/HSM, and this MUST be removed or
    /// replaced with a constrained/timelocked recovery before any public, multi-user phase.
    function adminSweep(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        usdc.safeTransfer(to, amount);
        emit AdminSwept(to, amount);
    }

    /// @notice Fund the Polymarket deposit wallet in USDC directly (JIT, Option 3).
    /// Operator-callable; tracks deployed amount in deployedToPolymarket.
    /// @dev Real Polymarket settles in USDC.e, so the vault forwards USDC straight to the
    /// deposit wallet — the prior pUSD onramp hop was removed (the mainnet pUSD/onramp was a
    /// non-functional stub and `onramp.deposit()` reverted). The `onramp`/`offramp` handles
    /// remain in storage for the settlement-return pipeline; this funding path no longer uses
    /// the onramp. Approved as a collateral-model change (see docs/collateral-* / FC-7).
    function fundPolymarketWallet(uint256 amount) external nonReentrant whenNotPaused {
        if (msg.sender != signingLayerOperator) revert OnlyOperator();
        if (usdc.balanceOf(address(this)) < amount) revert InsufficientVaultLiquidity();
        // SEC-007: bound aggregate deployment to Polymarket so a compromised operator cannot
        // drain the vault in one move; combined with whenNotPaused, blocks deployment during a pause.
        if (deployedToPolymarket + amount > deploymentCap) revert DeployCapExceeded();
        deployedToPolymarket += amount;

        usdc.safeTransfer(depositWallet, amount); // fund the deposit wallet in USDC directly
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
    /// @dev The commitment must equal Poseidon4(secret, amount, 0, owner_address),
    /// computed client-side (see docs/zk-design.md §2). The MANDATORY deposit
    /// binding proof (FC-2 / T20) ties the hidden note `balance` and `owner_address`
    /// to the publicly transferred `amount` and `msg.sender`: the Vault verifies the
    /// proof against public inputs (commitment, amount, uint256(uint160(msg.sender))),
    /// forcing balance == amount, nonce == 0, owner == msg.sender. Without this proof a
    /// depositor could commit a larger balance than they paid and drain the pool.
    function deposit(bytes calldata proof, bytes32 commitment, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        if (cumulativeDeposits[msg.sender] + amount > DEPOSIT_CAP) revert DepositCapExceeded();
        if (!VaultInputs.verifyDeposit(verifiers[DEPOSIT], proof, commitment, amount, msg.sender))
            revert InvalidProof();

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
        _requireUnspentKnownRoot(inputs.nullifier, inputs.merkle_root);

        // FEE: enforce the Polymarket minimum order size, then compute the Vault-authoritative
        // fee = bet_amount * betFeeBps / 10000 + relayGasFeeUSDC from governance storage. Injecting
        // it as a public input forces the proof's post-bet balance to be
        // current_balance - bet_amount - fee; a user cannot substitute a smaller fee (their
        // new_commitment would not match the injected value and verification fails). Applies
        // uniformly to every order type (FOK/FAK/GTC/GTD) — order type is an off-chain concern.
        FeeConfig memory fc = feeConfig;
        if (inputs.bet_amount < fc.minBet) revert BelowMinimum();
        uint64 fee = uint64(uint256(inputs.bet_amount) * fc.betFeeBps / 10_000) + fc.relayGasFeeUSDC;

        if (!VaultInputs.verifyBetAuth(verifiers[BET_AUTH], proof, inputs, fee)) revert InvalidProof();

        _spendAndInsert(inputs.nullifier, inputs.new_commitment);
        feeAccumulator += fee;

        betRecords[inputs.nullifier] = BetRecord({
            market_id: inputs.market_id,
            condition_id: inputs.market_id,
            position_id: inputs.position_id,
            expected_shares: inputs.expected_shares,
            bet_amount: inputs.bet_amount,
            outcome_side: inputs.outcome_side,
            status: BetStatus.ACTIVE,
            sell_proceeds: 0,
            sold_shares: 0,
            filled_shares: 0,
            spent_amount: 0
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
    // Operator: fill reporting (FC-9 — GASLESS via off-chain EIP-712 attestations)
    // -------------------------------------------------------------------------
    //
    // The operator no longer pushes fill status on-chain (reportFilled / reportFOKFailure /
    // reportResting / reportPartialFill / reportSold are removed). Instead it signs an
    // OperatorAttestation off-chain and the user submits that signature with their
    // credit/cancel/close proof; the relevant function verifies sig == signingLayerOperator
    // and uses the attested values. This makes operator reporting cost the protocol ZERO gas
    // (the cost folds into the user's own credit tx, which they pay anyway) and means a
    // slow-filling limit order needs no interim on-chain writes — only the single terminal
    // attestation, consumed at action time, matters.
    //
    // HARD INVARIANT (enforced off-chain by the signing layer, see docs/threat-model.md):
    // the operator MUST sign EXACTLY ONE terminal attestation per bet. The on-chain guards
    // below prevent replaying the SAME signature (single-use post-bet note + terminal status)
    // but CANNOT adjudicate two DIFFERENT valid signatures for one bet — the user would pick
    // whichever pays them most. Single-terminal-signing is therefore a load-bearing operator
    // requirement, not a nicety.

    /// @notice Emergency cancel for in-flight bets when the Signing Layer is permanently
    /// gone (lost keys / fully unresponsive) and cannot even sign an off-chain attestation.
    /// Sets the bet to FAILED so the depositor can call betCancellationCredit to recover funds.
    ///
    /// FC-9 CAUTION: under gasless reporting, an unclaimed-but-filled bet stays ACTIVE
    /// on-chain (the operator no longer writes FILLED), so "ACTIVE" no longer means "stuck".
    /// A banned operator can still SIGN an attestation off-chain (a ban blocks order placement,
    /// not local signing), so the original stuck-funds scenario is largely gone. This is now an
    /// OWNER-TRUSTED last resort: the owner must confirm off-chain that no fill occurred / no
    /// attestation was issued before cancelling, and the timelock is deliberately long. The
    /// power is bounded by the existing owner trust (the owner can already UUPS-upgrade the Vault).
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

    /// @dev Reduce a conditionId to the BN254 field range used as the on-chain market_id /
    /// pendingCredit / conditionIdOf key. Shared by resolveMarket, creditSettlement,
    /// registerCondition and naCancellationCredit so the reduction is defined once.
    function _circuitKey(bytes32 conditionId) internal pure returns (bytes32) {
        return bytes32(uint256(conditionId) % BN254_P);
    }

    /// @notice Called by the operator after a Polymarket market resolves (non-N/A).
    /// Reads payout from the CTF contract and stores per-outcome payouts keyed by
    /// the BN254-reduced circuit_key so settlement proofs can use it directly.
    /// payout_per_share for each outcome = numerators[i] / denominator (0 or 1 for
    /// standard binary Polymarket markets).
    function resolveMarket(bytes32 market_id) external {
        if (msg.sender != signingLayerOperator) revert OnlyOperator();

        // Reduce conditionId to BN254 field range for use as circuit-compatible key.
        bytes32 circuit_key = _circuitKey(market_id);
        if (marketResolvedAt[circuit_key] != 0) revert MarketAlreadyResolved();

        uint256 denominator = ctf.payoutDenominator(market_id);
        if (denominator == 0) revert ConditionNotResolved();

        // Read payouts element-by-index from the real CTF (no array getter exists on-chain — see
        // ICTF). Store payout for each outcome; for binary markets numerators[i]/denominator is
        // exactly 0 or 1. Users whose outcome_side lost get payout_per_share = 0 and their bet is
        // treated as worthless (no settlement needed). A reverting branch undoes any writes made
        // above it, so the NotNA / PayoutRoundsToZero guards are safe to check after the loop.
        uint256 slotCount = ctf.getOutcomeSlotCount(market_id);
        bool anyNonZero = false;
        bool anyNonZeroAfterDiv = false;
        for (uint256 i = 0; i < slotCount; i++) {
            uint256 numerator = ctf.payoutNumerators(market_id, i);
            if (numerator > 0) anyNonZero = true;
            // SEC-005: division can exceed uint64 for non-binary markets; revert instead of
            // silently truncating, which would corrupt settlement math.
            uint256 ratio = numerator / denominator;
            require(ratio <= type(uint64).max, "pps overflow");
            uint64 pps = uint64(ratio);
            pendingCredit[circuit_key][uint8(i)] = pps;
            if (pps > 0) anyNonZeroAfterDiv = true;
        }
        if (!anyNonZero) revert NotNA();
        if (!anyNonZeroAfterDiv) revert PayoutRoundsToZero();

        uint64 resolvedAt = uint64(block.timestamp);
        marketResolvedAt[circuit_key] = resolvedAt;
        // FC-11: record the real conditionId so N/A cancellation (and any future CTF lookup)
        // can use it. `market_id` here is the real conditionId; circuit_key is its reduction.
        conditionIdOf[circuit_key] = market_id;
        emit MarketResolved(circuit_key, resolvedAt);
    }

    /// @notice Operator records the real CTF conditionId for a market whose payouts are all
    /// zero (N/A). resolveMarket reverts NotNA for such markets and never records the mapping,
    /// so naCancellationCredit would have no real conditionId to query CTF with. Trustless: the
    /// supplied conditionId must reduce to the circuit_key the bets used, so the operator cannot
    /// map a market to the wrong condition. Idempotent.
    function registerCondition(bytes32 condition_id) external {
        if (msg.sender != signingLayerOperator) revert OnlyOperator();
        bytes32 circuit_key = _circuitKey(condition_id);
        conditionIdOf[circuit_key] = condition_id;
        emit ConditionRegistered(circuit_key, condition_id);
    }

    // -------------------------------------------------------------------------
    // Settlement Credit
    // -------------------------------------------------------------------------

    /// @notice Credit a settled bet's payout back into the user's note.
    /// The Vault injects shares_held from betRecords to prevent the user
    /// from claiming a different share count than what was recorded at bet time.
    ///
    /// FC-9: the bet must be confirmed filled. Either it is already on-chain FILLED (set by a
    /// prior partialFillCredit normalization), or the caller supplies a FILLED operator
    /// attestation that flips the ACTIVE record's shares-held into play (a full fill confirms
    /// all expected_shares were bought). `att`/`sig` are ignored when status is already FILLED.
    function creditSettlement(
        bytes calldata proof,
        SettlementPublicInputs calldata inputs,
        OperatorAttestation calldata att,
        bytes calldata sig
    ) external nonReentrant whenNotPaused {
        // Body in VaultLogic (EIP-170). Modifiers stay here; storage mappings passed by ref.
        VaultLogic.creditSettlement(
            _ctx(), betRecords, pendingCredit, marketResolvedAt, verifiers[SETTLEMENT_CREDIT], proof, inputs, att, sig
        );
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
        _requireUnspentKnownRoot(inputs.nullifier, inputs.merkle_root);

        // FEE (P4): enforce the minimum withdrawal and skim a flat USDC fee from the payout.
        // The note still burns the full withdrawal_amount; the recipient receives
        // withdrawal_amount - withdrawalFeeUSDC and the fee stays in the pool for feeRecipient.
        // No circuit change needed — the Vault controls the USDC leaving the pool directly.
        FeeConfig memory fc = feeConfig;
        if (inputs.withdrawal_amount < fc.minWithdrawal) revert BelowMinimum();

        if (!VaultInputs.verifyWithdrawal(verifiers[WITHDRAWAL], proof, inputs)) revert InvalidProof();

        // Verify recipientAddress matches the commitment in the proof
        bytes32 computedHash = tree.hashTwo(bytes32(uint256(uint160(recipientAddress))), bytes32(0));
        if (computedHash != inputs.recipient_hash) revert BadRecipient();

        // H1: explicit solvency guard — gives a meaningful error when funds are deployed.
        // Guards the full amount: the vault must hold the payout (amount - fee) AND retain the fee.
        uint256 available = usdc.balanceOf(address(this));
        if (available < uint256(inputs.withdrawal_amount))
            revert InsufficientLiquidity(available, uint256(inputs.withdrawal_amount));

        _spendAndInsert(inputs.nullifier, inputs.new_commitment);
        feeAccumulator += fc.withdrawalFeeUSDC;
        usdc.safeTransfer(recipientAddress, uint256(inputs.withdrawal_amount) - fc.withdrawalFeeUSDC);

        emit Withdrawn(inputs.nullifier, recipientAddress, uint256(inputs.withdrawal_amount), inputs.new_commitment);
    }

    // -------------------------------------------------------------------------
    // Bet Cancellation Credit (FOK failed)
    // -------------------------------------------------------------------------

    /// @notice Credit back the bet amount when a FOK order was not filled.
    /// The Vault injects bet_amount from betRecords to prevent the user
    /// from claiming a different amount than what was deducted.
    ///
    /// FC-9: the bet must be confirmed failed. Either it is already on-chain FAILED (set by
    /// adminCancelBet), or the caller supplies a FAILED operator attestation that authorizes
    /// the refund directly from an ACTIVE record. `att`/`sig` are ignored when already FAILED.
    function betCancellationCredit(
        bytes calldata proof,
        BetCancelPublicInputs calldata inputs,
        OperatorAttestation calldata att,
        bytes calldata sig
    ) external nonReentrant whenNotPaused {
        VaultLogic.betCancellationCredit(_ctx(), betRecords, verifiers[BET_CANCEL], proof, inputs, att, sig);
    }

    // -------------------------------------------------------------------------
    // N/A Cancellation Credit (market resolved N/A)
    // -------------------------------------------------------------------------

    /// @notice Credit back the bet amount when the market resolved N/A.
    /// Verifies on-chain that CTF payoutNumerators are all zero (N/A resolution).
    ///
    /// FC-9: a terminal fill state is still required so the pool is never refunded while a fill
    /// is in flight. Either the record is already FILLED/FAILED, or the caller supplies a
    /// FILLED or FAILED operator attestation for an ACTIVE record. The shared
    /// CANCELLED_CREDITED terminal status prevents any cross-function double-credit.
    function naCancellationCredit(
        bytes calldata proof,
        NACancelPublicInputs calldata inputs,
        OperatorAttestation calldata att,
        bytes calldata sig
    ) external nonReentrant whenNotPaused {
        VaultLogic.naCancellationCredit(
            _ctx(), betRecords, conditionIdOf, ctf, verifiers[CANCEL_CREDIT], proof, inputs, att, sig
        );
    }

    // -------------------------------------------------------------------------
    // Position Close (FC-1: secondary sale before settlement)
    // -------------------------------------------------------------------------

    /// @notice Credit operator-attested SELL proceeds back into the user's note.
    /// Mirrors creditSettlement: the user spends the post-bet note, proves membership,
    /// and recommits balance + the newly-credited proceeds. The proceeds come from a SOLD
    /// operator attestation (amountA = cumulative sold_shares, amountB = cumulative proceeds),
    /// injected so the user cannot inflate them in the proof.
    ///
    /// FC-1: a close may be PARTIAL. The attestation carries the CUMULATIVE shares sold; the Vault
    /// credits only the delta proceeds and records cumulative sold_shares/sell_proceeds. A full close
    /// (att.amountA == rec.expected_shares) is terminal (CLOSED_CREDITED); a partial leaves the record
    /// FILLED so the unsold remainder settles at resolution (creditSettlement nets out sold_shares).
    /// The cumulative gate (amountA strictly > recorded) also makes a persisted SOLD non-replayable.
    /// Callable on an ACTIVE full-fill bet or a FILLED (post-partial) record. Resolved markets settle.
    function closePosition(
        bytes calldata proof,
        ClosePublicInputs calldata inputs,
        OperatorAttestation calldata att,
        bytes calldata sig
    ) external nonReentrant whenNotPaused {
        VaultLogic.closePosition(_ctx(), betRecords, marketResolvedAt, verifiers[POSITION_CLOSE], proof, inputs, att, sig);
    }

    // -------------------------------------------------------------------------
    // Partial-fill credit (FC-4: limit order partially filled then terminated)
    // -------------------------------------------------------------------------

    /// @notice Refund the unfilled remainder of a partially-filled limit order and
    /// normalize the bet record to a clean FILLED state. Constraint-identical to
    /// betCancellationCredit: the user spends the post-bet note, proves membership,
    /// and recommits balance + refund_amount.
    ///
    /// FC-9: the partial fill is attested off-chain by a PARTIAL operator attestation
    /// (amountA = filled_shares, amountB = spent_amount). The Vault validates the strict-partial
    /// bounds, injects refund_amount = bet_amount - spent_amount, and after crediting normalizes
    /// the record (expected_shares := filled_shares, bet_amount := spent_amount, status := FILLED)
    /// so creditSettlement / naCancellationCredit / closePosition all operate on a normal FILLED
    /// record afterward. This (post-partial normalization) is the ONLY way a record reaches the
    /// on-chain FILLED status, which is what makes the no-attestation FILLED branch of those
    /// functions safe.
    function partialFillCredit(
        bytes calldata proof,
        PartialFillPublicInputs calldata inputs,
        OperatorAttestation calldata att,
        bytes calldata sig
    ) external nonReentrant whenNotPaused {
        VaultLogic.partialFillCredit(_ctx(), betRecords, verifiers[PARTIAL_CREDIT], proof, inputs, att, sig);
    }

    // -------------------------------------------------------------------------
    // Consolidate (FC-8: merge up to 4 notes into one)
    // -------------------------------------------------------------------------

    /// @notice Merge up to 4 same-owner notes into a single output note whose balance
    /// is the sum of the inputs, continuing slot 0's lineage. Pure value-preserving
    /// merge: no betRecords, no token movement. The frontend uses this to defragment
    /// notes before a bet/withdrawal that exceeds any single note's balance.
    ///
    /// The circuit guarantees: slot 0 is active; every active slot's note is in the
    /// tree at `merkle_root`; each active slot publishes its real nullifier while
    /// inactive slots publish bytes32(0); the output commitment binds the summed
    /// balance. The Vault marks EVERY non-zero published nullifier spent — it must NOT
    /// de-duplicate, because the same note in two active slots yields two identical
    /// nullifiers and the second markSpent reverting AlreadySpent is the only thing
    /// preventing a double-count of that note's balance.
    function consolidate(
        bytes calldata proof,
        ConsolidatePublicInputs calldata inputs
    ) external nonReentrant whenNotPaused {
        // Body lives in VaultLogic (EIP-170). nonReentrant/whenNotPaused stay here (Vault state).
        VaultLogic.consolidate(tree, nullifiers, verifiers[CONSOLIDATE], proof, inputs);
    }

}
