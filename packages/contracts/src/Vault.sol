// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
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
contract Vault is ReentrancyGuard, Ownable {
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
        bytes32 market_id;
        bytes32 position_id;
        uint64 expected_shares;
        uint256 bet_amount;
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
        uint64 payout_per_share;
        // shares_held is NOT here — it is injected from betRecords[nullifier_of_bet]
        uint64 total_credit;
    }

    struct WithdrawalPublicInputs {
        bytes32 merkle_root;
        bytes32 nullifier;
        uint64 withdrawal_amount;
        bytes32 recipient_hash;
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
    mapping(bytes32 => BetRecord) public betRecords;
    mapping(address => uint256) public cumulativeDeposits;

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

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------
    event Deposited(address indexed depositor, bytes32 commitment, uint256 amount);
    event BetAuthorized(
        bytes32 indexed nullifier,
        bytes32 market_id,
        bytes32 position_id,
        uint64 expected_shares,
        uint256 bet_amount,
        uint64 price,
        bytes32 new_commitment
    );
    event BetFilled(bytes32 indexed nullifier_of_bet);
    event FOKFailed(bytes32 indexed nullifier_of_bet);
    event SettlementCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment);
    event Withdrawn(bytes32 indexed nullifier, address recipient, uint256 amount);
    event BetCancellationCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment);
    event NACancellationCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment);

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
    function setVerifier(uint8 proofType, address verifier) external onlyOwner {
        verifiers[proofType] = verifier;
    }

    function setSigningLayerOperator(address operator) external onlyOwner {
        signingLayerOperator = operator;
    }

    // -------------------------------------------------------------------------
    // Deposit
    // -------------------------------------------------------------------------

    /// @notice Deposit USDC and insert a commitment leaf.
    /// The commitment must be the Poseidon hash of (secret, initial_balance, 0)
    /// computed client-side. The vault does not verify the preimage on-chain.
    function deposit(bytes32 commitment, uint256 amount) external nonReentrant {
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
    ) external nonReentrant {
        // Nullifier check FIRST (checks-effects-interactions)
        if (nullifiers.isSpent(inputs.nullifier)) revert NullifierSpent();
        if (!tree.isKnownRoot(inputs.merkle_root)) revert UnknownRoot();
        if (!IVerifier(verifiers[BET_AUTH]).verify(proof, _betAuthPublicInputs(inputs))) revert InvalidProof();

        nullifiers.markSpent(inputs.nullifier);
        tree.insert(inputs.new_commitment);

        betRecords[inputs.nullifier] = BetRecord({
            market_id: inputs.market_id,
            position_id: inputs.position_id,
            expected_shares: inputs.expected_shares,
            bet_amount: uint256(inputs.bet_amount),
            status: BetStatus.ACTIVE
        });

        emit BetAuthorized(
            inputs.nullifier,
            inputs.market_id,
            inputs.position_id,
            inputs.expected_shares,
            uint256(inputs.bet_amount),
            inputs.price,
            inputs.new_commitment
        );
    }

    // -------------------------------------------------------------------------
    // Operator: FOK status reporting
    // -------------------------------------------------------------------------

    /// @notice Called by the Signing Layer when a FOK order is confirmed filled.
    function reportFilled(bytes32 nullifier_of_bet) external {
        if (msg.sender != signingLayerOperator) revert OnlyOperator();
        BetRecord storage rec = betRecords[nullifier_of_bet];
        if (rec.market_id == bytes32(0)) revert BetNotFound();
        rec.status = BetStatus.FILLED;
        emit BetFilled(nullifier_of_bet);
    }

    /// @notice Called by the Signing Layer when a FOK order was not filled.
    function reportFOKFailure(bytes32 nullifier_of_bet) external {
        if (msg.sender != signingLayerOperator) revert OnlyOperator();
        BetRecord storage rec = betRecords[nullifier_of_bet];
        if (rec.market_id == bytes32(0)) revert BetNotFound();
        rec.status = BetStatus.FAILED;
        emit FOKFailed(nullifier_of_bet);
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
    ) external nonReentrant {
        if (nullifiers.isSpent(inputs.nullifier)) revert NullifierSpent();
        if (!tree.isKnownRoot(inputs.merkle_root)) revert UnknownRoot();

        BetRecord storage rec = betRecords[inputs.nullifier_of_bet];
        if (rec.market_id == bytes32(0)) revert BetNotFound();
        if (rec.market_id != inputs.market_id) revert WrongMarket();
        if (rec.status != BetStatus.FILLED) revert BetNotFilled();

        // Inject shares_held from storage — user cannot supply a different value
        bytes32[] memory pubInputs = _settlementPublicInputs(inputs, rec.expected_shares);
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
    ) external nonReentrant {
        if (nullifiers.isSpent(inputs.nullifier)) revert NullifierSpent();
        if (!tree.isKnownRoot(inputs.merkle_root)) revert UnknownRoot();
        if (!IVerifier(verifiers[WITHDRAWAL]).verify(proof, _withdrawalPublicInputs(inputs))) revert InvalidProof();

        // Verify recipientAddress matches the commitment in the proof
        bytes32 computedHash = tree.hashTwo(bytes32(uint256(uint160(recipientAddress))), bytes32(0));
        if (computedHash != inputs.recipient_hash) revert BadRecipient();

        nullifiers.markSpent(inputs.nullifier);
        usdc.safeTransfer(recipientAddress, uint256(inputs.withdrawal_amount));

        emit Withdrawn(inputs.nullifier, recipientAddress, uint256(inputs.withdrawal_amount));
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
    ) external nonReentrant {
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
    ) external nonReentrant {
        if (nullifiers.isSpent(inputs.nullifier)) revert NullifierSpent();
        if (!tree.isKnownRoot(inputs.merkle_root)) revert UnknownRoot();

        BetRecord storage rec = betRecords[inputs.nullifier_of_bet];
        if (rec.market_id == bytes32(0)) revert BetNotFound();
        if (rec.market_id != inputs.market_id) revert WrongMarket();

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

    function _settlementPublicInputs(SettlementPublicInputs calldata i, uint64 shares_held)
        internal
        pure
        returns (bytes32[] memory)
    {
        bytes32[] memory p = new bytes32[](8);
        p[0] = i.merkle_root;
        p[1] = i.nullifier;
        p[2] = i.new_commitment;
        p[3] = i.nullifier_of_bet;
        p[4] = i.market_id;
        p[5] = bytes32(uint256(i.payout_per_share));
        p[6] = bytes32(uint256(shares_held)); // Vault-injected
        p[7] = bytes32(uint256(i.total_credit));
        return p;
    }

    function _withdrawalPublicInputs(WithdrawalPublicInputs calldata i) internal pure returns (bytes32[] memory) {
        bytes32[] memory p = new bytes32[](4);
        p[0] = i.merkle_root;
        p[1] = i.nullifier;
        p[2] = bytes32(uint256(i.withdrawal_amount));
        p[3] = i.recipient_hash;
        return p;
    }

    function _betCancelPublicInputs(BetCancelPublicInputs calldata i, uint256 bet_amount)
        internal
        pure
        returns (bytes32[] memory)
    {
        bytes32[] memory p = new bytes32[](5);
        p[0] = i.merkle_root;
        p[1] = i.nullifier;
        p[2] = i.new_commitment;
        p[3] = i.nullifier_of_bet;
        p[4] = bytes32(bet_amount); // Vault-injected
        return p;
    }

    function _naCancelPublicInputs(NACancelPublicInputs calldata i, uint256 bet_amount)
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
        p[5] = bytes32(bet_amount); // Vault-injected
        return p;
    }
}
