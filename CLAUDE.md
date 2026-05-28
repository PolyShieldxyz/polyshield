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
  contracts/     Solidity on Polygon (Vault, CommitmentMerkleTree, NullifierRegistry, 5× verifiers)
  circuits/      Noir circuits (bet_auth, settlement_credit, withdrawal, bet_cancel, cancel_credit)
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

CLAUDE.md              This file
README.md              Project overview and quick start
```

---

## Key Architecture Decisions (Do Not Override Without Project Agent Approval)

- **Hash function:** Poseidon (BN254) everywhere. Do not substitute Keccak256 or Pedersen in circuits.
- **Note structure:** `(secret: Field, balance: u64, nonce: u64, owner_address: Field)`. This is a 4-field note. `owner_address` is the depositing wallet address cast to a BN254 field element (`uint256(uint160(address))`). Do not revert to the old 3-field structure.
- **Commitment formula:** `Poseidon4(secret, balance, nonce, owner_address)`. Uses `bn254::hash_4`. This is a protocol constant — changing it invalidates all existing commitments.
- **Nullifier formula:** `Poseidon2(secret, nonce)`. Does NOT include owner_address or balance.
- **Secret derivation:** Secrets are derived from wallet signatures, never randomly generated. Formula: `keccak256(wallet.signMessage("PolyShield deposit derivation\nAddress: {W}\nIndex: {i}\nVersion: 1")) mod p`. The message string is a protocol constant — never change it after mainnet deployment. Users never need to back up a secret. See `docs/zk-design.md` §3.
- **Merkle tree:** Poseidon-hashed, depth 32, append-only. Rolling 30-root history window.
- **ZK language:** Noir (Aztec). Do not implement circuits in Circom or use another system without explicit approval.
- **ZK backend:** UltraPLONK for dev/testing. Mainnet proving backend is **under active evaluation** — UltraPLONK and Groth16 are both on the table. UltraHonk remains dropped. Do not treat the mainnet backend as decided; see Q16 in `docs/open-questions.md`. The benchmarking data comparing both backends is in `docs/Q16-proving-backend-comparison.md`. Do not introduce UltraHonk verifiers anywhere.
- **Chain:** Polygon mainnet (Polymarket runs here). Testnet target: Polygon Amoy.
- **Collateral token:** Vault accepts and pays out in USDC only. pUSD conversion (via CollateralOnramp/Offramp) is internal to the Vault contract. Do not expose pUSD to users or circuits.
- **Per-address deposit cap:** $50,000 USDC maximum cumulative deposit per address in MVP. Enforced in `deposit()` via `cumulativeDeposits[msg.sender]`. Do not remove without Project Agent approval.
- **Signing Layer trust model:** v1 = centralized operator, v2 = TEE (AWS Nitro). TSS/FROST has been dropped from the roadmap. Do not implement TSS-based signing under any framing.
- **No secrets server-side:** The user's note preimage (secret, balance, nonce, owner_address) must never be sent to any backend. All proof generation is client-side WASM. If you are writing backend code that receives this data, stop and consult the Project Agent. The auto-settlement encrypted permission blob (see below) is the only exception — it contains the secret encrypted to the operator's public key and is handled exclusively by the signing layer.
- **Withdrawal is W-to-W only:** Users can only withdraw to their own depositing address. This is enforced cryptographically inside the withdrawal circuit: `owner_address` is part of the note commitment, and the circuit constrains `Poseidon2(owner_address, 0) == recipient_hash`. The Vault also independently verifies `recipient_hash` against the passed `recipientAddress`. There is no mixer path.
- **Operator-driven settlement:** When a market resolves, the Signing Layer calls `Vault.resolveMarket(market_id, payout_per_share)`. The Vault verifies `payout_per_share` against `ctf.payoutNumerators` and stores it in `pendingCredit[market_id]`. Users' settlement credit proofs do not require `payout_per_share` or `shares_held` as witness inputs — those are injected by the Vault from on-chain storage.
- **Auto-settlement permission:** Users may optionally send an ECIES-encrypted blob `(secret, nonce_after_bet)` to the operator's API at bet authorization time. The blob is stored in the operator's private database keyed by `nullifier_of_bet`. It is never stored on-chain. The operator uses it to generate the settlement proof on the user's behalf when the market resolves. Opting in links W to bet B at the operator level but does not affect future bet privacy.
- **Fee model — all rates are governance-mutable Vault storage slots, not hardcoded in circuits.** The circuit reads fee values as Vault-injected public inputs so governance can update any rate without redeploying circuits. All fees accumulate in `Vault.feeAccumulator` and are withdrawable by `feeRecipient` (also governance-mutable). Fee parameters are owner-controlled initially; the owner role is transferable to a governance contract if the protocol decentralizes. Four fee types:
  - **Bet authorization fee (MVP / P1):** `betFeeBps` (basis points, target <0.2%). Deducted inside BET_AUTH circuit: `fee = (bet_amount * betFeeBps / 10000) + relayGasFeeUSDC`. The resulting `new_balance = current_balance - bet_amount - fee`. Exact rate is TBD and not yet set; circuit must accept it as a variable input.
  - **Relay gas fee (MVP / P1, bundled with bet auth fee):** `relayGasFeeUSDC` — a flat USDC amount covering the relay EOA's Polygon gas per transaction. Added to the bet auth deduction above. Not surfaced to users as a separate line item. Should be kept negligible relative to the percentage fee.
  - **Auto-settlement fee (P2):** `autoSettleFeeUSDC` — 20x the estimated Polygon gas cost for a settlement transaction, stored in Vault and updated by the operator to reflect current gas conditions. Deducted from the settlement credit inside the SETTLE_CRED circuit when the auto-settle flag is set. Circuit design for this conditional deduction is a P2 task.
  - **Withdrawal fee (P3):** `withdrawalFeeUSDC` — fixed at $10 USDC (= 10,000,000 in 6-decimal units) initially. Enforced by the Vault contract in `withdraw()` directly (no circuit change needed): `transfer(recipient, withdrawal_amount - withdrawalFeeUSDC)`. Purpose: discourages micro-withdrawals.

---

## ZK Proofs: Quick Reference

Five proof types. Full specs in `docs/zk-design.md`.

| Proof | Noir file | Key public inputs |
|---|---|---|
| Deposit commitment | (none, trivial) | `commitment` (computed client-side, submitted directly) |
| Bet Authorization | `circuits/bet_auth/src/main.nr` | `merkle_root, nullifier, new_commitment, bet_amount, price, expected_shares, market_id, outcome_side, position_id` |
| Settlement Credit | `circuits/settlement_credit/src/main.nr` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, market_id, total_credit` (payout_per_share and shares_held are Vault-injected, NOT user-supplied) |
| Bet Cancel Credit | `circuits/bet_cancel/src/main.nr` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, bet_amount` (bet_amount Vault-injected) |
| N/A Cancel Credit | `circuits/cancel_credit/src/main.nr` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, market_id, bet_amount` (bet_amount Vault-injected) |
| Withdrawal | `circuits/withdrawal/src/main.nr` | `merkle_root, nullifier, withdrawal_amount, recipient_hash, new_commitment` |

**Commitment formula (all circuits):** `bn254::hash_4([secret, balance as Field, nonce as Field, owner_address])`
**Nullifier formula (all circuits):** `bn254::hash_2([secret, nonce as Field])`

---

## Smart Contracts

All contracts live in `packages/contracts/`. Use Foundry for development, testing, and deployment.

**Contract checklist for `Vault.sol`:**
- `deposit(commitment, amount)` — records commitment leaf, accepts USDC via `transferFrom`, increments `cumulativeDeposits[msg.sender]`
- `authorizeBet(proof, BetAuthPublicInputs)` — verifies Bet Auth proof, nullifies old note, inserts new commitment, writes `betRecords[nullifier]`
- `resolveMarket(market_id, payout_per_share)` — operator-only; verifies `payout_per_share` against `ctf.payoutNumerators`, stores in `pendingCredit[market_id]`
- `creditSettlement(proof, SettlementPublicInputs)` — verifies Settlement Credit proof; Vault injects `payout_per_share` from `pendingCredit[market_id]` and `shares_held` from `betRecords[nullifier_of_bet]`; user does NOT supply these values
- `betCancellationCredit(proof, BetCancelPublicInputs)` — verifies Bet Cancel proof for FOK-failed bets; Vault injects `bet_amount` from `betRecords`
- `naCancellationCredit(proof, NACancelPublicInputs)` — verifies N/A Cancel proof; Vault checks `ctf.payoutNumerators` are all zero; Vault injects `bet_amount`
- `withdraw(proof, WithdrawalPublicInputs, recipientAddress)` — verifies Withdrawal proof, verifies `Poseidon2(recipientAddress, 0) == recipient_hash`, transfers USDC; reverts if recipient does not match the commitment's `owner_address`
- `reportFilled(nullifier_of_bet)` — operator-only; sets `betRecords.status = FILLED`
- `reportFOKFailure(nullifier_of_bet)` — operator-only; sets `betRecords.status = FAILED`

**New state in `Vault.sol`:**
- `mapping(bytes32 => uint64) public pendingCredit` — `market_id => payout_per_share`, written by `resolveMarket`
- `event MarketResolved(bytes32 indexed market_id, uint64 payout_per_share)`

**Required security properties:**
- Nullifier registry check must happen before any state change (checks-effects-interactions)
- Merkle root window: accept last 30 roots, not just the current one
- No raw `call` with user-controlled calldata
- Reentrancy guard on all state-modifying functions

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
- Secrets are derived from wallet signatures — never generated randomly. Call `deriveSecret(wallet, depositIndex)` which signs the canonical EIP-191 message and reduces mod p. Never call `generateSecret()` or `crypto.getRandomValues()` for note secrets.
- Do NOT show the user a raw secret or ask them to back anything up. Their wallet is their backup.
- localStorage stores the note cache for performance only: `(kind, balance, nonce, commitment, nullifier, spent, owner_address, createdAt, txHash, marketId, expectedShares)`. The secret is NOT persisted to localStorage — it is re-derived on demand.
- On recovery (new device or cleared storage): call `recoverNotes(wallet)` which scans `Deposited(W, ...)` events, re-derives secrets by index, matches commitments, and replays state transitions from on-chain events.
- The deposit index counter `(wallet_address → count)` is stored in localStorage and is the only thing that must be preserved for performance. It is recoverable by scanning chain events if lost.

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
- Circuits: Noir tests in each circuit's test file. Test valid proofs and expected failures for each constraint.
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

# ── Circuits ─────────────────────────────────────────────────────────────────
cd packages/circuits
nargo check
nargo test
nargo compile

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
- Real: Vault, CommitmentMerkleTree, NullifierRegistry, all 5 UltraPLONK verifiers, PoseidonT3Hasher (BN254), Proof Relay, Indexer, Signing Layer, MockUSDC, MockCTF
- Mock (intentional): mockClobServer only — mimics the Polymarket CLOB API

**Known limitation:** Frontend currently uses MOCK_PROOF (64 zero bytes) and keccak256 for hashing. Real proof verification will reject these — the WASM prover and Poseidon hashing are the next items to wire up.

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

These tasks were produced by a full audit of `packages/contracts/src/Vault.sol` and all circuits in `packages/circuits/`. Execute them in the order listed. After completing all contract changes, run `forge build && forge test` and confirm zero failures. After circuit changes, run `nargo test` in each affected circuit directory and confirm zero failures.

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

### TASK-M2 — Fix zero leaf in all five circuit test files

**Files:**
- `packages/circuits/bet_auth/src/test.nr`
- `packages/circuits/withdrawal/src/test.nr`
- `packages/circuits/settlement_credit/src/test.nr`
- `packages/circuits/bet_cancel/src/test.nr`
- `packages/circuits/cancel_credit/src/test.nr`

**Why:** Every test file constructs a Merkle zero-path starting from `bn254::hash_3([0, 0, 0])` as the zero leaf. The deployed `CommitmentMerkleTree.sol` uses `bytes32(0)` (the Field element `0`) as its zero leaf. These produce completely different zero-paths and roots, meaning every test that exercises the Merkle path constraint is testing against a phantom tree that will never exist on-chain.

**Changes required:**

In `bet_auth/src/test.nr`, replace the `zero_leaf()` helper:
```noir
// BEFORE
fn zero_leaf() -> Field {
    bn254::hash_3([0, 0, 0])
}
```
```noir
// AFTER — matches CommitmentMerkleTree.sol: bytes32(0) zero leaf
fn zero_leaf() -> Field {
    0
}
```
The `build_zero_path()` in `bet_auth/test.nr` already calls `zero_leaf()`, so no further change is needed there.

In the remaining four test files, replace the inline zero-leaf initializer in `build_zero_path()`:
```noir
// BEFORE
let mut h = bn254::hash_3([0, 0, 0]);
```
```noir
// AFTER — matches CommitmentMerkleTree.sol: bytes32(0) zero leaf
let mut h: Field = 0;
```

Apply this identical one-line substitution in `withdrawal/test.nr`, `settlement_credit/test.nr`, `bet_cancel/test.nr`, and `cancel_credit/test.nr`.

After the fix, rerun `nargo test` in each circuit directory. All existing tests should still pass (they are self-consistent — they compute the root dynamically and never hardcode a specific root value). If any test hardcodes a root value, update it using the correct zero-leaf computation.

Also update any `Prover.toml` files whose `merkle_root`, `merkle_path`, or `path_*` values were generated from the old zero leaf. Regenerate them by running the `test_print_bench_inputs` test in each circuit after the fix:
```bash
cd packages/circuits/<circuit_name>
nargo test test_print_bench_inputs 2>&1 | grep BENCH
```
Copy the printed values back into `Prover.toml`.

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

### TASK-C3 — Regenerate `SettlementCreditVerifier.sol` (stale verification key)

**File:** `packages/contracts/src/verifiers/SettlementCreditVerifier.sol`

**Why:** The current `SettlementCreditVerifier.sol` embeds `vk.num_inputs = 8`. The `settlement_credit.nr` circuit has **6** public inputs. The verifier was generated against an older version of the circuit that still exposed `payout_per_share` and `shares_held` as public inputs 7 and 8. Both were subsequently moved to on-chain Vault logic, but the verifier was never regenerated. The `verify()` function explicitly checks `requiredPublicInputCount != _publicInputs.length` (line 587) and reverts with `PUBLIC_INPUT_COUNT_INVALID`. Every call to `Vault.creditSettlement()` will revert unconditionally until this is fixed.

**Changes required:**

1. Recompile the settlement_credit circuit to produce a fresh artifact:
   ```bash
   cd packages/circuits/settlement_credit
   nargo compile
   ```

2. Generate a new verification key and Solidity verifier:
   ```bash
   bb write_vk -b ./target/settlement_credit.json -o ./target --oracle_hash keccak
   bb contract -k ./target/vk -o ./target/SettlementCreditVerifier.sol --oracle_hash keccak
   ```

3. Replace `packages/contracts/src/verifiers/SettlementCreditVerifier.sol` with the file produced at `packages/circuits/settlement_credit/target/SettlementCreditVerifier.sol`.

4. Open the new verifier and confirm the line reads:
   ```
   mstore(add(_vk, 0x20), 0x0000000000000000000000000000000000000000000000000000000000000006) // vk.num_inputs
   ```
   If it reads anything other than `0x6`, do not proceed — the compilation inputs were wrong.

5. Run `forge build && forge test` in `packages/contracts/`. All tests must pass. Any test that exercises `creditSettlement` must be confirmed to pass, not just compile.

**No changes to `Vault.sol` or the circuit itself.** The circuit and the `_settlementPublicInputs` function are both correct (6 elements). Only the verifier artifact is stale.

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
