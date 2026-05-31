# Design Memo: Position Exit, Deposit Binding, Compliance Disclosure, Merkle Throughput

**Author:** Project Agent
**Date:** 2026-05-30
**Status:** Analysis + recommendations. Three items need Arya sign-off (flagged inline).
**Scope:** Four questions raised by Arya. Two surface new tracker items (Q24, Q25), one surfaces a CRITICAL threat (T20), one is a clarification of existing design (T8 / root window).

> Doc-consistency note: `zk-design.md` and `open-questions.md` still describe the deprecated 3-field note (Poseidon3, Noir/UltraPLONK). The authoritative current state is `CLAUDE.md` + the deployed contracts: 4-field note `Poseidon4(secret, balance, nonce, owner_address)`, Circom/Groth16, W-to-W withdrawal. This memo is written against the real `Vault.sol` and `packages/circuits/*/src/main.nr`. `zk-design.md` should be reconciled separately.

---

## Q1 (new tracker Q24) - Selling / closing an authorized position before settlement

### What exists today

There is no exit path. A bet is a FOK BUY of outcome shares. `authorizeBet` debits the note (`new_balance = current_balance - bet_amount`, `bet_auth/src/main.nr` step 5) and the Deposit Wallet receives `expected_shares`. Value only returns to a note through three flows, all terminal at resolution or failure:

- `creditSettlement` - market resolved, requires `status == FILLED` and `resolveMarket` already called.
- `betCancellationCredit` - FOK never filled (`status == FAILED`).
- `naCancellationCredit` - market voided N/A.

So a depositor who bought YES at 0.40 and now sees 0.70 cannot realize the gain, and one who wants to cut a loss cannot. This is the active-management gap behind Q5 ("open positions are locked until settlement"). For the target user (sophisticated traders), buy-and-hold-to-resolution is a real product limitation, not a footnote.

### Design: a "Position Close" proof type (mirror of Bet Authorization)

Selling on Polymarket means the Signing Layer submits a FOK SELL of the user's `expected_shares` of `position_id` at a user-chosen limit price. Proceeds (pUSD, then USDC via offramp) return to the pool, and the user's note must be credited.

The note mechanics are the exact mirror of `settlement_credit`: the user spends their post-bet note (`nullifier = Poseidon2(secret, nonce_after_bet)`), proves it is in the tree, and creates `new_commitment = Poseidon4(secret, balance_after_bet + proceeds, nonce+1, owner)`. `nullifier_of_bet` is the lookup key into `betRecords`.

The one hard part is **who supplies `proceeds`**. This is where closing differs from settlement:

- Settlement is trustless: `payout_per_share` is read from CTF on-chain state (`resolveMarket` verifies it against `ctf.payoutNumerators/Denominator`). The user cannot inflate it; the Vault injects it.
- A mid-market SELL price is set by the off-chain CLOB fill. It is **not** derivable from CTF state. So the Vault must learn `proceeds` from somewhere.

#### Options for sourcing `proceeds`

| Option | Mechanism | Trust delta | Verdict |
|---|---|---|---|
| A. Operator-reported | New operator-only `reportSold(nullifier_of_bet, proceeds)` (mirror of `reportFilled`) writes proceeds into the bet record; Vault injects it into the close circuit, user cannot change it | Adds operator trust: a malicious operator can under-report proceeds and skim the delta. Same trust class as `acknowledgePolymarketReturn` already accepts | Recommended for v1 |
| B. On-chain fill proof | Indexer/Vault parses the CTF Exchange V2 `OrderFilled` event for the SELL and verifies the pUSD delta to the Deposit Wallet | Trustless, but requires reliable event-to-bet attribution and an on-chain event verifier. Heavy | v2 target |
| C. TEE-attested proceeds | v2 TEE signer reports proceeds from inside the enclave | Trust reduces to TEE attestation, consistent with the v2 roadmap | Folds into v2 |

Recommendation: **Option A for v1, Option B/C for v2.** Note that v1 already trusts the operator for `acknowledgePolymarketReturn` (see the explicit TRUST comment in `Vault.sol:266-271`), so `reportSold` does not introduce a new *class* of trust, only a new instance. It should be documented in the trust model alongside it.

#### Contract / circuit shape (specification only - implementation is Claude Code's job)

- New `BetStatus.CLOSED_CREDITED` (and an interim `CLOSING` set when the operator accepts a close request, to block double-close and block `creditSettlement` racing the close).
- New `betRecords` field `sell_proceeds` (uint64, Vault-injected), mirroring `bet_amount`.
- New circuit `position_close.nr`: private `(secret, balance_before_credit, nonce, merkle_path, owner_address)`; public `(merkle_root, nullifier, new_commitment, nullifier_of_bet, sell_proceeds)`. Constraints identical to `settlement_credit` with `total_credit -> sell_proceeds`.
- New `Vault.closePosition(proof, inputs)`: nullifier-spent check first, known-root check, look up bet record, require `status == FILLED`, require `marketResolvedAt[circuit_key] == 0` (cannot close an already-resolved market - use settlement instead), inject `sell_proceeds` from the record, verify, mark `CLOSED_CREDITED`.
- FOK-fails-to-sell edge: if the SELL FOK does not fill, nothing was debited for the sell attempt, so the position simply stays open. No recovery proof needed (simpler than the BUY path).

#### Partial sells

The current bet record holds `expected_shares` as one indivisible unit. A partial sell requires either (a) splitting one bet record into two, or (b) restricting v1 to full-position closes only. Recommend **full-position close only in v1**; partial close is a v2 enhancement that pairs naturally with the "Withdrawal with Change" pattern already present in `withdrawal.nr` (it recommits the remainder into a fresh note).

#### Privacy assessment (required by project rule before any privacy-relevant change)

A SELL order from the vault EOA is publicly visible on Polymarket, exactly like the BUY - consistent with the existing "bet content is public, depositor identity hidden" model (Q6/T1). The close proof reveals `nullifier_of_bet` on-chain, but `creditSettlement` already reveals the same value publicly, so **no new linkage is created** beyond what settlement already does. Net privacy impact: none. The only operational caveat is that close requests, like bet requests, must go through the relay, never the user's wallet (T19).

**Needs Arya sign-off:** new circuit + new public inputs + new bet status + new operator trust instance. Adding Q24 to the tracker.

---

## Q2 (new threat T20) - Malicious deposit: committed balance != deposited amount [CRITICAL]

### This is a live fund-loss vulnerability, not a hypothetical

`Vault.deposit(bytes32 commitment, uint256 amount)` (`Vault.sol:287-293`) does three things: cap check, `usdc.safeTransferFrom(msg.sender, this, amount)`, `tree.insert(commitment)`. It **cannot** read the `balance` field inside `commitment` because the commitment hides it. No deposit-time ZK proof exists (the docs call Proof 1 "optional / trivial").

Every spending circuit only checks the balance *relatively*:
- `bet_auth`: `current_balance >= bet_amount`, then recommits `current_balance - bet_amount`.
- `withdrawal`: `withdrawal_amount <= final_balance`.

Nothing, anywhere, ties the committed `balance` to the `amount` that was actually transferred at deposit. So:

> Attacker calls `deposit(Poseidon4(secret, 200_000_000, 0, ownerAddr), amount = 100_000_000)`. The contract pulls 100 USDC, inserts a commitment that *opens to a 200 USDC balance*. Later the attacker submits a valid withdrawal for 200 USDC. Every circuit assertion passes (the note really is in the tree; `200 <= 200`). The Vault pays out 200, stealing 100 USDC from the shared pool.

The only thing standing between this and a clean theft is the liquidity guard in `withdraw` (`InsufficientLiquidity`, `Vault.sol:487-489`), which merely converts it into "the pool drains and the last honest users cannot withdraw." That is not a defense - it is the loss surfacing after the theft. Severity: **CRITICAL** (direct, unprivileged loss of other users' funds). I am filing it as **T20**.

A secondary instance of the same root cause: `deposit` never binds `owner_address` either. A depositor can put any address in the `owner_address` field, so the "W-to-W withdrawal" guarantee is also unenforced at the entry point.

### Fix: re-instate the Deposit proof as MANDATORY (it was wrongly classed as trivial)

The doc's reasoning ("no ZK needed unless deposit amounts are hidden") is the error. The point is not hiding the amount; it is **binding the hidden balance and owner to the public amount and `msg.sender`**.

**Recommended (Solution 1a - deposit ZK proof, no commitment-formula change):**

Add a `deposit.nr` circuit:
- Private: `secret`.
- Public: `commitment`, `amount`, `owner_address`.
- Constraints: `commitment == Poseidon4(secret, amount, 0, owner_address)`.

`Vault.deposit` becomes `deposit(proof, commitment, amount)` and calls the verifier with public inputs `(commitment, amount, msg.sender-as-field)`. This forces `balance == amount`, `nonce == 0`, and `owner_address == msg.sender`, with `secret` still private. This is the cleanest fix because it leaves the Poseidon4 commitment formula and all four existing circuits untouched - it only adds one verifier. Cost: ~250k gas + a fast client proof (the circuit is tiny - one hash, no Merkle path).

**Alternative (Solution 1b - contract-computed commitment, no deposit proof):** Have the user submit a secret-derived field and let the contract compute `leaf = Poseidon(userField, amount, 0, msg.sender)` on-chain from the *on-chain* `amount` and `msg.sender`. Binding is automatic. But it changes the commitment construction (Project Agent sign-off, invalidates the "all circuits use `Poseidon4(secret, balance, nonce, owner)`" constant) and needs a wider/chained Poseidon on-chain. More invasive than 1a for no real benefit.

**Non-fix to avoid:** a global "total committed == total deposited" invariant is uncheckable per-note without revealing balances, and the global USDC-balance check only fails *after* theft. Do not rely on it.

### Required follow-ups

- `CLAUDE.md` currently states deposit has no ZK proof; that line must change once 1a is adopted.
- `threat-model.md` add T20 (CRITICAL).
- `zk-design.md` Section "Proof 1: Deposit" must be rewritten from "optional/trivial" to "mandatory soundness proof."

**Needs Arya sign-off:** adding a fifth-and-a-half circuit + changing the `deposit` signature. But given severity, I recommend treating this as a blocker for any deposit-handling code, not a backlog item.

---

## Q3 (new tracker Q25) - Disclosing a specific user's bets to a regulator

The privacy invariant hides *which depositor authorized which bet*. A lawful request is almost always of the form "given identity W, produce W's trades" - not "deanonymize everyone." The design goal for compliance is therefore **selective, per-subject disclosure with no protocol-wide backdoor.** Three structural facts make this achievable cheaply:

1. `owner_address` (= W) is baked into **every** note commitment via `Poseidon4(secret, balance, nonce, owner_address)`.
2. In P3+, secrets are wallet-derived deterministically by deposit index (`CLAUDE.md` secret-derivation rule). So given W's wallet (or a key derived from it), every note in W's lineage is re-derivable.
3. The deposit `W -> vault` is already public on-chain by design.

Together: anyone holding W's viewing key can re-derive W's secrets, recompute every commitment and nullifier in W's chain, and match them to the public `BetAuthorized` events. No one else can. That is exactly a Zcash-style viewing key, and the architecture already supports it for free in P3+.

### Options, ordered least-to-most invasive to the privacy model

| Option | Who can disclose | Granularity | Privacy cost | Recommendation |
|---|---|---|---|---|
| A. User-held viewing key (compelled disclosure) | Only W (or whomever W hands the key to under subpoena) | Exactly W's bets | None to other users; W discloses W's own data | **Primary** |
| B. Operator auto-settlement blob | Operator, for opt-in users only | W's bets if W opted in | Already exists today; opting in already links W->bet at the operator (`CLAUDE.md`). Just formalize export | Stopgap for opted-in users |
| C. Threshold-escrowed viewing key | A k-of-n guardian set, on lawful request, per subject | Exactly W's bets | Introduces a trusted quorum that *can* deanonymize a chosen subject. Per-subject, not global | Optional, jurisdiction-gated |
| D. Owner reveal at settlement | Public | All settled bets, everyone | Destroys the core invariant for everyone. Only hides still-open bets | Reject as default |
| E. Privacy-Pools association sets | n/a (proves membership, not identity) | Answers "is W clean?" not "what did W bet?" | Low | Adjacent tool, different question |

### Recommendation

Ship **A** as the default and only mandatory mechanism: derive a deterministic per-account viewing key from the wallet, and build an "export my full history" tool that produces a verifiable transcript (deposit -> each nullifier -> each `BetAuthorized`/settlement event). A regulator gets W's complete activity when W (or a court compelling W) produces it, and nothing about any other depositor leaks. This matches how regulators actually operate (they target an identified subject) and keeps Polyshield a true zero-backdoor system.

Offer **C** as an *optional, configurable* deployment for operators in jurisdictions that legally require a recoverable disclosure path without subject cooperation: at deposit, the client additionally submits `ThresholdEnc(guardians, viewing_key_for_W)`, keyed to W. Lawful process triggers a k-of-n decryption that yields **only W's** viewing key, then proceeds as in A. This is per-subject, auditable (each decryption is a recorded guardian action), and never exposes the whole set.

Avoid **D** entirely as a default; at most it could be an opt-in "transparent account" flag for users who want a public track record.

**This is a privacy-model decision and needs Arya's call** (per the project rule that privacy-model changes require explicit trade-off evaluation). My recommendation is A-now, C-optional, D-never-by-default. Filing as Q25. Note dependency: A is clean only under P3+ deterministic secrets; under P1/P2 random secrets, the viewing key is just the user's note backup set, which works but is not auto-derivable.

---

## Q4 (clarifies T8) - Does a changing Merkle root force one transaction per block?

**No.** The root changes on every `tree.insert` (deposit, bet, settlement, withdraw, cancel all insert a leaf), and `merkle_root` is a public input to every proof, but the system is explicitly built to tolerate this with a **rolling root-history window**, and you can have many state-changing transactions per block.

### Why it works

`CommitmentMerkleTree` keeps `recentRoots[30]` (a ring buffer), and `Vault` accepts a proof if `tree.isKnownRoot(inputs.merkle_root)` matches **any** of the last 30 roots (`CommitmentMerkleTree.sol:83-95`), not just the current one. This is the Tornado Cash `MerkleTreeWithHistory` pattern.

Two properties make concurrent transactions safe:

1. **Membership is monotonic.** A leaf present under root R is present under every later root. So a note inserted in the past is always provable.
2. **Old root + old path verify together.** The user submits `(merkle_path, merkle_root = R)`. The circuit checks `computed_root == merkle_root`. Even though appending new leaves *would* change that note's path to the *current* root, the user's path is still correct relative to **R**, and R is accepted as long as it is within the last 30 roots. So users never need to refresh their path mid-flight.

Result: in a single block, txA built against root R1, txB against R2, txC against R3 can all execute; each `insert` pushes a new root but R1/R2/R3 remain in the 30-entry window. Throughput is not block-serialized.

### The real constraint (this is T8, "stale root")

Your referenced root must still be among the **last 30 roots** when your transaction executes. Each successful state transition inserts exactly one leaf = one new root. So if **more than 30 inserts** land between when you fetched the root (to build your proof) and when your tx is mined, your root falls out of the window and the proof reverts with `UnknownRoot`.

This matters because proving takes **30s to 2 minutes** (WASM client prover). During a 2-minute window under load, 30 inserts is plausible, which would cause stale-root reverts and forced rebuilds. So the practical throughput ceiling is roughly:

> sustainable inserts per (proving + inclusion latency) window < HISTORY_SIZE (30)

### The only true serialization point (intended)

Two proofs that spend the **same** note (same `nullifier`) - only one wins; the other reverts `NullifierSpent`. That is correct double-spend prevention, and the frontend already must enforce sequential submission per note (the "concurrent bet race condition" note in `CLAUDE.md`). This is per-note, not global, and does not limit unrelated users.

### How to raise the ceiling

| Change | Effect | Cost |
|---|---|---|
| Increase `HISTORY_SIZE` (e.g. 128-256) | Directly widens the staleness tolerance | More storage; the current `isKnownRoot` loop is O(HISTORY_SIZE) - see next row |
| Switch root history to `mapping(bytes32 => bool)` + a ring for eviction | O(1) root lookup, so a large window costs almost nothing per verify | Small contract change |
| Prove against an intentionally older "settled" root | Decouples proving latency from churn | Slightly larger effective anonymity set; trivially compatible with the window |
| Batch submission at the relay | Relay groups many proofs into a submission stream; each still carries its own recent root | Relay work only; also helps T18 timing privacy |
| Sequencer/queue for ordering under heavy load | Smooths bursts so churn stays under the window | Off-chain infra |

Recommendation: do both cheap changes - **bump `HISTORY_SIZE` and switch `isKnownRoot` to a mapping** so the window can be large (e.g. 256) at O(1) lookup. That removes stale-root failures for any realistic proving-latency/throughput combination and costs almost nothing. Filing the window-scaling decision as a follow-up under T8 (no new Q needed unless you want one).

A note on what does *not* help: nothing here requires changing the circuits. The root handling is entirely a contract + relay concern.

---

## Summary: status and what needs your call

| Item | Tracker | Status | Needs Arya |
|---|---|---|---|
| Position close / sell | Q24 (new) | Designed; v1 = operator-reported proceeds, v2 = trustless/TEE | Yes - new circuit, new public inputs, new operator trust instance |
| Deposit balance forgery | T20 (new, CRITICAL) | Live vuln; fix = mandatory deposit proof (Solution 1a) | Yes - new circuit + `deposit` signature change. Recommend blocker status |
| Regulatory disclosure | Q25 (new) | Recommend user-held viewing key (A) default, threshold-escrow (C) optional, settlement-reveal (D) never-default | Yes - privacy-model decision |
| Merkle root throughput | T8 (clarified) | Not 1/block; rolling 30-root window already handles it. Recommend larger window + mapping-based lookup | No - contract/relay change, no privacy impact |

Recommended next docs to update once you approve: add T20 to `threat-model.md`, add Q24/Q25 to `open-questions.md`, rewrite the "Proof 1: Deposit" section of `zk-design.md`, and reconcile `zk-design.md`/`open-questions.md` to the 4-field/Circom reality.
