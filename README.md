# Polyshield

A zero-knowledge privacy vault for [Polymarket](https://polymarket.com). Deposit USDC into a shared vault, authorize bets via ZK proofs, and withdraw — without your wallet address ever appearing in a Polymarket transaction.

**Status:** Private beta · Polygon Amoy testnet · [Apply for access →](https://polyshield.xyz/testnet)

---

## What it does

Polymarket is fully on-chain: every order, fill, and position is publicly attributable to the wallet that placed it. Polyshield breaks this link.

The vault holds one Polymarket signing account (EOA) shared by all depositors. When you authorize a bet, you submit a ZK proof to the vault contract — not a transaction from your own wallet. The vault verifies the proof on-chain, then its EOA submits the CLOB order. To any observer, the trade came from the vault. Your address does not appear anywhere in the bet flow.

**What Polyshield hides:** which depositor authorized which bet.
**What Polyshield does not hide:** that a wallet deposited into the vault (the `deposit()` call is a public ERC-20 transfer).

---

## Architecture

```
User wallet
  │  deposit() only — one public tx per deposit
  │
  ├── Browser WASM Prover
  │     Generates ZK proofs client-side. Secret never leaves browser.
  │     Proof types: BET_AUTH · SETTLE_CRED · WITHDRAW · BET_CANCEL · CANCEL_CRED
  │
  ├── Proof Relay  (port 3002)
  │     Stateless Express service. Submits proofs to Vault on user's behalf.
  │     Relay's own EOA pays gas. User wallet never touches bet-related txs.
  │
  └── Vault.sol  (Polygon / Amoy)
        Verifies ZK proofs · Merkle tree · Nullifier registry · USDC custody
        │
        ├── CommitmentMerkleTree.sol  — Poseidon depth-32 append-only tree
        ├── NullifierRegistry.sol     — spent nullifier deduplication
        └── 5× Groth16 Verifiers      — one per proof type (snarkjs / BN254)
              │
              └── Signing Layer  (Node.js, centralized v1)
                    Listens for BetAuthorized events.
                    Signs and submits FOK orders to Polymarket CLOB.
                    v2: AWS Nitro Enclave (planned P3).
```

**Chain:** Polygon mainnet (production) / Polygon Amoy (testnet)
**Collateral:** USDC only. pUSD conversion is internal to the Vault.

---

## ZK Circuits

Five Circom circuits compiled with Groth16 (snarkjs, BN254). Proofs are generated client-side in the browser via WASM and verified on-chain by Groth16 adapter contracts:

| Circuit | File | What it proves |
|---|---|---|
| **BET_AUTH** | `circuits/groth16/bet_auth.circom` | Note has sufficient balance; nullifier is valid; new note is correctly formed after spend |
| **SETTLE_CRED** | `circuits/groth16/settlement_credit.circom` | Depositor held a winning position; settlement credit is correct |
| **WITHDRAW** | `circuits/groth16/withdrawal.circom` | Depositor knows note secret; withdrawal goes to their own depositing address |
| **BET_CANCEL** | `circuits/groth16/bet_cancel.circom` | Restores note balance for a failed FOK bet |
| **CANCEL_CRED** | `circuits/groth16/cancel_credit.circom` | N/A market resolution — all CTF payout numerators are zero |

> The Noir circuits in `circuits/bet_auth/`, `circuits/withdrawal/`, etc. are kept as a specification reference only. They are not compiled or used for proof generation. See [`packages/circuits/README.md`](packages/circuits/README.md) for details.

### Note structure

```
Note = (secret: Field, balance: u64, nonce: u64, owner_address: Field)
```

- **`secret`** — derived from a wallet signature (`keccak256(signMessage(...)) mod p`). Never stored. Always re-derived on demand.
- **`balance`** — USDC in micro-units (6 decimals). 1 USDC = 1_000_000.
- **`nonce`** — increments by 1 on every state transition.
- **`owner_address`** — depositing wallet address cast to a BN254 field element.

```
commitment = Poseidon4(secret, balance, nonce, owner_address)
nullifier  = Poseidon2(secret, nonce)
```

Withdrawal is wallet-to-wallet only. The `owner_address` field is inside the commitment, and the withdrawal circuit enforces `Poseidon2(owner_address, 0) == recipient_hash`. There is no mixer path.

---

## Repo structure

```
packages/
  contracts/     Vault.sol, CommitmentMerkleTree, NullifierRegistry, verifiers (Foundry)
  circuits/
    groth16/     Active Circom circuits (Groth16/snarkjs) — bet_auth, settlement_credit, withdrawal, bet_cancel, cancel_credit
    bet_auth/    Noir source — reference only, not compiled or used
    withdrawal/  Noir source — reference only, not compiled or used
    (…other Noir dirs)  see packages/circuits/README.md
  backend/
    signing-layer/     Node.js — listens for BetAuthorized, submits FOK orders to CLOB
    proof-relay/       Stateless Express — 5 relay endpoints, relayer EOA pays gas
    indexer/           CTF settlement event listener, REST API for WASM prover witness data
    mock-clob-server/  Fake Polymarket CLOB for local dev (mock only — all other components are real)
    mock-env/          Anvil + contract deployment + service orchestration
  frontend/      Next.js + Wagmi — deposit, bet, settle, withdraw UIs
  test-fixtures/ Generated test data (markets, users, action sequences)

docs/
  architecture.md                    System design — read before touching contracts or circuits
  zk-design.md                       Circuit and note specifications — read before touching circuits
  threat-model.md                    Privacy guarantees and attack surface
  open-questions.md                  Unresolved design questions — check before implementing
  polymarket-api.md                  CLOB/CTF integration reference
  Q16-proving-backend-comparison.md  UltraPLONK vs Groth16 benchmark results
  collateral-flow-audit.md           pUSD/USDC collateral flow analysis
  codespaces-setup.md                Dev environment setup (Codespaces / fresh machine)
```

---

## Local dev setup

**Prerequisites:** Node.js 20+, pnpm 9+, Foundry, `circom` 2.1.6+, `snarkjs` (for circuit rebuilds only — not needed for running the app)

```bash
# Install all dependencies
pnpm install

# Terminal 1 — full local stack: Anvil + contracts + all backend services
pnpm dev:mock

# Terminal 2 — Next.js frontend
pnpm dev:frontend

# Or both together
pnpm dev:all
```

### Local services

| Service | Port | Notes |
|---|---|---|
| Anvil RPC | 8545 | Chain ID 31337 — resets on every `dev:mock` restart |
| Mock CLOB | 3001 | Fake Polymarket — `POST /admin/settle-market` triggers resolution |
| Proof Relay | 3002 | Real relay, submits to Vault on Anvil |
| Indexer API | 3003 | Real indexer, listens for CTF settlement events |
| Frontend | 3000 | `pnpm dev:frontend` |

### Test accounts (pre-funded on Anvil restart)

| Name | Address | Balance |
|---|---|---|
| ALICE | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` | 100k USDC |
| BOB | `0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc` | 10k USDC |
| USER_1 | `0x2d209040c031d4e2D4d9cb4D3aabf18F52260AB0` | 2 ETH + 100k USDC |
| USER_2 | `0x7D0A7d3a4508B33C6A0e9F3FCBc72562cC120e89` | 2 ETH + 100k USDC |
| USER_3 | `0x46458d7CE6157AE78BFF94D2096308f352c7edc8` | 2 ETH + 100k USDC |

**Logging:** all services write to `logs/session-<timestamp>.jsonl`. Run `tail -f logs/*.jsonl | jq .` to watch everything live.

---

## Commands

```bash
# ── Contracts ────────────────────────────────────────────────────────────────
pnpm contracts:build        # forge build
pnpm contracts:test         # forge test
pnpm contracts:coverage     # forge coverage

# ── Circuits (Groth16 / Circom — run from Benchmarking/groth16/) ─────────────
pnpm compile:circuits       # circom → r1cs + wasm artifacts
pnpm setup:circuits         # snarkjs groth16 setup → .zkey proving keys
pnpm generate:verifiers     # generate Solidity verifier contracts
pnpm generate:test-proofs   # generate + verify test proofs
# After rebuild, copy assets to frontend:
#   cp artifacts/<c>/<c>_js/<c>.wasm ../../packages/frontend/public/circuits/
#   cp setup/<c>.zkey ../../packages/frontend/public/zkeys/
# (The Noir commands — nargo compile/test — only apply to the reference circuits)

# ── Frontend ─────────────────────────────────────────────────────────────────
cd packages/frontend
pnpm dev                    # Next.js dev server
pnpm build                  # production build + type check
pnpm lint

# ── Backend ──────────────────────────────────────────────────────────────────
cd packages/backend
pnpm dev                    # all backend services
```

---

## Proof generation

Proofs run entirely in the browser via WASM (snarkjs Groth16). The `.wasm` circuit files (~2.4 MB each) and `.zkey` proving keys (~8.7 MB each) are fetched from `/circuits/` and `/zkeys/` and cached in memory when the app loads. Expect **30 seconds to 2 minutes** per proof depending on device. The frontend shows a progress indicator and prevents navigation during proving.

Proof witness data (secret, balance, nonce) is never sent to any server. Secret derivation, proof generation, and note management are all client-side only.

---

## Security properties

- **Soundness:** Every state transition is gated by an on-chain ZK proof verification. Invalid proofs are rejected by the verifier contracts. There is no admin bypass.
- **Nullifier protection:** Every spent note produces a public nullifier stored in `NullifierRegistry`. Double-spend is impossible without knowing the secret.
- **Merkle root window:** The Vault accepts the last 30 Merkle roots to accommodate proof generation latency without compromising security.
- **W-to-W withdrawal:** Withdrawal destination is cryptographically bound to the depositing address inside the note commitment. The circuit enforces this; the Vault also independently verifies it.
- **Checks-effects-interactions:** All state changes (nullifier mark, new commitment insertion) occur before any external token transfer in every Vault function.
- **No server-side secrets:** The note preimage never leaves the browser. Secrets are re-derived from wallet signatures on demand.
- **$50k deposit cap:** 50,000 USDC maximum cumulative deposit per address in MVP, enforced in `Vault.deposit()`.

Smart contracts are open-source and MIT licensed. Independent audits are planned before mainnet deployment.

---

## Roadmap

| Phase | Timeline | Status | Focus |
|---|---|---|---|
| **P1 — MVP Alpha** | H1 2026 | IN PROGRESS | Core contracts, circuits, signing layer v1, testnet scaffold, fee infrastructure, JIT collateral deployment (Option 3 / FC-7) on a relayer/proxy deposit-wallet model |
| **P2 — Testnet v1** | H2 2026 | PLANNED | Real WASM proofs, wallet-derived secrets, operator-driven settlement, open beta, base-buffer + JIT-overflow collateral (Option 4) |
| **P3 — TEE + Multi-chain** | H1 2027 | PLANNED | AWS Nitro signing layer v2, multi-chain deposits, withdrawal fee |
| **P4 — Privacy Infrastructure** | H2 2027 | PLANNED | Decoy traffic, onion relay, SMT nullifier, privacy metrics dashboard |
| **P5 — Multi-market** | 2028 | RESEARCH | Expand beyond Polymarket, GTC order support |
| **P6 — Post-Quantum** | 2028–2029 | RESEARCH | Lattice/STARK ZK backends |
| **P7 — ZK Infrastructure** | 2028+ | RESEARCH | Recursive proofs, mobile WASM prover, ZK coprocessor |

Full roadmap with per-phase deliverables: [polyshield.xyz/roadmap](https://polyshield.xyz/roadmap)

---

## Contributing

Read [`CLAUDE.md`](CLAUDE.md) before writing any code — it is the authoritative source for architecture decisions, naming conventions, and constraints that must not be overridden.

Read [`docs/open-questions.md`](docs/open-questions.md) before implementing anything in affected areas (Q4, Q5, Q7, Q8 are the most likely to be relevant). Check which questions are OPEN vs RESOLVED.

Read [`docs/zk-design.md`](docs/zk-design.md) before touching any circuit or writing code that interacts with commitments or nullifiers.

---

## License

MIT © 2026 Polyshield Labs
