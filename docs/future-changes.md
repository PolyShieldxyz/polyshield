# Future Changes: Polyshield

**Purpose:** Decided changes that are not yet implemented. Each entry is approved in direction and scoped for a future build pass. Distinct from `open-questions.md` (unresolved research) and `threat-model.md` (attack tracker). When an item here is implemented, move its decisions into `CLAUDE.md` and mark the entry DONE.

**Format:** Each change has a status, the driving tracker item, the v1 scope, and an implementation outline. Implementation outlines are specification-level only. Circuit and contract code is written by Claude Code, not the Project Agent.

---

## FC-1: Position close / secondary sale before settlement

**Status:** IMPLEMENTED (2026-05-30) — Circom/groth16
**Driver:** Q24 (RESOLVED), see `open-questions.md`
**v1 trust model:** Operator-reported proceeds
**v1 partial sells:** Supported

> **As built:** Circom circuit `packages/circuits/groth16/position_close.circom` (5 public
> inputs: `merkle_root, nullifier, new_commitment, nullifier_of_bet, sell_proceeds`),
> snarkjs Groth16 verifier `PositionCloseVerifier.sol` at verifier slot `POSITION_CLOSE = 6`.
> Vault adds `BetStatus.{CLOSING, CLOSED_CREDITED}`, `BetRecord.{sell_proceeds, sold_shares}`,
> `reportSold(...)` (operator), and `closePosition(proof, ClosePublicInputs)`. Backend:
> `submitFOKSellOrder` + `POST /close-request` (signing layer) and `POST /relay/close`
> (proof-relay). Frontend: `ClosePositionModal` + portfolio "Close" action. Note: the
> outline below uses Noir `.nr` naming for historical reference only — the live build is
> Circom + snarkjs Groth16 (see `packages/circuits/README.md`).

### Problem

A depositor cannot exit a position before the market resolves. A bet is a FOK BUY; value only returns to the note via settlement, FOK-failure cancellation, or N/A cancellation. Active traders need to realize gains or cut losses mid-market.

### Design (mirror of Settlement Credit)

Closing means the Signing Layer submits a FOK SELL of the user's shares of `position_id` at a user-chosen limit price. Proceeds (pUSD then USDC via offramp) return to the pool, and the user's note is credited. The note mechanics are identical to `settlement_credit`: spend the post-bet note, prove tree membership, recommit `balance + proceeds`.

The mid-market sell price is set by the off-chain CLOB fill and is NOT derivable from CTF on-chain state. So `proceeds` cannot be made trustless the way `payout_per_share` is. v1 sources it from an operator report, the same trust class already accepted by `acknowledgePolymarketReturn` (`Vault.sol`). v2 moves to an on-chain `OrderFilled` event proof or a TEE-attested value.

### v1 scope

- **Full and partial sells both supported in v1.** A partial sell splits one bet record into a sold portion (credited) and a remaining portion (still `FILLED` against fewer shares). The remainder pattern reuses the change-note construction already present in `withdrawal.nr`.
- Proceeds are operator-reported and Vault-injected. The user cannot alter them in the proof.

### Implementation outline (spec-level)

- New `BetStatus` values: `CLOSING` (set when the operator accepts a close request, blocks a settlement race and double-close) and `CLOSED_CREDITED` (set after the credit proof is verified). For partial sells, a partially-closed record returns to `FILLED` with a reduced `expected_shares`.
- New `BetRecord` field `sell_proceeds` (uint64, Vault-injected), and `sold_shares` for partial accounting.
- New operator-only `reportSold(bytes32 nullifier_of_bet, uint64 sold_shares, uint64 proceeds)` (mirror of `reportFilled`). Operator-restricted for the same reason `reportFOKFailure` is: a false report would let a user credit funds not actually realized.
- New circuit `position_close.nr`: private `(secret, balance_before_credit, nonce, merkle_path, merkle_path_indices, owner_address)`; public `(merkle_root, nullifier, new_commitment, nullifier_of_bet, sell_proceeds)`. Constraints identical to `settlement_credit` with `total_credit -> sell_proceeds`.
- New `Vault.closePosition(bytes proof, ClosePublicInputs inputs)`: nullifier-spent check first, known-root check, look up bet record, require `status == FILLED`, require `marketResolvedAt[circuit_key] == 0` (resolved markets use settlement, not close), inject `sell_proceeds`, verify, update status.
- FOK-fails-to-sell edge: nothing was debited for the sell attempt, so the position simply stays open. No recovery proof needed.

### Privacy note

A SELL from the vault EOA is publicly visible on Polymarket, exactly like the BUY, consistent with the public-bet-content model (Q6/T1). The close proof reveals `nullifier_of_bet`, but `creditSettlement` already reveals the same value, so no new linkage is created. Close requests must go through the relay, never the user's wallet (T19).

### Touches that need Project Agent sign-off at implementation time

New circuit, new public inputs, new bet statuses, new operator trust instance. All approved in direction here; confirm exact public-input ordering against the verifier before codegen.

---

## FC-2: Mandatory deposit binding proof

**Status:** IMPLEMENTED (2026-05-30) — Circom/groth16
**Driver:** T20 (CRITICAL), see `threat-model.md`
**Solution:** Mandatory deposit ZK proof (no commitment-formula change)

> **As built:** Circom circuit `packages/circuits/groth16/deposit.circom` (3 public
> inputs: `commitment, amount, owner_address`), snarkjs Groth16 verifier
> `DepositVerifier.sol` at verifier slot `DEPOSIT = 5`. `Vault.deposit` signature
> changed to `deposit(bytes proof, bytes32 commitment, uint256 amount)`. Frontend
> generates the proof in `ClosePositionModal`/`deposit/page.tsx` before the Vault tx.
> The spec below references Noir `.nr` for historical context only; the live build is
> Circom + snarkjs (see `packages/circuits/README.md`).

### Problem

`Vault.deposit(bytes32 commitment, uint256 amount)` transfers `amount` USDC but cannot read the hidden `balance` inside `commitment`. No circuit ties committed `balance` to deposited `amount` (every circuit only checks balances relatively). A depositor can deposit 100 USDC with a commitment that opens to a 200 USDC balance, then withdraw 200, draining the shared pool. `owner_address` is likewise unbound at deposit, so W-to-W is unenforced at entry. This is a direct, unprivileged loss-of-funds bug.

### Solution: re-instate the deposit proof as MANDATORY

The "Proof 1: Deposit" that prior docs called optional/trivial is load-bearing for soundness. The goal is not hiding the amount; it is binding the hidden `balance` and `owner_address` to the public `amount` and `msg.sender`.

### Implementation outline (spec-level)

- New circuit `deposit.nr`: private `secret`; public `(commitment, amount, owner_address)`; constraint `commitment == Poseidon4(secret, amount, 0, owner_address)`. Tiny circuit (one hash, no Merkle path), fast to prove.
- `Vault.deposit` becomes `deposit(bytes proof, bytes32 commitment, uint256 amount)`. The Vault calls the deposit verifier with public inputs `(commitment, amount, uint256(uint160(msg.sender)))`. This forces `balance == amount`, `nonce == 0`, and `owner_address == msg.sender`, with `secret` still private.
- Register a new verifier slot (`DEPOSIT = 5`) in the `verifiers` mapping.
- No change to the Poseidon4 commitment formula or to the four existing circuits.

### Rejected alternatives

- Contract-computed commitment (compute the leaf on-chain from on-chain `amount`/`msg.sender`): binds correctly but changes the commitment construction and needs a wider on-chain Poseidon. More invasive than the deposit proof for no benefit.
- Global "total committed == total deposited" invariant: uncheckable per-note without revealing balances, and the global USDC balance check only fails after the theft. Not a defense.

### Follow-ups on implementation

- `CLAUDE.md` deposit decision and proofs table updated to mandatory deposit proof (done in this pass).
- `zk-design.md` "Proof 1: Deposit" rewritten from optional/trivial to mandatory soundness proof (pending the broader `zk-design.md` reconciliation).

---

## FC-3: Merkle root history scaling for throughput

**Status:** IMPLEMENTED (2026-06-03) — Solidity, contract-only
**Driver:** T8 (clarified), see `threat-model.md`
**Solution:** Replace the 30-root linear-scan window with a 1024-root O(1) `mapping` window

> **As built:** `CommitmentMerkleTree.sol` window machinery rewritten. `ROOT_WINDOW = 1024`
> (was `HISTORY_SIZE = 30`). Membership is now `mapping(bytes32 => bool) knownRoots` (single
> SLOAD in `isKnownRoot`); eviction uses `mapping(uint256 => bytes32) rootRing` keyed by
> `seq % _rootWindow()` with a dedicated `uint64 rootCount` sequence counter. The old
> `recentRoots[30]` + `currentRootIndex` were removed; a new `bytes32 public currentRoot`
> is the single source of truth for the latest root. Window size is an `internal virtual
> _rootWindow()` so a test subclass (`SmallWindowTree`, window 4) exercises eviction without
> 1024+ inserts. Decisions taken at build time: **A2** (clean `currentRoot` getter; the one
> dead off-chain reader `fetchCurrentMerkleRoot` in `frontend/src/lib/api.ts` was repointed at
> `currentRoot()` and its `% 30` hardcode dropped) and **B2** (frozen-layout rule waived
> pre-mainnet → fresh redeploy, no migration). The live proof path is unchanged: it sources its
> root from the proof-relay's event reconstruction (`proof-relay/src/merkle.ts`), which is
> window-agnostic — the wider window simply keeps that reconstructed root valid on-chain longer.
> `knownRoots` is a `bool` (eviction-by-clear); a `mapping(bytes32 => uint256)` refcount is the
> noted mainnet-hardening option.

### Problem

The root changes on every `tree.insert` and `merkle_root` is a public input to every proof. This does NOT force one transaction per block (the rolling window handles concurrency, see T8). The real limit: a referenced root must still be among the last `HISTORY_SIZE` (currently 30) roots when the tx executes. If more than 30 inserts land between proof-build and inclusion, the proof reverts `UnknownRoot`. With 30s to 2min client proving times, 30 inserts under load is plausible, causing stale-root reverts and forced proof rebuilds.

### Solution

- Increase `HISTORY_SIZE` to a much larger value (e.g. 256). This directly widens staleness tolerance.
- Switch the root-history store from the fixed `bytes32[HISTORY_SIZE]` array with an O(HISTORY_SIZE) scan in `isKnownRoot` to a `mapping(bytes32 => bool) knownRoots` plus a ring buffer for eviction. This makes root lookup O(1) so a large window costs almost nothing per verify.

### Notes

- No circuit changes. Root handling is entirely a contract concern. Membership is monotonic and old-root-plus-old-path verifies together, so users never refresh their path mid-flight.
- The only true serialization point is per-note nullifier double-spend, which is intended and unaffected.
- Optional complements (not required): relay-side batching of submissions (also helps T18 timing privacy), and proving against an intentionally older settled root.

### Implementation outline (spec-level)

- `CommitmentMerkleTree.sol`: replace `recentRoots[HISTORY_SIZE]` scan with `mapping(bytes32 => bool) knownRoots` + `bytes32[HISTORY_SIZE] rootRing` for eviction of the oldest root on overflow; set `HISTORY_SIZE = 256`.
- Keep the constructor seeding the initial all-zero root into both structures.
- `isKnownRoot` becomes a single mapping read (still rejecting `bytes32(0)`).

---

## FC-4: Native limit orders (GTC/GTD)

**Status:** IMPLEMENTED (2026-05-31) — Circom/groth16, full mock-stack slice. Advanced-mode toggle remains gated pending live-Polymarket-API validation.
**Driver:** Q7 (REOPENED 2026-05-30), see `open-questions.md`
**v1 stays:** FOK-only for default users; limit orders ship behind an advanced toggle after live-API testing

> **As built:** Circom circuit `packages/circuits/groth16/partial_credit.circom` (5 public
> inputs: `merkle_root, nullifier, new_commitment, nullifier_of_bet, refund_amount` — the
> exact ordering against the compiled verifier), constraint-identical to `bet_cancel`;
> snarkjs Groth16 verifier `PartialCreditVerifier.sol` at verifier slot `PARTIAL_CREDIT = 7`.
> Vault adds `BetStatus.{PARTIAL_FILLED, RESTING}`, `BetRecord.{filled_shares, spent_amount}`,
> `reportResting(...)` and `reportPartialFill(...)` (operator), and `partialFillCredit(proof,
> PartialFillPublicInputs)` (inject `refund_amount = bet_amount − spent_amount`, verify,
> normalize record to a clean `FILLED`). `adminCancelBet` needs no change — it already
> requires `ACTIVE`, so `RESTING` is inherently exempt (documented in-contract). **RESTING
> shipped operator-reported (v1, no circuit change).** Backend: `submitLimitOrder` + REST
> fill-poll in the signing layer (mapping matched/partial/cancelled → reportFilled /
> reportPartialFill / reportFOKFailure), a `limit_orders` intent store + `POST /limit-order`,
> event-listener routing FOK-vs-limit by intent, mock-CLOB GTC/GTD resting simulation
> (`GET /order/:id` + `POST /admin/limit-fill`), and proof-relay `POST /relay/partial-credit`.
> Frontend: BetModal advanced order-type toggle (FOK/GTC/GTD + tick-snapped limit price),
> `PartialFillCreditModal` + portfolio "Claim refund" action surfaced on on-chain
> `PARTIAL_FILLED` (and a "Limit order live" label on `RESTING`).
>
> **Deferred (per the doc's standing rule, gated on live-API validation):** the production
> authenticated User-Channel websocket fill client and real GTC/GTD heartbeat keepalive (the
> mock stack uses REST polling + admin-driven fills instead); promotion of the advanced
> toggle from gated to general. **Recovery:** `recoverNotes` does not yet replay
> `PartialFillCredited` events — a P3+ wallet-recovery follow-up (FC-5 scope), tracked
> separately; the FC-5 recovery acceptance test is unaffected.

### Problem

v1 supports only FOK (fill-or-kill) market orders. Sophisticated traders want true limit orders that rest on the book until filled at their price. FOK was chosen specifically to avoid partial-fill accounting, so adding limit orders reopens that accounting work.

### Verified Polymarket facts (researched 2026-05-30)

- Native limit order types: `GTC` (rests until filled or cancelled) and `GTD` (auto-expires; 60-second security threshold, so effective lifetime N means `expiration = now + 60 + N`). All orders are limit orders under the hood; FOK/FAK are marketable limit orders. The `price` field on a marketable order is a worst-price/slippage limit, not a target.
- Fill reporting: synchronous `POST /order` response carries `status` (`live`/`matched`/`delayed`/`unmatched`) and `FOK_ORDER_NOT_FILLED_ERROR`. Async/resting/partial fills are delivered on the authenticated User Channel websocket `wss://ws-subscriptions-clob.polymarket.com/ws/user` as `TRADE` messages (lifecycle `MATCHED -> MINED -> CONFIRMED`, plus `RETRYING`/`FAILED`), filtered by API key. REST `GET /orders/:id` and `GET /trades` support polling.
- Heartbeat: open orders are auto-cancelled if the CLOB heartbeat lapses past 10 seconds, so a resting limit order only persists while the signing layer is alive. A signer outage cancels open limit orders. This interacts with FC (Q3 discussion) on backend availability.
- Partial fills: GTC/GTD/FAK can fill partially. This is the accounting cost.
- Post-only (maker-guarantee) is available for GTC/GTD only; batch submission up to 15 orders; orders must conform to the market tick size; multi-outcome markets need `negRisk: true`. Sports markets auto-cancel open orders at game start.
- Circuit fit: `bet_auth` already carries `price` and `expected_shares = floor(bet_amount * 1e8 / price)`, so a user limit price fits the existing circuit. The work is async fill tracking and partial-fill accounting, not the circuit math.

### Decisions (2026-05-31, Arya)

- **Flow B (pre-debit, refund-remainder) is chosen.** `authorizeBet` continues to debit the full `bet_amount` on-chain first; the order is submitted off-chain and resolved via operator reports. Flow A (place-first, debit-on-fill) is rejected for v1: it needs off-chain note reservation to prevent double-spend (a new linkage surface inside the operator) and degrades the timing-privacy model by putting vault-EOA CLOB activity before any on-chain event. Flow B is the pattern the protocol already runs for FOK, so depositor anonymity (fixed at `authorizeBet` time) is unchanged.
- **`reportPartialFill` is accepted as a new operator-trust instance.** Same trust class as `reportFilled`/`reportSold`: a false report could refund more than the truly unfilled remainder or credit shares not held. Reported values are Vault-injected so the user cannot alter them in the proof. v2 replaces it with a websocket-fill proof or a TEE-attested value, the same trust-evolution path as FC-1 `sell_proceeds`.
- **Limit orders ship behind an advanced toggle** until the full GTC/GTD lifecycle (resting, partial fill, expiry, heartbeat-driven cancel) is validated against the real Polymarket CLOB API. Default users stay on FOK. Promotion to a general feature is a later decision contingent on that testing.

### Why partial-fill accounting is unavoidable

Once an order is allowed to rest, a partial fill has already bought CTF shares on-chain that cannot be un-bought. Refunding the whole `bet_amount` on a partial-then-expired order would leave the vault out the shares; refunding nothing would cost the user funds for the unfilled portion. A correct partial-credit proof is therefore mandatory. There is no "resting orders with FOK simplicity" middle ground.

### Design (Flow B)

The partial-credit proof is constraint-identical to `bet_cancel`: spend the post-bet note, recommit `current_balance + injected_amount`, with the amount Vault-injected (not user-supplied). Its public-input shape `(merkle_root, nullifier, new_commitment, nullifier_of_bet, refund_amount)` is exactly bet_cancel's, so there is no new circuit public-input shape, only a new injected value.

What the Vault function `partialFillCredit` does beyond `betCancellationCredit` is normalize the record to a clean filled state so every downstream path keeps working: inject `refund_amount = bet_amount - spent_amount`, verify, mark the nullifier spent and insert the new commitment, then overwrite `expected_shares := filled_shares`, `bet_amount := spent_amount`, `status := FILLED`. After normalization, `creditSettlement`, `naCancellationCredit`, and `closePosition` (FC-1) all operate on a normal FILLED record with no further changes.

### Lifecycle

1. User builds a `bet_auth` proof at the limit `price`. The circuit is untouched; `expected_shares = floor(bet_amount * 1e8 / price)` is now the maximum possible fill.
2. Relay submits `authorizeBet`; full `bet_amount` is debited; record is `ACTIVE`.
3. Signing Layer reads `BetAuthorized`, submits a GTC/GTD order at `price`, and maintains the CLOB heartbeat while it rests.
4. Fills stream in on the User Channel websocket. The order terminates one of three ways:
   - **Fully filled:** operator calls `reportFilled`; record becomes `FILLED` with `expected_shares` already correct; settlement proceeds as today.
   - **Zero filled** (expired or cancelled with no fill): reuse `reportFOKFailure`; the user reclaims the full `bet_amount` via the existing `betCancellationCredit`. No new code path.
   - **Partial then terminated:** operator calls `reportPartialFill(nullifier_of_bet, filled_shares, spent_amount)`; record becomes `PARTIAL_FILLED`; the user submits `partialFillCredit`, which refunds the remainder and normalizes the record to `FILLED`.

The zero-fill case folding onto the existing FOK-failure path is why this is materially less work than a brand-new proof family.

### Circuit (MUST be Circom/groth16, not Noir/bb)

New circuit `packages/circuits/groth16/partial_credit.circom` + verifier slot `PARTIAL_CREDIT = 7` (next slot after `POSITION_CLOSE = 6`). Mirrors `bet_cancel.circom`: private `(secret, current_balance, nonce, merkle_path, path_indices, owner_address)`; public `(merkle_root, nullifier, new_commitment, nullifier_of_bet, refund_amount)`. `refund_amount = bet_amount - spent_amount`, Vault-injected from the `reportPartialFill` record. Build through the same `Benchmarking/groth16` pipeline used for deposit/position_close. Because the constraints are identical to `bet_cancel`, this is a recompile-to-new-slot, not new circuit logic.

### New on-chain surface

- `BetStatus` additions: `PARTIAL_FILLED` (operator reported a partial, awaiting the partial-credit proof) and `RESTING` (operator confirmed a live limit order; exempt from `adminCancelBet`).
- New Vault function `partialFillCredit(bytes proof, PartialFillPublicInputs inputs)` performing the inject-verify-normalize sequence above.
- New operator reports `reportPartialFill(bytes32 nullifier_of_bet, uint64 filled_shares, uint64 spent_amount)` and `reportResting(bytes32 nullifier_of_bet)`, both operator-only.
- `BetRecord` gains `filled_shares` and `spent_amount`. Prefer explicit fields over reusing the FC-1 `sold_shares`/`sell_proceeds` slots, for audit clarity.

### Operational risk: the heartbeat (dominant cost)

Polymarket auto-cancels open orders if the CLOB heartbeat lapses past ~10 seconds, so a resting GTC lives only while the Signing Layer is connected. For a v1 centralized single process this means:

- A deploy, restart, or >10s outage cancels every resting order at once. Survivable (each terminates with whatever filled and refunds the rest) but it makes signer availability a product-quality concern, not just a safety one. This reactivates the substance of the dropped Q3 (backend availability) and couples to Q14 (L2 key liveness on every heartbeat request).
- The dead-man circuit breaker composes well: on ban or halt, letting the heartbeat lapse cleanly cancels resting orders, a safe failure mode (orders die, funds refund).

Signing Layer additions: a persistent authenticated User Channel websocket client, GTC/GTD submission via the SDK, a heartbeat keepalive loop, and terminal-state detection mapping `MATCHED -> MINED -> CONFIRMED` / `RETRYING` / `FAILED` / cancel / expiry onto exactly one of the three terminal reports above.

### Cross-feature interactions to handle

- **`adminCancelBet` (TASK-L3) must not kill healthy resting orders.** Its timelock assumes `ACTIVE` means "stuck, operator never reported," but a legitimately resting GTC is also `ACTIVE` for a long time. The operator sets `RESTING` when it confirms the order is live (via `reportResting`), and `adminCancelBet` exempts `RESTING` or gives it a much longer timeout. Trust cost is nil: a malicious operator can already grief by never reporting; the worst case is locked-then-refundable funds.
- **Tick-size snapping must happen before proof generation.** `price` is a circuit public input and `expected_shares` is derived from it, so the on-chain `price` must exactly equal the tick-conformant price the Signing Layer submits. The frontend must snap the user's limit price to the market tick before building the proof, or `expected_shares` will not reconcile.
- **Price-improvement surplus uses the existing Q4 policy.** A resting order can fill at a better average price, so `filled_shares` can exceed the limit-price-implied count. Apply the Q4 v1 treatment unchanged (surplus accrues to the vault pool; cap credited shares at the price-derived amount). Do not introduce a new policy.

### Resolved vs still open

Resolved: Flow B; `reportPartialFill` trust acceptance; advanced-mode gating pending live-API testing; partial-credit realized as a recompile of the `bet_cancel` constraints to slot `PARTIAL_CREDIT = 7`; record normalization to `FILLED`; the three terminal paths.

To confirm at implementation time: exact `PartialFillPublicInputs` ordering against the compiled verifier; whether `RESTING` stays operator-reported (v1, no circuit change) or becomes a `bet_auth` public input (v2, trust-minimized, requires circuit sign-off); the live-API validation gate before the advanced toggle is enabled; re-verification of the websocket message schema, the ~10s heartbeat threshold, and the GTD 60-second threshold against the production CLOB at codegen time, per the standing rule never to assume Polymarket API behavior.

---

## FC-5: Full account recovery from chain + wallet-derived secrets

**Status:** IMPLEMENTED (2026-05-31). All four gaps closed; acceptance fixture passes.
**Driver:** Q2 discussion (2026-05-30)
**Goal:** A wallet with zero local state can reconstruct everything (balances, open positions, deposits, withdrawals, realized P&L) from on-chain data plus a wallet signature alone.

### What exists

`frontend/src/lib/notes.ts` already implements `recoverNotes()`: it scans Vault events (`Deposited` filtered by depositor, `BetAuthorized`, `SettlementCredited`, `BetCancellationCredited`, `NACancellationCredited`, `Withdrawn`), re-derives each deposit's secret from the wallet signature per deposit index, matches commitments, and replays the note chain to rebuild balances, open `BET_RECEIPT` positions, and spent state. All client-side RPC reads, no server, no privacy loss.

### Foundation: wallet-derived secrets (P3+)

Recovery only works because secrets are deterministic in P3+. The derivation is a protocol constant:

`secret = keccak256(wallet.signMessage("PolyShield deposit derivation\nAddress: {W}\nIndex: {i}\nVersion: 1")) mod p`

The message string and version must never change after mainnet deployment. In P1/P2 (random secrets) a cache wipe is unrecoverable without the ECIES backup, so the "rebuild everything from chain + wallet" guarantee is conditional on P3+. Recommendation: make P3+ the default before relying on recovery, and treat the encrypted backup as the only fallback for P1/P2 notes.

### Gaps to close so EVERYTHING actually rebuilds

1. **Activity feed and realized P&L.** `accountState.ts` computes P&L from the `polyshield:activity` localStorage log, which `recoverNotes` does not rebuild. After a wipe, balances and positions return but the activity feed and realized P&L do not. Fix: derive the activity log and P&L entirely from the same on-chain events plus `pendingCredit`, and treat localStorage purely as a cache, never a source of truth.
2. **Scan bound.** `recoverNotes` has `maxIndex` (default 10). Replace with "scan until N consecutive empty deposit indices" so users with many deposits are fully covered.
3. **Exact balances after fees (P2).** `inferBalanceFromCommitment` deliberately returns null (a balance cannot be brute-forced). Balances are replayed from event deltas (`bet_amount`, `expected_shares * payout`). Once fees exist, events must carry the net/fee delta so the replay stays exact; otherwise a fee'd balance cannot be reconstructed. Bake this into the fee work (P2).
4. **Real timestamps.** Recovered notes use `createdAt = Date.now()`. Use the event block timestamp so the rebuilt activity feed shows correct history.

### Acceptance criteria (MET — 2026-05-31)

`packages/frontend/src/lib/__tests__/recovery.acceptance.test.ts` covers:
- deposit→bet→full close: balance, `position_id`, real block timestamps, activity P&L
- gap-scan: deposits past an empty index are found
- partial close: receipt shares reduced, receipt stays open

Run: `cd packages/frontend && pnpm test`

---

## FC-6: Bounded working-buffer collateral deployment (not per-deposit, not per-bet)

**Status:** Direction approved; deposit-at-rest already implemented, buffer policy + on-chain cap not built
**Driver:** Q3/Q4 discussion (2026-05-30); `collateral-flow-audit.md` BUG-C1
**Goal:** Keep bet fills instant while bounding how much user capital is ever exposed on Polymarket.

### Current state (verified against code)

- `Vault.deposit(commitment, amount)` stores USDC at `address(this)`. It does NOT convert to pUSD or fund the deposit wallet. Deposits rest as USDC in the Vault.
- `fundPolymarketWallet(amount)` is a separate operator-only bulk call (USDC -> onramp -> pUSD -> deposit wallet), incrementing `deployedToPolymarket`. Nothing calls it per-deposit or per-bet.
- `eventListener` submits the FOK order assuming the deposit wallet already holds pUSD buying power; it does not onramp per bet.

So the per-bet onramp latency/fee problem does NOT exist, and the whole fund is NOT in-flight by default. Good. Two gaps remain.

### Gap 1: no bound on in-flight capital

`fundPolymarketWallet` is unbounded operator discretion. A compromised operator (Q4) could pull the entire Vault into the deposit wallet, then drain it. Fix: add a governance-set `maxInFlight` ceiling; `fundPolymarketWallet` reverts if `deployedToPolymarket + amount > maxInFlight`. This caps both the key-compromise blast radius (Q4) and the maximum stuck capital (Q3) to the buffer, never the whole Vault. The at-rest majority stays ZK-protected.

### Gap 2: no buffer management policy

Funding is manual. Define an off-chain buffer manager: watch the deposit wallet's pUSD balance and pending bet demand; top up via `fundPolymarketWallet` when below a low-water mark, up to a high-water mark, subject to `maxInFlight`. Replenishment is bulk and asynchronous, never per-deposit and never per-bet, so fills stay instant. Settled winnings offramp back to the Vault, so the buffer naturally drains; during an incident the operator stops topping up and the buffer bleeds back to the at-rest pool on its own.

### Trade-off knob

Buffer size. Larger = always-instant fills, more exposed/stuck capital. Smaller = less exposure, but risk of FOK failures when burst demand exceeds buffer + top-up latency. `maxInFlight` is the on-chain ceiling; the target buffer is the operator's day-to-day setting under it.

### Implementation outline (spec-level)

- Vault: add `maxInFlight` (governance-mutable) and the revert guard in `fundPolymarketWallet`.
- Backend: buffer manager service (low/high-water policy) driving `fundPolymarketWallet`.
- Wire the real onramp end to end (BUG-C1/C4 in `collateral-flow-audit.md`); today the mock wires onramp to `address(0)`.

### Relationships

Bounds the blast radius for Q4 (key fencing) and the stuck-capital ceiling for Q3 (escape hatch / `sweepResolvedToVault`). Independent of FC-2 (deposit proof) but both touch `deposit`/funding code.

---

## FC-7: JIT (just-in-time) collateral deployment — Option 3

**Status:** IMPLEMENTED 2026-06-01 (mock stack; mainnet-ready via the relayer/proxy abstraction)
**Driver:** `collateral-deployment-strategy-comparison.md` Option 3; readiness for a live Polymarket money-path test with the smallest possible at-risk capital.
**Goal:** Deploy collateral only at bet time so almost nothing is ever exposed or stuck, while reusing the exact production deposit-wallet model (proxy + relayer) so the same code serves the live mainnet test.

### What was built

- **Per-bet JIT funding.** `packages/backend/signing-layer/src/jitFunding.ts` (`ensureDepositWalletFunded`) reads the deposit wallet's pUSD balance before each order; if it is short of `bet_amount`, it calls `Vault.fundPolymarketWallet(shortfall)` (operator-only, already present) and waits one confirmation. Wired into `submitFOKOrder` and `submitLimitOrder` in `orderBuilder.ts`. A funding failure (DeployCapExceeded / InsufficientVaultLiquidity) is reported as a recoverable FOK failure — the note is reclaimable via `betCancellationCredit`, never silently debited. Calls are serialized so concurrent bets don't double-read the balance.
- **Residual buffer (the Option-3 → Option-4 stepping stone).** On a FOK no-fill the JIT-funded pUSD is **left in the deposit wallet**, not swept back. The next bet's balance check reuses it and onramps only the new shortfall, so exposure accretes toward a small self-provisioned base buffer. `deployedToPolymarket` grows on funding and is decremented at settlement by `acknowledgePolymarketReturn` (measured USDC delta, clamped); the SEC-007 `deploymentCap` is the on-chain ceiling.
- **Deposit-wallet proxy + relayer abstraction (closes H2/H3).** `packages/backend/signing-layer/src/depositWalletExecutor.ts` (`DepositWalletExecutor`: `execute` / `executeBatch` / `ensureApprovals`) with three impls: `MockRelayerExecutor` (local), `PolymarketRelayerExecutor` (production, thin placeholder pending live-API validation), `EoaExecutor` (legacy fallback). Redemption/settlement (`redemptionPipeline.ts`) and the one-time pUSD approvals (`index.ts`) now run through it, so the same path serves mock and mainnet. Mock twin: `MockDepositWallet.sol` (relayer-gated `execute`/`executeBatch`) + the `POST /relayer/wallet-batch` route in the mock CLOB server. `MockDeploy.s.sol`/`mock-env` deploy the proxy and point `Vault.depositWallet` at it; the mock CLOB debits the proxy's pUSD on fill so fills consume the buffer and no-fills leave residual.

### Successor

This is the on-ramp to **Option 4 (base buffer + JIT overflow)** — the planned direction. Option 4 adds a low/high-water buffer manager (FC-6) that proactively maintains the buffer in bulk instead of relying on per-bet accretion, bounded by the same `deploymentCap`/`maxInFlight` ceiling. No circuit or note-structure change is involved in either FC-6 or FC-7.

### Relationships

Builds directly on FC-6 (bounded working-buffer): FC-7 is the per-bet funding mechanism, FC-6 is the bulk buffer policy that supersedes it. Reuses the `fundPolymarketWallet`/`acknowledgePolymarketReturn`/`deploymentCap` primitives. Closes `collateral-flow-audit.md` H2 (relayer WALLET batch) and H3 (one-time approval).

---

## FC-8: Note consolidation (multi-note merge)

**Status:** IMPLEMENTED — Circom/groth16
**Driver:** UX — fragmentation is unspendable (every spend circuit is single-input)
**Decision:** standalone `consolidate` circuit, K=4, with frontend auto-merge before a big spend

### Problem

Every circuit is strictly single-input-note → ≤1 output. A user whose balance is split across several notes (e.g. $100/$50/$75 from multiple deposits) cannot bet or withdraw more than the largest single note ($100) — there is no circuit or Vault function that combines notes. Bad UX, especially for betting.

### Design

A new circuit `packages/circuits/groth16/consolidate.circom` (`Consolidate(4)`) spends up to **4 same-owner notes** and emits **one** merged note whose balance is the sum, continuing **slot 0's lineage** (`secret[0]`, `nonce[0]+1`). Pure value-preserving merge: no bet, no withdrawal, no token movement. `bet_auth`/`withdrawal` are unchanged; the frontend auto-merges fragmented notes (greedy largest-first, up to 4) before a bet/withdrawal that exceeds the largest single note, then runs the normal single-input flow on the merged note (two txs for the fragmented case).

**Public inputs (6):** `merkle_root, nullifier[0..3], new_commitment`. Verifier slot `CONSOLIDATE = 8`.

**Padding soundness (fixed-size circuit, variable real inputs):** `is_active[j]` is a strict boolean; an active slot enforces Merkle membership gated by `is_active[j]*(root_j − merkle_root) === 0` and publishes its real nullifier `nullifier[j] === is_active[j] * Poseidon2(secret,nonce)`; an inactive slot contributes `eff[j] = is_active[j]*balance[j] = 0` and publishes `nullifier[j] = 0` (the Vault's skip sentinel). `is_active[0] === 1` forbids an all-inactive forge. The summed balance is range-checked u64. **Double-counting one note in two active slots is blocked ON-CHAIN:** both slots publish the same nullifier and the second `markSpent` reverts `AlreadySpent`, so the Vault MUST mark every non-zero nullifier spent without de-duplication. ~34k constraints (well under the 2^17 ptau).

### As built

- Circuit `consolidate.circom` + snarkjs Groth16 verifier `ConsolidateVerifier.sol` (slot 8), registered in `Benchmarking/groth16/src/constants.ts`/`interfaces.ts` (with a multi-leaf fixture builder in `generateTestProofs.ts`). An `ONLY_CIRCUIT` env filter was added to the pipeline CLIs so a single circuit can be (re)built in isolation without re-keying the others.
- Vault `consolidate(bytes proof, ConsolidatePublicInputs inputs)` (`bytes32[4] nullifier`), `Consolidated(bytes32[4] nullifiers, bytes32 new_commitment)` event, `EmptyConsolidation` guard, slot constant `CONSOLIDATE = 8`. No `betRecords`, no token movement. Wired into `MockDeploy`/`MockAcceptVerifiers`.
- Proof relay `POST /relay/consolidate` + `relayConsolidate`. Frontend `generateConsolidateProof` (array witness) + worker case; `selectNotesForAmount` (notes.ts); `consolidateNotes` orchestration (`lib/consolidate.ts`); consolidate-then-act in `BetModal` + withdraw page.
- Recovery (`notes.ts`) replays a `Consolidated` event via a two-pass scheme (discovery populates a `balanceByNullifier` map; final pass merges slot-0's lineage and ends contributors). FC-5 acceptance test extended. **Limitation:** nested consolidations (re-consolidating a merged note) are not tracked by the discovery pass — accepted v1 limitation.

### Tests

`RealVerifier.t.sol` (real proof verifies on-chain), `Vault.t.sol` consolidate suite (happy 2/4-active, duplicate-nullifier revert, already-spent, unknown-root, zero-slot0, invalid-proof, paused, no-token/no-betRecord), recovery acceptance test (deposit×2 → consolidate → bet → recover).

---

## FC-9: Gasless operator reporting (EIP-712 fill attestations)

**Status:** IMPLEMENTED
**Driver:** cost — the operator paid one on-chain tx per bet terminal event (`reportFilled`/`reportFOKFailure`/`reportResting`/`reportPartialFill`/`reportSold`); at scale this is large protocol-borne gas, and a slow-filling limit order generated several reports before the user ever acted.
**Decision:** replace on-chain operator pushes with OFF-CHAIN EIP-712 attestations the user submits at action time.

### Design

The operator no longer pushes fill status on-chain. It signs an **`OperatorAttestation`** off-chain (EIP-712) and the user submits that signature with their credit/cancel/settle/close proof; the Vault recovers the signer, requires it equals `signingLayerOperator`, and uses the attested values. Operator reporting now costs the protocol **zero gas** (the cost folds into the user's own credit tx, which they pay anyway), and a slow-filling order needs **no interim on-chain writes** — only the single terminal attestation, consumed at action time, matters. Abandoned losing bets cost nothing (no one acts). Trust model is unchanged (operator-attested values), matching the documented v2 TEE-attested-value path.

**Struct:** `OperatorAttestation { bytes32 nullifierOfBet; uint8 reportType; uint64 amountA; uint64 amountB; }` — `reportType` 1=FILLED, 2=FAILED, 3=PARTIAL (A=filled_shares, B=spent_amount), 4=SOLD (A=sold_shares, B=proceeds). EIP-712 domain `{name:"Polyshield", version:"1", chainId, verifyingContract: Vault proxy}` (set by `initializeV2()` reinitializer; `EIP712Upgradeable` uses ERC-7201 storage so it does not disturb the frozen layout/`__gap`).

**The five `report*` functions are REMOVED.** On-chain `BetStatus` is now advanced only by `authorizeBet` (→ACTIVE) and the credit functions. Per-function gates:

| Function | Gate | Notes |
|---|---|---|
| `creditSettlement` | `FILLED` (no att) **or** `ACTIVE` + FILLED att | shares_held from `expected_shares`; payout from on-chain `pendingCredit` |
| `betCancellationCredit` | `FAILED` (no att) **or** `ACTIVE` + FAILED att | refunds `bet_amount` |
| `naCancellationCredit` | `FILLED\|FAILED` (no att) **or** `ACTIVE` + FILLED/FAILED att | on-chain CTF N/A check unchanged |
| `partialFillCredit` | `ACTIVE` + PARTIAL att | inject filled/spent from att; strict-partial; normalize → FILLED |
| `closePosition` | `ACTIVE\|FILLED` + SOLD att (amountA == expected_shares) | inject proceeds; emits `BetSold` then `PositionClosed`; market must be unresolved |

**Double-credit safety:** terminal statuses (`CREDITED`/`CANCELLED_CREDITED`/`CLOSED_CREDITED`) are reachable once each and never reset; the post-bet note nullifier is single-use. The ONLY transition into on-chain `FILLED` is `partialFillCredit`'s normalization (after consuming a real PARTIAL att) — which is what makes the no-attestation FILLED branches safe.

### HARD INVARIANT (load-bearing)

The operator MUST sign **exactly one** terminal attestation per bet. The on-chain guards prevent replaying the *same* signature (single-use note + terminal status) but **cannot adjudicate two *different* valid signatures for one bet** — a user would pick whichever pays most (e.g. a PARTIAL + a FILLED). Enforced off-chain by a **single-write** attestation store (`signing-layer/src/attestationStore.ts`: `INSERT … ON CONFLICT DO NOTHING`, never re-sign). The chain is only a backstop. See `threat-model.md`.

### `adminCancelBet` change

Under gasless reporting an unclaimed-but-filled bet stays `ACTIVE` on-chain, so "ACTIVE == stuck" is no longer true and a banned operator can still *sign* off-chain (a ban blocks order placement, not local signing). `adminCancelBet` is therefore now an **owner-trusted last resort** for a permanently-gone operator, with the timelock floor raised to **3 days** (default 7 days via `initializeV2`); the owner must confirm off-chain that no fill/attestation occurred before cancelling. Bounded by the existing owner-upgrade trust.

### As built

- Vault: `EIP712Upgradeable` + `ECDSA`, `OperatorAttestation` struct + typehash + `_verifyOperatorAttestation`/`_checkAttestation`, `initializeV2()` reinitializer, the per-function gates above, removed `report*`, longer `adminCancelBet` timelock.
- Signing layer: `attestationStore.ts` (single-write sqlite), `orderBuilder.ts` signs+persists instead of sending report* txs, `eventListener` catch-up dedupes on the attestation store, `autoSettlement` `GET /attestation/:nullifier` (public read; nullifier already public).
- Proof relay: the 5 credit routes accept optional `attestation`+`signature` and thread them to the Vault; the settlement pre-flight is relaxed (ACTIVE + attestation is valid). Frontend: `fetchAttestation`, attestation-threaded relay calls, modals (PartialFill/Close/Settlement) read injected values from the attestation, portfolio surfaces "Claim refund" from a PARTIAL attestation.

### Tests

`Vault.t.sol` attestation suite: forged-sig revert, wrong-type revert, cross-bet revert, partial-then-settle two-stage, double-credit blocked, `initializeV2` once-only; the existing credit/cancel/close/partial/settlement tests reworked onto the attestation flow. `Upgrade.t.sol` validates the V2 upgrade preserves storage.

---

## FC-10: Protocol fees (bet fee, withdrawal fee, relay-gas reimbursement)

**Status:** IMPLEMENTED (2026-06-06) — Circom/groth16 (bet_auth 9→10 public inputs) + Solidity (Vault) + frontend. Testing-round rates.
**Driver:** revenue + relay-gas cost recovery, without breaking the privacy invariant.

### Decision (George, 2026-06-06)
- **Bet fee:** 0.05% of every bet (`betFeeBps = 5`), to the `feeRecipient` (owner/governance). Minimum bet `$1` (Polymarket order floor).
- **Withdrawal fee:** flat `$0.10` per withdrawal (testing value; was framed as `$10`), to the `feeRecipient`. Minimum withdrawal `$1` (testing).
- **Relay gas:** charged in **USDC from the note** (folded into the bet fee as `relayGasFeeUSDC`), NOT as a native-POL transfer from the user's wallet. The native-POL-to-relayer option was rejected because it re-links wallet↔bet on-chain and adds a second user-wallet tx (only `deposit()` should ever come from the user's wallet — T19). `relayGasFeeUSDC` defaults to 0; governance sets the live rate.

### Why the bet fee is in the circuit but the withdrawal fee is not
The hidden note balance is only enforceable inside the circuit (the Vault never sees it), so any fee taken *from that balance* must be a term in the circuit's balance equation. The withdrawal payout is USDC the Vault sends directly, so its fee is contract-only (`transfer(recipient, amount - withdrawalFeeUSDC)`).

### Anti-forgery
`fee` is a **Vault-injected public input** to `bet_auth` (not user-supplied). The Vault computes `fee = bet_amount*betFeeBps/10000 + relayGasFeeUSDC` from `feeConfig` and passes it to the verifier; a proof built with any other fee yields a `new_commitment` that fails verification. Identical pattern to the injected `bet_amount` for cancellations. Applies to all order types (FOK/FAK/GTC/GTD) — they all funnel through `authorizeBet`.

### Implementation
- **Circuit** `groth16/bet_auth.circom`: +1 public input `fee` (range-checked), `new_balance = current_balance - bet_amount - fee`. Public signals 9→10. Verifier + zkey/wasm regenerated; `Benchmarking/groth16/src/constants.ts` `bet_auth: 9→10`; `RealVerifier.t.sol` asserts 10 inputs.
- **Vault:** packed `FeeConfig feeConfig` + `uint256 feeAccumulator` state (appended; `__gap` 50→47). `authorizeBet` computes/injects the fee, enforces `minBet`, accrues `feeAccumulator`. `withdraw` enforces `minWithdrawal` and skims `withdrawalFeeUSDC`. New `setFeeParams(FeeConfig)` (onlyOwner) and `withdrawFees(uint256)` (onlyFeeRecipient). Defaults set in `initialize` (upgraded proxies must call `setFeeParams` once).
- **EIP-170:** the fee logic pushed the Vault ~759 B over the 24576 limit. Resolved by extracting the 8 public-input structs (to file scope) and per-proof `verify<Proof>(verifier, proof, inputs, injected)` dispatch into the external **`library VaultInputs`** (`src/VaultInputs.sol`), DELEGATECALL-linked. Vault is now 24,270 B (~306 B headroom); `VaultInputs` ~3.7 KB deployed separately. Foundry auto-links it.
- **Frontend:** `BetModal` reads `feeConfig`, computes the same fee, deducts it from the note balance, threads `fee` into the bet_auth witness, enforces `minBet`, and displays the fee + total. `withdraw` page enforces `minWithdrawal` and shows fee + net "you receive". `recoverNotesWithClient` reads `feeConfig` and reconstructs `new_balance = balance - bet_amount - fee`, with a commitment-verified fallback so bets placed before the fee was enabled still recover.

### Tests
`Vault.t.sol`: bet-fee accrual, relay-gas-bundled fee, min-bet revert/boundary, min-withdrawal revert, `withdrawFees` happy/not-recipient/over-accrued, `setFeeParams` update/not-owner/zero-recipient/min<fee, new-rate-applies; two existing withdrawal tests updated for the net payout. `recovery.acceptance.test.ts`: fee-net post-bet balance reconstruction. End-to-end: `forge script MockDeploy` deploys with the library linked and on-chain `feeConfig` reads back the defaults.

---

## FC-11: Live Polymarket market integration + settlement conditionId path

**Status (2026-06-07):** market *data* + order *placement* IMPLEMENTED (frontend + signing-layer, no contract change). Settlement on live markets is the remaining gap and needs Project Agent sign-off (touches a circuit/contract interface).

### Problem
The frontend shipped wired to **fixture markets** (`lib/devMarkets.ts` / `lib/marketsData.ts`) whose `conditionId`s are `keccak256(label)` placeholders, not real Polymarket markets. The signing layer's order builder used the on-chain synthetic `position_id` as the CLOB `tokenID`, which a real CLOB rejects. So on live mainnet the app showed mock markets and could not place real orders.

### Done — market data (frontend)
- `packages/frontend/src/lib/polymarket.ts` (server): fetches the **Gamma API** (`gamma-api.polymarket.com/markets`), filters to binary YES/NO order-book markets, maps real `conditionId` + YES/NO `clobTokenIds` + prices/volume/endDate.
- `/api/markets` (list, top by 24h volume) and `/api/markets/[condition_id]` (single + live CLOB order book) now return live data; fixtures remain only as a down-fallback. Markets list starts empty (no mock flash). `MarketEntry` gained optional `yesTokenId`/`noTokenId`/`acceptingOrders`/`source`.

### Done — order placement (signing-layer)
- `packages/backend/signing-layer/src/marketRegistry.ts`: mirrors the Gamma universe into SQLite keyed by **`toFieldSafe(conditionId)` = `BigInt(conditionId) % BN254_P`** (the exact reduction the Vault/circuit use as on-chain `market_id`), storing the real conditionId + YES/NO tokenIds. Syncs at boot + every 10 min; production-only (no-op in mock). `resolveToken(market_id, outcome_side)` → real `{tokenId, conditionId}`.
- `eventListener.processBetEvent` now takes `outcome_side` and swaps the synthetic `position_id`/`market_id` for the resolved real tokenId/conditionId before submitting (FOK/FAK/GTC/GTD all route through it). Registry miss → falls back to on-chain ids; the order then fails *recoverably* (cancellation credit).
- `orderBuilder.ts` price/size scale fix (latent bug masked by the mock): real CLOB BUYs now use `price = event.price / 1e8` (on-chain price is 1e8-scaled, see zk-design.md) and `size = event.expected_shares / 1e6` (CLOB BUY size is a share COUNT, not the USDC amount). FOK/FAK/limit only; the SELL/close path uses its own 1e6 limit-price scale (unchanged).

### REMAINING — settlement conditionId (needs Project Agent sign-off)
On-chain the bet's `condition_id` is set to the **field-safe `market_id`** placeholder (see CLAUDE.md "NOTE ON `BetRecord.condition_id`"). `Vault.resolveMarket` verifies payouts via `ctf.payoutNumerators(conditionId)`; with the reduced value as the key it won't match the real CTF condition, so `creditSettlement` / `naCancellationCredit` cannot verify for live bets. Closing this requires carrying the **real `conditionId`** to `resolveMarket` and `betRecords.condition_id` — most cleanly by adding `condition_id` as a `bet_auth` public input (BetAuthPublicInputs), which is a ZK circuit interface change (sign-off required). Until then: order placement works, settlement does not.

### Live-validation checklist (small real funds, before trusting live betting)
- Registry warmed (`market registry sync complete { upserted: N }`) before betting — bets in the first-sync window fail recoverably.
- JIT funding succeeds (deposit wallet funded), POLY API creds valid, deposit-wallet approvals set (H3), builder config correct.
- FAK partial-fill accounting (`filledShares`/`spentAmount`) against the real CLOB response shape.
- Order price within tick + size precision accepted by the CLOB.

---

## FC-12: Backend indexing/cache/recovery layer + CTF-ABI fix + RPC resilience (IMPLEMENTED 2026-06-10)

Status: **implemented** (mainnet test phase). Cross-cuts contracts, signing-layer, proof-relay, and frontend. Motivated by getting deposit→bet→claim→settle→withdraw working end-to-end on a real RPC, and by the discovery that clients re-scanning the chain is both slow and impossible on a metered RPC.

### Problem
1. **`resolveMarket` reverted on mainnet.** The code read CTF payouts via `payoutNumerators(conditionId) → uint256[]` (an array getter that exists only on the test `MockCTF`). The real Gnosis CTF exposes the **element accessor** `payoutNumerators(conditionId, index) → uint256` + `getOutcomeSlotCount`. So settlement never reached the chain.
2. **Settlement was never triggered.** The resolver relied on a live `ctf.on("ConditionResolution")` subscription, which silently dies on filter-less public RPCs → `resolveMarket` was never called → `pendingCredit`/`marketResolvedAt` stayed 0 → the frontend never showed "ready to settle".
3. **Per-request chain scans.** Every proof (claim/settle/withdraw) rebuilt the whole Merkle tree from `LeafInserted` history via `eth_getLogs`, and recovery/explorer each re-scanned all events — devastating at scale and impossible under Alchemy free's **10-block `eth_getLogs` cap** / pruned public nodes.

### Solution (all implemented)
- **CTF ABI fix.** `interfaces/ICTF.sol` → element accessor + `getOutcomeSlotCount`; `Vault.resolveMarket` and `VaultLogic.naCancellationCredit` loop `i ∈ [0, getOutcomeSlotCount)`; `MockCTF` mirrors the real ABI (array setter kept for tests). Needed a UUPS upgrade (`script/UpgradeVault.s.sol`). `resolveMarket` also reordered to run **before** the redemption pipeline so a redeem failure never blocks user settlement.
- **Settlement resolver** (`signing-layer/settlementResolver.ts`): keep `ctf.on` (dev/filter-RPCs) **filtered to the vault's own `tracked_markets`** (the CTF event is global — unfiltered it stormed the RPC trying to resolve every Polymarket market), PLUS a **poll fallback** over `tracked_markets` using the CTF `payoutDenominator` *state* read (works on pruned/filter-less RPCs). `tracked_markets` (`trackedMarkets.ts`) is populated per-bet by the event-listener (raw conditionId from the market registry) — no historical `getLogs` needed to know the vault's markets.
- **Proof-relay backend index/cache** (see `architecture.md` §2.4): `CachedMerkleTree` (→ `/merkle-path`, O(32), per-leaf root check vs `LeafInserted.newRoot`) and `VaultEventIndex` (→ `/recovery-data/:depositor` and `/events`), both windowed + cursor-persisted + chunk-env, SQLite `merkle.db`.
- **Frontend** consumes the backend: `recoverNotesViaBackend` (shim-client feeding the unchanged replay; secret-matching stays client-side), the Explorer (`/api/events`), and merkle paths — none scan the chain. Reads use a resilient `ethCall` (retries 429, never fabricates state).
- **RPC resilience:** `RetryingJsonRpcProvider` (single 429-retry layer, all methods) in signing-layer + proof-relay; chunked/cursor-persisted/de-nested scans; event-listener cursor advances to the scanned head + persists in the data volume (was re-scanning a huge range every 15s). `LOG_SCAN_CHUNK` env (=10 for Alchemy free).

### Operational requirement (see architecture.md §2.5)
Production needs a **full/archive RPC with a usable `eth_getLogs` range** — Alchemy free (10-block cap) and pruned public nodes are not viable. Free-tier testing works with `LOG_SCAN_CHUNK=10` (one-time scans grind but complete; they resume via the persisted cursor).

### Privacy
The backend index serves only PUBLIC, anonymous on-chain data. It cannot link spends to a wallet (no secret server-side; only `Deposited` is wallet-keyed) and cannot forge notes (the client's replay only acts on events matching its own derived nullifier). Worst case from a bad backend = *incomplete* recovery.

### Remaining / hardening
- Client-side trust check: verify the served `currentRoot` against the on-chain tree (not yet wired).
- Past `MarketResolved` events aren't back-indexed for the Explorer (the event-index cursor finished before that event type was added); resets re-scan. Recovery is unaffected.
- The local note cache can desync from chain if a settle tx lands but the tab is reloaded mid-flight before localStorage updates (shows a settled bet as "pending"); **Restore** reconciles it.
