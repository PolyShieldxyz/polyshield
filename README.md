# Polyshield

[![Website](https://img.shields.io/badge/web-polyshield.xyz-0b0b0b)](https://polyshield.xyz) [![X / Twitter](https://img.shields.io/badge/X-@PolyShieldapp-1d9bf0)](https://x.com/PolyShieldapp) [![GitHub](https://img.shields.io/badge/GitHub-PolyShieldxyz-181717)](https://github.com/PolyShieldxyz)

A zero-knowledge privacy vault for [Polymarket](https://polymarket.com). Deposit USDC into a shared vault, authorize bets via ZK proofs, and withdraw — without your wallet address ever appearing in a Polymarket transaction.

**Status:** Core protocol live on Polygon mainnet (limited test phase) — full deposit → bet → settle → withdraw verified end-to-end with real funds. [Roadmap →](https://polyshield.xyz/roadmap)

---

## What it does

Polymarket is fully on-chain: every order, fill, and position is publicly attributable to the wallet that placed it. Polyshield breaks this link.

The vault holds one Polymarket signing account (EOA) shared by all depositors. When you authorize a bet, you submit a ZK proof to the vault contract — not a transaction from your own wallet. The vault verifies the proof on-chain, then its EOA submits the CLOB order. To any observer, the trade came from the vault. Your address does not appear anywhere in the bet flow.

**What Polyshield hides:** which depositor authorized which bet.
**What Polyshield does not hide:** that a wallet deposited into the vault (the `deposit()` call is a public ERC-20 transfer).

---

## Architecture

```
 ┌─ USER BROWSER (Next.js) ───────────────────────────────────────────────────────────┐
 │  Wallet-derived SECRET — never leaves the browser. Generates ALL ZK proofs (WASM).  │
 │  Proofs: BET_AUTH · SETTLE_CRED · WITHDRAW · BET_CANCEL · CANCEL_CRED · DEPOSIT ·    │
 │          POSITION_CLOSE · PARTIAL_CREDIT · CONSOLIDATE  (9 circuits)                 │
 └───┬───────────────────────────────────┬───────────────────────────────────────────┘
     │ deposit() ONLY                     │ proofs + reads (merkle-path / recovery-data /
     │ (the only tx from the user wallet) │  events) — the browser NEVER scans the chain
     ▼                                    ▼
 ┌─────────────┐   ┌──────────────────────────────────────────────────────────────────┐
 │ Polygon RPC │   │ PROOF RELAY (3002)  — stateless; relayer EOA pays gas, user wallet │
 │ archive /   │◄──┤ never = tx.from. ALSO the backend index/cache (SQLite merkle.db): │
 │ full node;  │   │   • CachedMerkleTree → /merkle-path  (O(32), no chain scan)        │
 │ NO 10-block │   │   • VaultEventIndex  → /recovery-data , /events                    │
 │ getLogs cap │   │   mirrors public on-chain state so clients never re-scan the chain │
 └──────┬──────┘   └──────────────────────────────────┬───────────────────────────────┘
        │ reads/relays                                 │ scans events once, then incremental
        ▼                                              ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │ POLYGON (on-chain, UUPS proxies)                                                        │
 │  Vault.sol — verifies proofs · USDC custody · betRecords · pendingCredit · feeConfig    │
 │    ├── CommitmentMerkleTree.sol — Poseidon depth-32 append-only, 1024-root window       │
 │    ├── NullifierRegistry.sol    — spent-nullifier dedup                                 │
 │    └── 9× Groth16 verifier adapters (snarkjs / BN254, UUPS behind proxies)              │
 └──────┬──────────────────────────────────────────────────────────────────▲──────────────┘
        │ vault EOA owns ↓                       operator-only: resolveMarket │ / credit / fund
        ▼                                                                     │
 ┌──────────────────────┐   ┌────────────────────────────────────────────────────────────┐
 │ Polymarket CLOB + CTF │◄──┤ SIGNING LAYER (Node.js, centralized v1; vault EOA key)        │
 │ + builder Relayer     │   │  • event-listener: BetAuthorized → FAK / GTC / GTD order      │
 │ (Deposit Wallet holds │   │  • settlement-resolver: CTF resolved → resolveMarket + redeem │
 │  pUSD + CTF shares)   │   │  • JIT collateral funding · FC-9 signed operator attestations │
 └──────────────────────┘   │  v2: AWS Nitro TEE (planned)                                  │
                            └────────────────────────────────────────────────────────────┘
   Settlement detection lives in the signing layer (settlement-resolver); settlement records and
   the explorer event feed are served by the proof-relay's index — there is no separate indexer service.
```

**Chain:** Polygon mainnet (production) / Polygon Amoy (testnet).
**Collateral:** USDC only. pUSD conversion is internal to the Vault.
**RPC:** requires a full/archive node with a usable `eth_getLogs` range — Alchemy's free tier (10-block cap) and pruned public nodes do **not** work in production. See [`docs/architecture.md` §2.5](docs/architecture.md).
**Privacy:** the secret and the wallet↔bet link live only in the browser; every backend service sees only public, anonymous on-chain data.

---

## ZK Circuits

Nine Circom circuits compiled with Groth16 (snarkjs, BN254). Proofs are generated client-side in the browser via WASM and verified on-chain by Groth16 adapter contracts (verifier slot in parentheses):

| Circuit | File | What it proves |
|---|---|---|
| **DEPOSIT** (5) | `circuits/groth16/deposit.circom` | Binds the committed balance + owner to the deposited amount and `msg.sender` (FC-2, mandatory; prevents balance forgery / T20) |
| **BET_AUTH** (0) | `circuits/groth16/bet_auth.circom` | Note has sufficient balance; valid nullifier; new note correct after spending `bet_amount + fee` (fee Vault-injected, FC-10) |
| **SETTLEMENT_CREDIT** (1) | `circuits/groth16/settlement_credit.circom` | Held a winning position; credit = shares × payout (both Vault-injected) |
| **WITHDRAWAL** (2) | `circuits/groth16/withdrawal.circom` | Knows the note secret; withdrawal goes to the depositor's own address (W-to-W only) |
| **BET_CANCEL** (3) | `circuits/groth16/bet_cancel.circom` | Restores note balance for a failed/cancelled bet (amount Vault-injected) |
| **CANCEL_CREDIT** (4) | `circuits/groth16/cancel_credit.circom` | N/A market (all CTF payout numerators zero) → refund |
| **POSITION_CLOSE** (6) | `circuits/groth16/position_close.circom` | Pre-settlement sale credit (proceeds Vault-injected from operator SOLD attestation, FC-1) |
| **PARTIAL_CREDIT** (7) | `circuits/groth16/partial_credit.circom` | Refund of the unfilled remainder of a partial limit-order fill (FC-4) |
| **CONSOLIDATE** (8) | `circuits/groth16/consolidate.circom` | Merges up to 4 same-owner notes into 1 (FC-8) |

> The Noir circuits live under `circuits/Noir/` (`circuits/Noir/bet_auth/`, `circuits/Noir/withdrawal/`, etc.) and are kept as a specification reference only. They are not compiled or used for proof generation. See [`packages/circuits/README.md`](packages/circuits/README.md) for details.

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
    groth16/     Active Circom (Groth16/snarkjs) — bet_auth, settlement_credit, withdrawal, bet_cancel,
                 cancel_credit, deposit, position_close, partial_credit, consolidate (9 circuits)
    Noir/        Noir source — reference only, not compiled or used
    pipeline/    
  backend/
    signing-layer/     Node.js — BetAuthorized → FAK/GTC/GTD orders; settlement resolver; JIT funding;
                       FC-9 attestations; auto-settlement API (port 3004)
    proof-relay/       Relays proofs (relayer EOA pays gas) + backend index/cache + market catalog:
                       /merkle-path (CachedMerkleTree), /recovery-data + /events (VaultEventIndex),
                       /relay/settlement (settlement credit), /markets (Gamma catalog), /analytics, SQLite merkle.db
  frontend/      Next.js + Wagmi — deposit, bet, settle, withdraw UIs
  test-fixtures/ Generated test data (markets, users, action sequences)

docs/
  architecture.md                    System design — read before touching contracts or circuits
  zk-design.md                       Circuit and note specifications — read before touching circuits
  threat-model.md                    Privacy guarantees and attack surface
  future-changes.md                  Approved/implemented change log (FC-1 … FC-12)
  diagrams/                          Mermaid process & path diagrams (visual companion to architecture.md)
  open-questions.md                  Unresolved design questions — check before implementing
```

> `deploy/` — single-host Docker Compose deployment (Caddy + frontend + backend services). See [`deploy/README.md`](deploy/README.md).

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
| Proof Relay | 3002 | Real relay; submits to Vault on Anvil; also serves merkle-path / recovery-data / events / settlement |
| Signing Layer | 3004 | Real operator; watches `BetAuthorized`, submits orders, resolves settlement, serves attestations |
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

# ── Circuits (Groth16 / Circom) ──────────────────────────────────────────────
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
- **Merkle root window:** The Vault accepts a rolling window of the last 1024 Merkle roots (O(1) membership; FC-3) to accommodate proof-generation latency without compromising security.
- **W-to-W withdrawal:** Withdrawal destination is cryptographically bound to the depositing address inside the note commitment. The circuit enforces this; the Vault also independently verifies it.
- **Checks-effects-interactions:** All state changes (nullifier mark, new commitment insertion) occur before any external token transfer in every Vault function.
- **No server-side secrets:** The note preimage never leaves the browser. Secrets are wallet-derived (FC-13: one master-seed signature per session derives all of them locally; held in memory, never persisted). The note cache (balances/commitments/linkage, never the secret) is stored **encrypted in IndexedDB**.
- **$50k deposit cap:** 50,000 USDC maximum cumulative deposit per address in MVP, enforced in `Vault.deposit()`.

- **Instant UUPS upgradeability (largest trust assumption):** the owner key can replace any contract's logic in a single transaction (no timelock). This is a deliberate trade-off for the early mainnet test phase — the owner role must be a multisig/HSM in production. See `docs/threat-model.md` (T21).

Smart contracts are open-source and MIT licensed. The protocol is currently in a **limited mainnet test phase**; an independent audit is planned before public/general availability.

---

## Roadmap

| Phase | Status | Focus |
|---|---|---|
| **P1 — Core Protocol** | ✅ SHIPPED | 9 Circom/Groth16 circuits, UUPS Vault + tree (1024-root) + registry + 9 verifiers, mandatory deposit-binding proof (FC-2), wallet-derived secrets (FC-13 one-signature master seed + encrypted IndexedDB cache), on-chain payout derivation — **live on Polygon mainnet** |
| **P2 — Orders, Fees & Infra** | ✅ SHIPPED | FAK market + GTC/GTD limit orders with partial-fill credit (FC-4), gasless operator attestations (FC-9), JIT collateral (FC-7), protocol fees (FC-10), consolidation (FC-8), position close (FC-1), backend index/recovery/explorer (FC-12), live Polymarket integration, single-host Docker deploy |
| **P3 — Hardening & Beta** | 🔨 IN PROGRESS | Security audit, owner key → multisig/HSM, base-buffer collateral (Option 4 / FC-6), persisted circuit-breaker + alerting, anonymity-set growth, public beta |
| **P4 — TEE & Trust Min.** | PLANNED | AWS Nitro signing layer v2 + remote attestation gate, multi-EOA rotation, withdrawal timing posture / onion relay, fee governance transition |
| **P5 — Multi-chain & Scaling** | RESEARCH | Multi-chain deposits, SMT nullifier registry, recursive proofs, mobile WASM prover, generic CLOB adapter beyond Polymarket |
| **P6 — Cryptography Frontier** | RESEARCH | Post-quantum ZK (STARK/lattice), FHE for private state, ZK coprocessor, proof marketplace |

Full roadmap with per-phase deliverables: [polyshield.xyz/roadmap](https://polyshield.xyz/roadmap)

<!-- 

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full guide — workflow, project layout, coding standards, testing requirements, and the change types that need maintainer sign-off.

In short, before writing any code:

- Read [`CLAUDE.md`](CLAUDE.md) — the authoritative source for architecture decisions, naming conventions, and protocol constants that must not be overridden.
- Read [`docs/open-questions.md`](docs/open-questions.md) before implementing anything in affected areas (Q4, Q5, Q7, Q8 are the most likely to be relevant). Check which questions are OPEN vs RESOLVED.
- Read [`docs/zk-design.md`](docs/zk-design.md) before touching any circuit or any code that interacts with commitments or nullifiers. -->

---

## Links

- Website — [polyshield.xyz](https://polyshield.xyz)
- X / Twitter — [@PolyShieldapp](https://x.com/PolyShieldapp)
- GitHub — [PolyShieldxyz](https://github.com/PolyShieldxyz)

---

## License

MIT © 2026 Polyshield Labs
