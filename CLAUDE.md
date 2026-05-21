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
  contracts/     Solidity on Polygon (Vault, CommitmentTree, Verifiers, Nullifier registry)
  circuits/      Noir circuits (bet_auth, settlement_credit, withdrawal)
  backend/       Node.js (signing layer v1, Polymarket indexer, proof relay)
  frontend/      Next.js + Wagmi (deposit, bet proposal, withdrawal UIs)
  sdk/           TypeScript (client-side note management, WASM prover wrapper)

docs/
  architecture.md       Read before touching contracts or circuits
  zk-design.md          Read before touching circuits
  open-questions.md     Live tracker of unresolved research questions
  threat-model.md       Read before any security-relevant implementation
  polymarket-api.md     Polymarket CLOB/CTF integration reference

CLAUDE.md              This file
```

---

## Key Architecture Decisions (Do Not Override Without Project Agent Approval)

- **Hash function:** Poseidon everywhere. Do not substitute Keccak256 or Pedersen in circuits.
- **Note structure:** `(secret: Field, balance: u64, nonce: u64)`. Commitment = `Poseidon(secret, balance, nonce)`. Nullifier = `Poseidon(secret, nonce)`.
- **Merkle tree:** Poseidon-hashed, depth 32, append-only. Implemented in Solidity with off-chain proofs computed client-side.
- **ZK language:** Noir (Aztec). Do not implement circuits in Circom or use another system without explicit approval.
- **ZK backend:** UltraPLONK ONLY — both dev/testing and mainnet. Groth16 and UltraHonk are permanently dropped from the roadmap. Do not introduce Honk or Groth16 verifiers anywhere in the deployment path. The files in `packages/groth16/` and `packages/contracts/src/verifiers/*HonkVerifier.sol` are benchmarking artifacts only — never deployed.
- **Chain:** Polygon mainnet (Polymarket runs here). Testnet target: Polygon Amoy.
- **Collateral token:** Vault accepts and pays out in USDC only. pUSD conversion (via CollateralOnramp/Offramp) is internal to the Vault contract. Do not expose pUSD to users or circuits.
- **Per-address deposit cap:** $50,000 USDC maximum cumulative deposit per address in MVP. Enforced in `deposit()` via `cumulativeDeposits[msg.sender]`. Do not remove without Project Agent approval.
- **Signing Layer trust model:** v1 = centralized operator, v2 = TEE (AWS Nitro). TSS/FROST has been dropped from the roadmap. Do not implement TSS-based signing under any framing.
- **No secrets server-side:** The user's note preimage (secret, balance, nonce) must never be sent to any backend. All proof generation is client-side WASM. If you are writing backend code that receives this data, stop and consult the Project Agent.
- **Recipient binding:** In the withdrawal proof, the recipient address must be a private input and its Poseidon hash must be the public input. Do not use the raw address as a public input.

---

## ZK Proofs: Quick Reference

Four proof types. Full specs in `docs/zk-design.md`.

| Proof | Noir file | Key public inputs |
|---|---|---|
| Deposit commitment | (none, trivial) | `commitment` |
| Bet Authorization | `circuits/bet_auth.nr` | `merkle_root, nullifier, new_commitment, bet_amount, market_id, outcome_side` |
| Settlement Credit | `circuits/settlement_credit.nr` | `merkle_root, nullifier, new_commitment, market_id, payout_per_share` |
| Withdrawal | `circuits/withdrawal.nr` | `merkle_root, nullifier, withdrawal_amount, recipient_hash` |

---

## Smart Contracts

All contracts live in `packages/contracts/`. Use Foundry for development, testing, and deployment.

**Contract checklist for `Vault.sol`:**
- `deposit(commitment)` — records commitment leaf, accepts USDC (ERC-20 `transferFrom`)
- `authorizeBet(proof, publicInputs)` — verifies Bet Auth proof, updates Merkle tree, nullifies old note, stores encrypted bet descriptor
- `creditSettlement(proof, publicInputs)` — verifies Settlement Credit proof, updates note
- `withdraw(proof, publicInputs)` — verifies Withdrawal proof, checks nullifier registry, transfers USDC to `recipient_address` (which must match `recipient_hash` in the proof)

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
- On first deposit, generate `secret` using `crypto.getRandomValues()` (not Math.random)
- Display the note (hex-encoded preimage) to the user with a mandatory "I have saved my note" confirmation before proceeding
- Optionally: offer to encrypt the note with the user's connected wallet's public key and store on localStorage (with clear warnings)
- Never silently store the note in localStorage without user awareness

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

Do not implement these without a spec document from the Project Agent:

- Any change to the note structure `(secret, balance, nonce)` or the Poseidon commitment formula
- Any change to the public inputs of any ZK circuit
- Signing Layer v2 (TEE) or v3 (TSS) implementation
- The bet descriptor encryption scheme
- The multi-EOA rotation scheme for vault EOA ban recovery
- The protocol fee mechanism
- Any mechanism that involves the backend receiving user secrets

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
