# CLAUDE.md — Polyshield

Read this file before writing any code in this repository. It is the authoritative source of decisions, constraints, and standards for this codebase.

---

## What Is Polyshield

A ZK-based privacy vault for Polymarket. The vault has one Polymarket signing account (EOA). Multiple users deposit USDC into the vault, then authorize bets via ZK proofs. All bets appear on-chain as coming from the vault's single EOA. No depositor address ever appears in a Polymarket transaction.

**Privacy property being protected:** which depositor authorized which bet.
**NOT being protected:** that a wallet deposited into the vault (deposit is public by design).

Full architecture is in `docs/architecture.md`. ZK circuit specifications are in `docs/zk-design.md`. Before implementing any circuit or contract, read those docs in full.

---

## Repo Structure

```
packages/
  contracts/     Solidity on Polygon (Vault, VaultInputs library, CommitmentMerkleTree, NullifierRegistry, 9× verifiers incl. deposit (FC-2), position_close (FC-1), partial_credit (FC-4), consolidate (FC-8))
  circuits/      Circom/snarkjs circuits in groth16/; Noir .nr spec-only files in subdirs (not compiled)
                 Active: bet_auth, settlement_credit, withdrawal, bet_cancel, cancel_credit, deposit (FC-2), position_close (FC-1), partial_credit (FC-4), consolidate (FC-8)
  backend/       Node.js (signing-layer, proof-relay, indexer, mock-clob-server, mock-env)
  frontend/      Next.js + Wagmi (deposit, bet, settle, withdraw UIs)
  test-fixtures/ Generated test data (markets, users, action sequences)

docs/
  architecture.md              Read before touching contracts or circuits
  zk-design.md                 Read before touching circuits
  open-questions.md            Live tracker of unresolved research questions
  threat-model.md              Read before any security-relevant implementation
  polymarket-api.md            Polymarket CLOB/CTF integration reference
  Q16-proving-backend-comparison.md  UltraPLONK vs Groth16 benchmark data
  collateral-flow-audit.md     pUSD/USDC collateral flow analysis
  codespaces-setup.md          Dev environment setup guide
  future-changes.md            Approved-but-unimplemented changes (FC-1 position close, FC-2 deposit proof, FC-3 root window)

CLAUDE.md              This file
README.md              Project overview and quick start
```

---

## Key Architecture Decisions (Do Not Override Without Project Agent Approval)

- **Hash function:** Poseidon (BN254) everywhere. Do not substitute Keccak256 or Pedersen in circuits.
- **Note structure:** `(secret: Field, balance: u64, nonce: u64, owner_address: Field)`. This is a 4-field note. `owner_address` is the depositing wallet address cast to a BN254 field element (`uint256(uint160(address))`). Do not revert to the old 3-field structure.
- **Commitment formula:** `Poseidon4(secret, balance, nonce, owner_address)`. Uses `bn254::hash_4`. This is a protocol constant — changing it invalidates all existing commitments.
- **Nullifier formula:** `Poseidon2(secret, nonce)`. Does NOT include owner_address or balance.
- **Secret derivation (P1/P2 — random):** Secrets are generated via `crypto.getRandomValues()`. Users must download an ECIES-encrypted backup (encrypted to their wallet public key) immediately after deposit. There is no server-side recovery in P1/P2.
- **Secret derivation (P3+ — wallet-derived):** Secrets are derived deterministically from wallet signatures. Formula: `keccak256(wallet.signMessage("PolyShield deposit derivation\nAddress: {W}\nIndex: {i}\nVersion: 1")) mod p`. The message string is a protocol constant — never change it after mainnet deployment. Users never need to back up a secret in P3+. See `docs/zk-design.md` §3.
- **Merkle tree:** Poseidon-hashed, depth 32, append-only. Rolling **1024-root** history window with O(1) `mapping(bytes32 => bool) knownRoots` membership (FC-3, implemented). `isKnownRoot` is a single mapping read; `insert` maintains the window via a `mapping(uint256 => bytes32) rootRing` keyed by `seq % ROOT_WINDOW`, evicting the oldest root on overflow. `currentRoot` is the single source of truth for the latest root (read it instead of `recentRoots`/`currentRootIndex`, which were removed). The window size is the `internal virtual _rootWindow()` (constant `ROOT_WINDOW = 1024` in production; a test subclass overrides it to exercise eviction). The changing root does NOT serialize transactions to one per block (see T8). Do not shrink the window below the client proving span (≈15–60 Polygon blocks) without Project Agent approval.
- **Deposit binding (MANDATORY, T20):** The deposit commitment MUST be bound to the deposited amount and depositor via a mandatory deposit ZK proof. `deposit` is NOT trivial. The committed `balance` is otherwise unconstrained against the transferred `amount`, allowing a depositor to commit a larger balance than they paid and drain the pool. Add `circuits/deposit`: private `secret`; public `(commitment, amount, owner_address)`; constraint `commitment == Poseidon4(secret, amount, 0, owner_address)`. The Vault passes `owner_address = uint256(uint160(msg.sender))` and `amount` from the on-chain transfer, forcing `balance == amount`, `nonce == 0`, `owner == msg.sender`. No change to the Poseidon4 formula or the four existing circuits. See FC-2. Treat as a blocker for any deposit-handling code.
- **ZK language:** Circom + snarkjs (BN254 / Groth16). Active circuits live in `packages/circuits/groth16/`; the Noir `.nr` files in the other subdirectories are a specification reference only — they are not compiled and not wired into any build step. New Circom circuits are built through the `Benchmarking/groth16/` pipeline (`src/cli/compile.ts`, `setupCircuits.ts`, `generateVerifiers.ts`). Register new circuits in `Benchmarking/groth16/src/constants.ts` (CIRCUIT_IDS) and `src/interfaces.ts` (CircuitId union) before compiling.
- **ZK backend:** Groth16 (snarkjs) for both dev/testnet and mainnet. The frontend generates proofs via `snarkjs.groth16.fullProve()` using WASM artifacts compiled from Circom. On-chain verification uses snarkjs-generated Solidity verifier contracts. UltraHonk and UltraPLONK have been evaluated (see `docs/Q16-proving-backend-comparison.md`) and are not used. Do not introduce UltraPLONK or UltraHonk verifiers anywhere.
- **Chain:** Polygon mainnet (Polymarket runs here). Testnet target: Polygon Amoy.
- **Upgradeability = UUPS (OpenZeppelin, Solidity), all production contracts.** Every deployed contract — `Vault`, `CommitmentMerkleTree`, `NullifierRegistry`, `PoseidonT3Hasher`, and all 8 Groth16 verifier adapters — is a UUPS implementation behind an `ERC1967Proxy`. The proxy addresses are the permanent protocol addresses. Constructors are replaced by `initialize(...)` (`initializer`-guarded); implementations carry `constructor() { _disableInitializers(); }`. `_authorizeUpgrade` is gated by **plain `onlyOwner`, instant (no timelock)** — this is a deliberate decision and a major trust assumption: the owner can replace any contract's logic in a single tx (fund-drain / de-anon vector). The owner role MUST be a multisig/HSM in production. See `docs/threat-model.md` (T-UPGRADE) and `docs/architecture.md`. Mechanics: uses `@openzeppelin-upgradeable` mixins (`Ownable2StepUpgradeable`, `PausableUpgradeable`) + `ReentrancyGuardTransient` (EIP-1153; `evm_version = "cancun"` in `foundry.toml`, supported on Polygon since the Napoli hardfork). Each upgradeable contract reserves a trailing `__gap`; never reorder/insert state — append by shrinking the gap. `CommitmentMerkleTree`'s storage layout (`poseidon, vault, zeros[32], filledSubtrees[32], currentRoot, knownRoots, rootRing, nextIndex, rootCount, __gap`) is frozen. (FC-3 intentionally reset this layout — replacing the old `recentRoots[30], currentRootIndex` block — under the pre-mainnet test-only waiver of the frozen-layout rule, with a fresh redeploy and no migration; treat it as frozen again going forward.) Verifier adapters expose an owner-only `setBase(address)` to adopt a new VK without a full proxy migration (separate lever from the Vault's 48h-timelocked `proposeVerifier`/`acceptVerifier` slot swap). Deploy via the proxy pattern in `script/Deploy.s.sol` / `MockDeploy.s.sol` using `script/DeployLib.sol` (predicts the Vault proxy address to resolve the Vault↔Tree↔Registry init cycle). Do not reintroduce constructors or change `_authorizeUpgrade` gating without Project Agent approval.
- **Collateral token:** Vault accepts and pays out in USDC only. pUSD conversion (via CollateralOnramp/Offramp) is internal to the Vault contract. Do not expose pUSD to users or circuits.
- **Collateral deployment = JIT (Option 3 / FC-7), implemented.** Nothing is deployed to Polymarket at deposit time. The signing layer funds the deposit wallet just-in-time per bet via `Vault.fundPolymarketWallet(shortfall)` right before order submission (`packages/backend/signing-layer/src/jitFunding.ts`); pUSD left after a no-fill is reused as a residual buffer (no sweep-back), so exposure accretes toward a small base buffer. Deposit-wallet actions (redeem/offramp/approvals) run through `DepositWalletExecutor` (`signing-layer/src/depositWalletExecutor.ts`) as relayer WALLET batches — locally against the `MockDepositWallet` proxy (`packages/contracts/src/mocks/MockDepositWallet.sol`) + the mock relayer route (`mock-clob-server/src/routes/relayer.ts`), in production against the Polymarket builder relayer. `Vault.deployedToPolymarket` tracks the deployed amount (decremented by `acknowledgePolymarketReturn` at settlement); SEC-007 `deploymentCap` is the on-chain ceiling. **Option 4 (base buffer + JIT overflow) is the planned successor** (FC-6 buffer policy). See `docs/collateral-deployment-strategy-comparison.md` and FC-7 in `docs/future-changes.md`. Do not pre-deploy at deposit time or remove the residual-buffer reuse without Project Agent approval.
- **Per-address deposit cap:** $50,000 USDC maximum cumulative deposit per address in MVP. Enforced in `deposit()` via `cumulativeDeposits[msg.sender]`. Do not remove without Project Agent approval.
- **Signing Layer trust model:** v1 = centralized operator, v2 = TEE (AWS Nitro). TSS/FROST has been dropped from the roadmap. Do not implement TSS-based signing under any framing.
- **No secrets server-side:** The user's note preimage (secret, balance, nonce, owner_address) must never be sent to any backend. All proof generation is client-side WASM. If you are writing backend code that receives this data, stop and consult the Project Agent. The auto-settlement encrypted permission blob (see below) is the only exception — it contains the secret encrypted to the operator's public key and is handled exclusively by the signing layer.
- **Withdrawal is W-to-W only:** Users can only withdraw to their own depositing address. This is enforced cryptographically inside the withdrawal circuit: `owner_address` is part of the note commitment, and the circuit constrains `Poseidon2(owner_address, 0) == recipient_hash`. The Vault also independently verifies `recipient_hash` against the passed `recipientAddress`. There is no mixer path.
- **Operator-driven settlement:** When a market resolves, the Signing Layer calls `Vault.resolveMarket(market_id, payout_per_share)`. The Vault verifies `payout_per_share` against `ctf.payoutNumerators` and stores it in `pendingCredit[market_id]`. Users' settlement credit proofs do not require `payout_per_share` or `shares_held` as witness inputs — those are injected by the Vault from on-chain storage.
- **Auto-settlement permission:** Users may optionally send an ECIES-encrypted blob `(secret, nonce_after_bet)` to the operator's API at bet authorization time. The blob is stored in the operator's private database keyed by `nullifier_of_bet`. It is never stored on-chain. The operator uses it to generate the settlement proof on the user's behalf when the market resolves. Opting in links W to bet B at the operator level but does not affect future bet privacy.
- **Fee model — IMPLEMENTED (FC-10).** All rates live in one governance-mutable packed struct `Vault.feeConfig` (`struct FeeConfig { uint16 betFeeBps; uint64 relayGasFeeUSDC; uint64 minBet; uint64 withdrawalFeeUSDC; uint64 minWithdrawal; address feeRecipient; }`), set atomically via `setFeeParams(FeeConfig)` (onlyOwner). All fees accumulate in `Vault.feeAccumulator` (USDC in the pool) and are claimed by `feeRecipient` via `withdrawFees(amount)`. Owner-controlled initially; transferable to governance in P4. **Current defaults** (set in `initialize`; testing values): `betFeeBps = 5` (0.05%), `relayGasFeeUSDC = 0`, `minBet = $1` (1e6), `withdrawalFeeUSDC = $0.10` (1e5), `minWithdrawal = $1` (1e6), `feeRecipient = owner`. Three fee types:
  - **Bet authorization fee + relay gas (in BET_AUTH circuit):** the Vault computes `fee = bet_amount * betFeeBps / 10000 + relayGasFeeUSDC` from `feeConfig` and **injects it as a public input** to `bet_auth` (now 10 public signals, see below). The circuit enforces `new_balance = current_balance - bet_amount - fee`. Because the Vault — not the user — supplies `fee`, a forged proof with any other fee produces a `new_commitment` that fails verification (same anti-forgery pattern as the injected `bet_amount` for cancellations). Applies uniformly to every order type (FOK/FAK/GTC/GTD). The gas reimbursement is charged in USDC from the note (privacy-preserving), NOT as a native-POL transfer from the user's wallet (which would re-link wallet↔bet on-chain). `authorizeBet` reverts `BelowMinimum` if `bet_amount < minBet`.
  - **Withdrawal fee (Vault-only, no circuit change):** `withdraw()` skims `withdrawalFeeUSDC` from the payout — the note burns the full `withdrawal_amount`, the recipient receives `withdrawal_amount - withdrawalFeeUSDC`, the fee stays in the pool. Reverts `BelowMinimum` if `withdrawal_amount < minWithdrawal`; `setFeeParams` enforces `minWithdrawal >= withdrawalFeeUSDC`.
  - **Why the bet fee MUST be in the circuit but the withdrawal fee must not:** the hidden note balance is only enforceable inside the circuit (the Vault can't see it), so a per-bet fee on that balance is a circuit term; the withdrawal payout is USDC the Vault controls directly, so its fee is contract-only.

---

## ZK Proofs: Quick Reference

Seven proof types. The **active Circom source** is in `packages/circuits/groth16/`; the `.nr` files in subdirectories are specification-only and are NOT compiled. Build new circuits through `Benchmarking/groth16/` (see `packages/circuits/README.md`). Full specs in `docs/zk-design.md`.

| Proof | Circom source (active) | Verifier slot | Key public inputs |
|---|---|---|---|
| Deposit binding (MANDATORY, T20/FC-2) ✅ | `groth16/deposit.circom` | `DEPOSIT = 5` | `commitment, amount, owner_address`. Binds committed balance + owner to deposited amount and `msg.sender`. NOT trivial |
| Bet Authorization | `groth16/bet_auth.circom` | `BET_AUTH = 0` | `merkle_root, nullifier, new_commitment, bet_amount, price, expected_shares, market_id, outcome_side, position_id, fee` (10 signals; `fee` Vault-injected = `bet_amount*betFeeBps/10000 + relayGasFeeUSDC`; enforces `new_balance = current_balance - bet_amount - fee`) |
| Settlement Credit | `groth16/settlement_credit.circom` | `SETTLEMENT_CREDIT = 1` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, market_id, total_credit` (payout_per_share and shares_held Vault-injected) |
| Bet Cancel Credit | `groth16/bet_cancel.circom` | `BET_CANCEL = 3` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, bet_amount` (bet_amount Vault-injected) |
| N/A Cancel Credit | `groth16/cancel_credit.circom` | `CANCEL_CREDIT = 4` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, market_id, bet_amount` (bet_amount Vault-injected) |
| Withdrawal | `groth16/withdrawal.circom` | `WITHDRAWAL = 2` | `merkle_root, nullifier, withdrawal_amount, recipient_hash, new_commitment` |
| Position Close (FC-1) ✅ | `groth16/position_close.circom` | `POSITION_CLOSE = 6` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, sell_proceeds` (sell_proceeds Vault-injected from `reportSold`). v1 only |
| Partial-Fill Credit (FC-4) ✅ | `groth16/partial_credit.circom` | `PARTIAL_CREDIT = 7` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, refund_amount` (refund_amount = bet_amount − spent_amount; FC-9: Vault-injected from the operator's PARTIAL attestation). Constraint-identical to `bet_cancel`. Advanced GTC/GTD limit-order flow |
| Consolidate (FC-8) ✅ | `groth16/consolidate.circom` | `CONSOLIDATE = 8` | `merkle_root, nullifier[0..3], new_commitment`. Merges up to 4 same-owner notes → 1 (sum of balances, continues slot 0's lineage). Inactive slots: nullifier = 0. No bet, no token movement |

> **FC-9 (gasless operator reporting):** the operator no longer pushes fill status on-chain (`reportFilled`/`reportFOKFailure`/`reportResting`/`reportPartialFill`/`reportSold` are REMOVED). It signs an EIP-712 `OperatorAttestation{nullifierOfBet, reportType(1=FILLED,2=FAILED,3=PARTIAL,4=SOLD), amountA, amountB}` off-chain; the user submits it with their credit proof and the Vault verifies `ECDSA.recover == signingLayerOperator` and injects the attested values. On-chain `BetStatus` is advanced only by `authorizeBet` (→ACTIVE) and the credit functions; the only transition into on-chain `FILLED` is `partialFillCredit`'s normalization. HARD INVARIANT: the operator must sign exactly ONE terminal attestation per bet (single-write store) — the chain cannot adjudicate two contradictory signatures. See `docs/future-changes.md` FC-9 and `docs/threat-model.md`.

**Commitment formula (all circuits):** `Poseidon4(secret, balance, nonce, owner_address)` — uses circomlib `poseidon.circom` template, matching `NoteCommitment()` in `groth16/lib/note.circom`.
**Nullifier formula (all circuits):** `Poseidon2(secret, nonce)`.

> The Noir `.nr` files in `circuits/bet_auth/`, `circuits/settlement_credit/`, etc. are **not compiled, not used for proof generation, and not wired into any build step**. They are kept as a human-readable specification reference only.

---

## Smart Contracts

All contracts live in `packages/contracts/`. Use Foundry for development, testing, and deployment.

**EIP-170 / `VaultInputs.sol`:** the Vault is near the 24576-byte runtime limit (~300 B headroom). The 8 public-input structs (`BetAuthPublicInputs`, …) are defined at **file scope in `src/VaultInputs.sol`** (no longer nested in the Vault — reference them as bare `BetAuthPublicInputs`, not `Vault.BetAuthPublicInputs`), and each circuit's public-signal assembly **and** the `IVerifier.verify` dispatch live in the external `library VaultInputs` (one `verify<Proof>(verifier, proof, inputs, injected)` per proof type), which the Vault DELEGATECALL-links. This is purely a size optimization — the functions are `pure`/`view` and behave identically to the former in-contract `_…PublicInputs` helpers. Foundry auto-deploys + links the library in tests and `forge script`. When adding a proof type or changing public inputs, edit `VaultInputs` (not the Vault). Before adding Vault bytecode, run `forge build --sizes` and, if tight, move more logic into `VaultInputs`.

**Contract checklist for `Vault.sol`:**
- `deposit(proof, commitment, amount)`: verifies the MANDATORY deposit binding proof with public inputs `(commitment, amount, uint256(uint160(msg.sender)))` so the committed balance and owner are bound to the deposited amount and `msg.sender` (T20/FC-2); records commitment leaf, accepts USDC via `transferFrom`, increments `cumulativeDeposits[msg.sender]`. Do NOT ship the proofless `deposit(commitment, amount)`; it is the T20 vulnerability
- `authorizeBet(proof, BetAuthPublicInputs)` — verifies Bet Auth proof, nullifies old note, inserts new commitment, writes `betRecords[nullifier]`
- `resolveMarket(market_id, payout_per_share)` — operator-only; verifies `payout_per_share` against `ctf.payoutNumerators`, stores in `pendingCredit[market_id]`
- `creditSettlement(proof, SettlementPublicInputs)` — verifies Settlement Credit proof; Vault injects `payout_per_share` from `pendingCredit[market_id]` and `shares_held` from `betRecords[nullifier_of_bet]`; user does NOT supply these values
- `betCancellationCredit(proof, BetCancelPublicInputs)` — verifies Bet Cancel proof for FOK-failed bets; Vault injects `bet_amount` from `betRecords`
- `naCancellationCredit(proof, NACancelPublicInputs)` — verifies N/A Cancel proof; Vault checks `ctf.payoutNumerators` are all zero; Vault injects `bet_amount`
- `withdraw(proof, WithdrawalPublicInputs, recipientAddress)` — verifies Withdrawal proof, verifies `Poseidon2(recipientAddress, 0) == recipient_hash`, transfers USDC; reverts if recipient does not match the commitment's `owner_address`
- `reportFilled(nullifier_of_bet)` — operator-only; sets `betRecords.status = FILLED`
- `reportFOKFailure(nullifier_of_bet)` — operator-only; sets `betRecords.status = FAILED`
- `reportSold(nullifier_of_bet, sold_shares, proceeds)`: operator-only; records operator-reported sale proceeds for a position close (Q24/FC-1; v1 only, not yet built)
- `closePosition(proof, ClosePublicInputs)`: verifies the Position Close proof; Vault injects operator-reported `sell_proceeds`; credits the note and sets status `CLOSED_CREDITED` (full sell) or returns to `FILLED` with reduced `expected_shares` (partial sell). v1 only; see FC-1
- `reportResting(nullifier_of_bet)`: operator-only; marks a live GTC/GTD limit order `RESTING` (only from `ACTIVE`). RESTING is intentionally exempt from `adminCancelBet`. FC-4
- `reportPartialFill(nullifier_of_bet, filled_shares, spent_amount)`: operator-only; records a partial limit-order fill that then terminated (from `ACTIVE`/`RESTING`), sets status `PARTIAL_FILLED`. FC-4
- `partialFillCredit(proof, PartialFillPublicInputs)`: verifies the Partial-Fill Credit proof; Vault injects `refund_amount = bet_amount − spent_amount`; refunds the unfilled remainder and normalizes the record to a clean `FILLED` (`expected_shares := filled_shares`, `bet_amount := spent_amount`). FC-4

**New state in `Vault.sol`:**
- `mapping(bytes32 => uint64) public pendingCredit` — `market_id => payout_per_share`, written by `resolveMarket`
- `event MarketResolved(bytes32 indexed market_id, uint64 payout_per_share)`

**Required security properties:**
- Nullifier registry check must happen before any state change (checks-effects-interactions)
- Merkle root window: accept last 30 roots, not just the current one
- No raw `call` with user-controlled calldata
- Reentrancy guard on all state-modifying functions (`ReentrancyGuardTransient`, EIP-1153)
- UUPS: `_authorizeUpgrade` is `onlyOwner`; implementations disable initializers in the constructor; storage is append-only behind a `__gap` (never reorder existing state across an upgrade)

---

## Backend (Signing Layer v1)

Lives in `packages/backend/`. This is a centralized Node.js service for the v1 prototype.

**Responsibilities:**
- Receive ZK Bet Authorization proofs from users (via the proof relay)
- Forward to the Vault contract for on-chain verification
- Once on-chain proof is confirmed, read the bet parameters from the contract event
- Sign the Polymarket EIP-712 order using the vault's Polymarket EOA key
- Submit the signed order to Polymarket's CLOB API

**Critical constraints:**
- The EOA private key must be in environment variables only. Never hardcoded. Never logged.
- The signing service must not initiate signing before the on-chain proof is finalized (minimum 1 block confirmation on Polygon).
- Implement a dead-man circuit breaker: if the Polymarket account receives a ban signal (API 403 or account flagged), halt all signing and alert.

**Polymarket Indexer sub-service:**
- Poll Polymarket CTF settlement contract for resolved markets involving the vault's EOA
- Store settlement records (market_id, outcome, payout_per_share, block_number)
- Expose a REST endpoint: `GET /settlement/:market_id` for the frontend WASM prover to fetch witness data

---

## Frontend

Lives in `packages/frontend/`. Next.js app with Wagmi for wallet connection.

**Note management (critical UX):**
- **P1/P2 (random secrets):** Call `generateSecret()` which uses `crypto.getRandomValues()`. Immediately after note creation, prompt the user to download their ECIES-encrypted backup file (encrypted to their wallet public key). Note loss is permanent in P1/P2 — there is no server-side recovery. Show a prominent warning if the user skips the backup step.
- **P3+ (wallet-derived secrets):** Call `deriveSecret(wallet, depositIndex)` which signs the canonical EIP-191 message and reduces mod p. Do NOT ask the user to back anything up — their wallet is their backup. Never use `crypto.getRandomValues()` for note secrets in P3+.
- localStorage stores the note cache for performance only: `(kind, balance, nonce, commitment, nullifier, spent, owner_address, createdAt, txHash, marketId, expectedShares)`. The secret is NOT persisted to localStorage.
- **P1/P2 recovery:** User must import their encrypted backup file and decrypt it with their wallet.
- **P3+ recovery:** Call `recoverNotes(wallet)` which scans `Deposited(W, ...)` events, re-derives secrets by index, matches commitments, and replays state transitions from on-chain events.
- The deposit index counter `(wallet_address → count)` is stored in localStorage. In P3+, it is recoverable by scanning chain events if lost.

**Proof generation:**
- WASM prover runs client-side via the `@noir-lang/noir_wasm` package
- Proof generation takes 30 seconds to 2 minutes. Show a clear progress indicator. Do not let the user navigate away.
- If proof generation fails (timeout or insufficient compute), surface a clear error with a "try on a more powerful device" message

**Never:**
- Send any proof witness data (secret, balance, nonce) to any API endpoint
- Attempt to generate proofs on the server side
- Call `Vault.authorizeBet()`, `Vault.creditSettlement()`, or any state-mutating Vault function directly from the user's connected wallet. These functions must ONLY be called by the Proof Relay. The ONLY on-chain transaction the user's wallet ever initiates is `Vault.deposit()`. Calling authorizeBet from the user's wallet directly links the depositor's address to the bet on-chain and breaks the core privacy invariant. This is threat T19 in `docs/threat-model.md`.

---

## Testing Standards

- Smart contracts: Foundry tests in `packages/contracts/test/`. Minimum coverage: all state transitions (deposit, bet auth, settlement credit, withdrawal), all nullifier double-spend attempts, all invalid proof rejections, Merkle root window edge cases.
- Circuits: The authoritative circuit tests are `packages/contracts/test/RealVerifier.t.sol` (end-to-end on-chain verification of generated Groth16 proofs) and the roundtrip in `Benchmarking/groth16/src/cli/generateTestProofs.ts`. The Noir `.nr` spec files have test helpers, but those test the spec document, not the production circuit.
- Backend: Jest unit tests for the signing service. Mock the Polymarket API. Test the circuit breaker logic.
- Never test with a real Polymarket EOA or real USDC on mainnet.

---

## What Requires Project Agent Sign-Off

Do not implement these without explicit direction from the Project Agent:

- Any change to the note structure `(secret, balance, nonce, owner_address)` or the Poseidon4 commitment formula
- Any change to the nullifier formula
- Any change to the EIP-191 secret derivation message string or version number
- Any change to the public inputs of any ZK circuit
- Signing Layer v2 (TEE) implementation
- The ECIES encryption scheme for auto-settlement permissions
- The multi-EOA rotation scheme for vault EOA ban recovery
- The protocol fee mechanism
- Any mechanism that involves the backend receiving user secrets in plaintext (the encrypted permission blob is the only sanctioned exception)

---

## Commands

```bash
# Install all dependencies (from repo root)
pnpm install

# ── Local dev stack (primary way to run everything) ──────────────────────────
# Start Anvil + deploy all contracts + start all backend services (one terminal):
pnpm dev:mock

# Start Next.js frontend (separate terminal):
pnpm dev:frontend

# Or start both together:
pnpm dev:all

# ── Contracts ────────────────────────────────────────────────────────────────
cd packages/contracts
forge build
forge test
forge test --gas-report

# ── Circuits (Groth16 / snarkjs — authoritative) ─────────────────────────────
# Build all circuits (compile → trusted setup → generate verifiers):
cd Benchmarking/groth16
pnpm compile:circuits       # circom → r1cs + wasm (artifacts/)
pnpm setup:circuits         # snarkjs groth16 setup → zkeys (setup/)
pnpm generate:verifiers     # snarkjs → *Verifier.sol (contracts/generated/)
# Copy artifacts to frontend:
#   artifacts/<name>/<name>_js/<name>.wasm → packages/frontend/public/circuits/
#   setup/<name>.zkey                      → packages/frontend/public/zkeys/
#   contracts/generated/*Verifier.sol      → packages/contracts/src/verifiers/

# Noir spec-reference only (not the live build — see packages/circuits/README.md):
# cd packages/circuits && nargo check   (validates Noir spec files for consistency)

# ── Backend ──────────────────────────────────────────────────────────────────
cd packages/backend
pnpm dev

# ── Frontend ─────────────────────────────────────────────────────────────────
cd packages/frontend
pnpm dev

# ── SDK (build WASM prover) ───────────────────────────────────────────────────
cd packages/sdk
pnpm build:wasm
```

---

## Local Dev Stack

`pnpm dev:mock` starts the full local environment in one command:

| Service | Port | Notes |
|---|---|---|
| Anvil RPC | 8545 | Chain ID 31337; reset on every `dev:mock` restart |
| Mock CLOB API | 3001 | Fake Polymarket; `POST /admin/settle-market` triggers settlement |
| Proof Relay | 3002 | Real relay; proxies proofs to Vault on Anvil |
| Indexer API | 3003 | Real indexer; listens for ConditionResolution events |
| Signing Layer | — | Real event listener; submits FOK orders to mock CLOB |
| Frontend | 3000 | `pnpm dev:frontend` (separate terminal) |

**Deployed test addresses (refreshed on every restart):**
- `ALICE`: `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` — $100k USDC (Anvil account 4)
- `BOB`: `0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc` — $10k USDC (Anvil account 5)
- `USER_1`: `0x2d209040c031d4e2D4d9cb4D3aabf18F52260AB0` — 2 ETH + $100k USDC
- `USER_2`: `0x7D0A7d3a4508B33C6A0e9F3FCBc72562cC120e89` — 2 ETH + $100k USDC
- `USER_3`: `0x46458d7CE6157AE78BFF94D2096308f352c7edc8` — 2 ETH + $100k USDC

**Logging:** All services write structured JSON (pino) to stdout, tee'd to `logs/session-<timestamp>.jsonl`. Frontend events go to `logs/frontend.jsonl`. Run `tail -f logs/*.jsonl | jq .` to watch everything live.

**Real vs mock components:**
- Real: Vault, CommitmentMerkleTree, NullifierRegistry, all 5 Groth16 verifiers, PoseidonT3Hasher (BN254), Proof Relay, Indexer, Signing Layer, MockUSDC, MockCTF
- Mock (intentional): mockClobServer only — mimics the Polymarket CLOB API

**Known limitation:** Frontend proof generation uses snarkjs Groth16 via WASM (`.wasm`) and proving key (`.zkey`) files served from `/circuits/` and `/zkeys/`. If these files are absent, proof generation fails. Run `pnpm setup:circuits` to regenerate them.

---

## Open Questions Affecting Implementation

Before starting a task, check `docs/open-questions.md`. If your task touches Q4 (CLOB proof), Q5 (concurrent open positions), Q7 (partial fills), or Q8 (N/A resolutions), stop and get direction from the Project Agent first. These questions are not resolved and implementing anything that assumes an answer will likely require a rewrite.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

---

## Pending Implementation Tasks

These tasks were produced by a full audit of `packages/contracts/src/Vault.sol` and all circuits in `packages/circuits/`. Execute them in the order listed. After completing all contract changes, run `forge build && forge test` and confirm zero failures. After adding a new Groth16 circuit, rebuild through `Benchmarking/groth16` and run `forge test --match-contract RealVerifierTest` to confirm the generated verifier accepts a real proof.

---

### TASK-C1 + TASK-C2 — `naCancellationCredit`: add status guard and denominator check

**File:** `packages/contracts/src/Vault.sol`

**Why C1:** After a successful `naCancellationCredit` call the bet record status is set to `CANCELLED_CREDITED`, but the function has no guard against a second call. A user can immediately call again with their fresh note (new nonce, new nullifier) against the same `nullifier_of_bet`. The bet-record checks pass every time and `bet_amount` is credited again indefinitely. This is a double-credit exploit.

**Why C2:** The function verifies N/A by reading `ctf.payoutNumerators` and asserting all are zero. An unresolved market (condition not yet reported to CTF) also returns all-zero numerators with a zero denominator. Without a denominator check, any user can call `naCancellationCredit` on an active market and reclaim their `bet_amount` before the market settles. Compare: `resolveMarket` already guards with `if (denominator == 0) revert ConditionNotResolved()`.

**Changes required:**

1. Add a new error to the errors block:
   ```solidity
   error BetNotCancellable();
   ```

2. In `naCancellationCredit`, immediately after the `WrongMarket` check, insert the C1 status guard:
   ```solidity
   // C1: prevent double-credit — only ACTIVE and FILLED bets can be N/A-credited
   if (rec.status != BetStatus.ACTIVE && rec.status != BetStatus.FILLED) revert BetNotCancellable();
   ```

3. In `naCancellationCredit`, immediately after the `WrongMarket` check (before reading `payoutNumerators`), insert the C2 denominator check:
   ```solidity
   // C2: confirm the condition has actually resolved (denominator > 0) before checking N/A
   uint256 denominator = ctf.payoutDenominator(inputs.market_id);
   if (denominator == 0) revert ConditionNotResolved();
   ```

   The `ConditionNotResolved` error already exists in the errors block — do not add a duplicate.

After these changes the function body (checks section only) must read in this order:
```
nullifier spent? → unknown root? → bet found? → wrong market? →
bet status valid (C1)? → condition resolved (C2)? → all numerators zero?
→ [proof verification] → [effects]
```

---

### TASK-M2 — Fix zero leaf in Noir spec-reference files (low priority — NOT the live build)

**Note:** The `.nr` files listed below are **specification reference only** and are not compiled or used for proof generation. The authoritative Circom circuits in `packages/circuits/groth16/` use `bytes32(0)` (Field `0`) as the zero leaf, matching `CommitmentMerkleTree.sol`. Fixing the Noir spec files is useful for documentation consistency but does not affect any running code. Execute only if maintaining the Noir specs as an accurate spec document matters.

**Files (spec-only, not compiled):**
- `packages/circuits/bet_auth/src/test.nr`
- `packages/circuits/withdrawal/src/test.nr`
- `packages/circuits/settlement_credit/src/test.nr`
- `packages/circuits/bet_cancel/src/test.nr`
- `packages/circuits/cancel_credit/src/test.nr`

In each file, replace the zero-leaf initializer:
```noir
// BEFORE
let mut h = bn254::hash_3([0, 0, 0]);
// AFTER — matches CommitmentMerkleTree.sol: bytes32(0) zero leaf
let mut h: Field = 0;
```
Do NOT run `nargo test` expecting these tests to validate the production system — they validate the Noir spec document only.

---

### TASK-M3 — Fix CEI violation in `withdraw()`: move `tree.insert` before `usdc.safeTransfer`

**File:** `packages/contracts/src/Vault.sol`

**Why:** In `withdraw()`, `usdc.safeTransfer` (an external call / interaction) is called before `tree.insert` (a state change / effect). Checks-effects-interactions requires all state changes to precede external calls. While `ReentrancyGuard` prevents exploitation with the current USDC token, this ordering is structurally unsafe with any ERC-20 that has transfer hooks, and it violates the security property stated in `## Required security properties` above ("Nullifier registry check must happen before any state change"). All effects must precede interactions.

**Change required:**

Find the effects/interaction block in `withdraw()`. It currently reads:
```solidity
nullifiers.markSpent(inputs.nullifier);
usdc.safeTransfer(recipientAddress, uint256(inputs.withdrawal_amount));
if (inputs.new_commitment != bytes32(0)) {
    tree.insert(inputs.new_commitment);
}
```

Reorder to:
```solidity
nullifiers.markSpent(inputs.nullifier);
if (inputs.new_commitment != bytes32(0)) {
    tree.insert(inputs.new_commitment);
}
usdc.safeTransfer(recipientAddress, uint256(inputs.withdrawal_amount));
```

No logic changes, only ordering. The USDC transfer is always the last operation in the function body.

---

### TASK-M4 — Change `BetRecord.bet_amount` from `uint256` to `uint64`

**File:** `packages/contracts/src/Vault.sol`

**Why:** The `bet_amount` field in `BetRecord` is `uint256`, but the circuit's corresponding public input is `pub u64`. In `_betCancelPublicInputs` and `_naCancelPublicInputs`, the uint256 value is cast directly to `bytes32` and handed to the verifier as a circuit public input. If `bet_amount` ever exceeds `type(uint64).max`, the verifier would receive a field element that the u64-declared circuit would reject, silently breaking cancellation proofs. The type should match the circuit. `bet_amount` is always sourced from `BetAuthPublicInputs.bet_amount` which is already `uint64`, so the conversion path is clean.

**Changes required:**

1. In `BetRecord`, change the field type:
   ```solidity
   // BEFORE
   uint256 bet_amount;
   // AFTER
   uint64 bet_amount;
   ```

2. In `authorizeBet`, update the struct literal (no cast needed now):
   ```solidity
   // BEFORE
   bet_amount: uint256(inputs.bet_amount),
   // AFTER
   bet_amount: inputs.bet_amount,
   ```

3. In `_betCancelPublicInputs`, add an explicit double cast for the bytes32 conversion:
   ```solidity
   // BEFORE
   p[4] = bytes32(bet_amount); // Vault-injected
   // AFTER
   p[4] = bytes32(uint256(bet_amount)); // Vault-injected; uint64 → uint256 → bytes32
   ```

4. In `_naCancelPublicInputs`, apply the same fix:
   ```solidity
   // BEFORE
   p[5] = bytes32(bet_amount); // Vault-injected
   // AFTER
   p[5] = bytes32(uint256(bet_amount)); // Vault-injected; uint64 → uint256 → bytes32
   ```

5. In `creditSettlement`, `rec.bet_amount` is now `uint64`. The arithmetic `uint256(shares_held) * uint256(payout_per_share) == uint256(inputs.total_credit)` does not reference `bet_amount` and needs no change.

6. The `BetAuthorized` event parameter `uint256 bet_amount` may remain `uint256` for external indexer compatibility. The emit site must add the cast back:
   ```solidity
   // BEFORE
   uint256(inputs.bet_amount),
   // AFTER (unchanged — inputs.bet_amount is uint64, cast to uint256 for the event)
   uint256(inputs.bet_amount),
   ```
   This line is already correct; confirm it remains unchanged.

---

### TASK-L1 — Fix `deposit()` natspec comment

**File:** `packages/contracts/src/Vault.sol`

**Why:** The NatSpec above `deposit()` says "the Poseidon hash of (secret, initial_balance, 0)" — a 3-field hash that describes the old, deprecated note structure. The correct commitment is `Poseidon4(secret, balance, nonce, owner_address)`, a 4-field hash.

**Change required:**

```solidity
// BEFORE
/// The commitment must be the Poseidon hash of (secret, initial_balance, 0)
/// computed client-side. The vault does not verify the preimage on-chain.

// AFTER
/// The commitment must equal Poseidon4(secret, initial_balance, 0, owner_address)
/// computed client-side (see docs/zk-design.md §2). The vault does not verify
/// the preimage on-chain; the depositor is bound by the commitment they submit.
```

---

### TASK-L3 — Add `adminCancelBet()` to Vault.sol

**File:** `packages/contracts/src/Vault.sol`

**Why:** Per the Q14 design direction in `docs/open-questions.md`, the Vault owner needs an emergency escape hatch to force-cancel in-flight bets when the Signing Layer's EOA is banned and cannot call `reportFilled` or `reportFOKFailure`. Without this, bets whose orders were never submitted to Polymarket (or whose orders were submitted but the EOA was banned before the CLOB response) are permanently stuck in `ACTIVE` status and users cannot reclaim their funds. The function sets the bet to `FAILED` so the user can call the existing `betCancellationCredit` flow normally. A timelock prevents the owner from cancelling bets opportunistically before the signing layer has had a reasonable chance to respond.

**New state to add** (in the State section, after `marketResolvedAt`):
```solidity
mapping(bytes32 => uint64) public betCreatedAt;   // nullifier_of_bet => block.timestamp at authorizeBet
uint256 public adminCancelTimelock = 86_400;       // seconds; default 24 hours; governance-mutable
```

**New errors to add** (in the errors block):
```solidity
error BetNotActive();
error BetTimeoutNotElapsed();
```

**New event to add** (in the events block):
```solidity
event AdminBetCancelled(bytes32 indexed nullifier_of_bet);
```

**Modification to `authorizeBet`** — record the timestamp when the bet is written to storage, immediately after the `betRecords` assignment:
```solidity
betCreatedAt[inputs.nullifier] = uint64(block.timestamp);
```

**New admin setter** (add alongside `setSigningLayerOperator` in the Admin section):
```solidity
/// @notice Update the timelock duration for adminCancelBet. Owner-controlled.
function setAdminCancelTimelock(uint256 _seconds) external onlyOwner {
    adminCancelTimelock = _seconds;
}
```

**New function** (add after `reportFOKFailure`, still in the operator section but gated by `onlyOwner`):
```solidity
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
```

**Test coverage required** (add to `packages/contracts/test/`):
- `test_adminCancelBet_happyPath`: create an ACTIVE bet, warp time past the timelock, call `adminCancelBet`, assert status == FAILED and event emitted.
- `test_adminCancelBet_revertBeforeTimelock`: create an ACTIVE bet, warp time to just under the timelock, assert `BetTimeoutNotElapsed` revert.
- `test_adminCancelBet_revertNotActive`: create a FILLED bet (call `reportFilled` first), assert `BetNotActive` revert.
- `test_adminCancelBet_revertNotOwner`: call from a non-owner address, assert OwnableUnauthorizedAccount revert.

---

### TASK-C3 — DONE. `SettlementCreditVerifier.sol` already has 6 public inputs.

The previously documented `bb write_vk`/`bb contract` commands were wrong (the project uses snarkjs Groth16, not barretenberg). The active `SettlementCreditVerifier.sol` in `packages/contracts/src/verifiers/` is a snarkjs-generated adapter with 6 IC constants (6 public inputs), matching `settlement_credit.circom`. If regeneration is ever needed, use the `Benchmarking/groth16` pipeline:
```bash
cd Benchmarking/groth16
pnpm compile:circuits && pnpm setup:circuits && pnpm generate:verifiers
```
Then copy `contracts/generated/SettlementCreditVerifier.sol` → `packages/contracts/src/verifiers/SettlementCreditVerifier.sol`.

---

### NOTE ON `BetRecord.condition_id` — do NOT remove or collapse (L2 clarification)

The `BetRecord` struct has two seemingly duplicate fields:
```solidity
bytes32 market_id;    // CLOB market identifier
bytes32 condition_id; // CTF conditionId
```

These are **not** redundant. They are semantically distinct and currently set to the same value only as a placeholder. Do not remove `condition_id` or collapse it into `market_id`.

**Distinction:**
- `market_id` — the Polymarket CLOB market identifier. Used by the Signing Layer to route orders and by `resolveMarket` as the `pendingCredit` key.
- `condition_id` — the CTF smart contract `conditionId` (a `bytes32` derived from the oracle address, question ID, and outcome slot count). Used by `ctf.payoutNumerators(conditionId)` during settlement verification. In the current Polymarket architecture (post-CLOB v2), `conditionId` is derivable from `positionId` but is a different value.

**Current placeholder state:** Both fields are set to `inputs.market_id` in `authorizeBet`. This is a known shortcoming tracked as backlog item B2 in `docs/ui-ux-improvements.md`. The correct value for `condition_id` must be derived from `position_id` via the CTF contract (`ctf.getConditionId(...)`) or passed as an additional public input in `BetAuthPublicInputs`. **Do not implement this derivation here** — it touches `BetAuthPublicInputs` (a ZK circuit interface) and requires Project Agent sign-off before any change.

**For Q5 Option B:** The `condition_id` field is also load-bearing for the parallel note model (see `docs/ui-ux-improvements.md` A14 and `docs/open-questions.md` Q5). Under Option B, when a market resolves, the Vault must match `BET_RECEIPT` notes to the resolved condition via `condition_id`, which may differ from the CLOB's `market_id` string. Keeping the fields separate now avoids a struct migration later.

**Action:** Leave `condition_id` as-is. Do not touch it in this task set.
