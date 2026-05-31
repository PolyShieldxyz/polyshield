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

**Status:** Approved, not implemented
**Driver:** T8 (clarified), see `threat-model.md`
**Solution:** Bump `HISTORY_SIZE` and switch `isKnownRoot` lookup to a much larger window with O(1) lookup

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
