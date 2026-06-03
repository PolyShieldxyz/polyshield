# Collateral Deployment Strategy: Options Comparison

> **Implementation status (2026-06-01):** **Option 3 (JIT) is implemented** and wired into the local mock stack for live-Polymarket-style testing. The signing layer funds the deposit wallet just-in-time per bet via `Vault.fundPolymarketWallet(shortfall)` before submitting the order (`packages/backend/signing-layer/src/jitFunding.ts`). One deliberate deviation from textbook Option 3: **on a FOK no-fill the JIT-funded pUSD is left in the deposit wallet as a residual buffer** (not swept back). Because the per-bet check reuses that residual and only onramps the shortfall, the steady state self-provisions a base buffer — i.e. it organically drifts toward **Option 4**, which is the **planned successor** once the buffer is actively managed (low/high-water policy). Deposit-wallet actions run through a relayer → proxy abstraction (mock: `MockDepositWallet` + the mock relayer route; production: Polymarket builder relayer), so the same code path serves the live mainnet model. See FC-7 in `future-changes.md` and `collateral-flow-audit.md`.

---

## The core trade-off in one sentence

Money sitting as USDC in the Vault is safe (users withdraw it with a ZK proof, no key we hold can take it, and it survives any backend outage), while money converted to pUSD and held in the Polymarket deposit wallet is the only capital exposed to a key compromise or a backend outage. So **the percentage of funds we deploy to Polymarket is the percentage of user funds we put at risk**, and we are trading that risk against how fast and reliably bets fill.

A second, separate fact: a deposit today already rests as USDC in the Vault. It is not auto-converted. This doc is about the deployment policy we layer on top of that.

---

## Facts that apply to every option

- **Conversion is 1:1 (USDC <-> pUSD), pegged.** The cost of a conversion is on-chain gas plus confirmation latency, not a price spread. (Note: confirm whether `CollateralOnramp`/`CollateralOfframp` charge any explicit fee before finalizing numbers; assumed zero here per Q13.)
- **A bet needs buying power the instant it is placed.** If the deposit wallet does not already hold enough pUSD when the order is submitted, the order fails and the user's bet does not place (their note is refunded). Buffer adequacy therefore equals bet reliability.
- **At-rest USDC is trustless; deployed pUSD is trusted.** USDC in the Vault is withdrawable permissionlessly via ZK proof and is not reachable by any operator key. pUSD in the deposit wallet is controlled by a key and is exposed to compromise, to being stuck if the backend dies, and it requires the operator to convert back before a user can withdraw it.
- **Two safety rails apply on top of any option:** an on-chain cap (`maxInFlight`) that bounds how much can ever be deployed, and a fenced deposit-wallet owner (a multisig or contract that owns the wallet, a limited session key for trading, and a permissionless `sweepResolvedToVault` for recovery). These reduce the blast radius regardless of which timing strategy we pick.

---

## Notes per option

**1. Deploy 100% at deposit.** Best bet UX, but it is the maximum-risk profile: every user's money lives on Polymarket under a key at all times, withdrawals stop being permissionless (the Vault has no USDC to pay out without an operator offramp), and a key compromise or a permanent backend failure puts the entire fund at risk or stuck. This is the "whole fund is in-flight" model. Only acceptable with a TEE signer and a fenced wallet, and even then it sacrifices the trustless-exit property.

**2. Deploy X%, rebalance the buffer (hot/cold, CEX-style).** The balanced middle. Keep the bulk of TVL as USDC in the Vault (cold, safe, permissionlessly withdrawable) and maintain a working pUSD buffer at roughly X% (hot) sized to expected betting demand. A monitor tops the buffer up when it falls below a low-water mark and offramps the excess when it rises above a high-water mark, all in bulk and asynchronously, so bets fill instantly and deposits/withdrawals stay fast. Exposure is exactly X% and tunable. The trade-off: if X is set too low, a burst of bets can exhaust the buffer and some FOK orders fail until the next top-up clears. This maps to FC-6 in `future-changes.md`.

**3. Deploy only at bet time (JIT). — IMPLEMENTED.** Minimum risk: almost nothing is ever exposed or stuck. But every bet pays an onramp plus a block confirmation before it can fill, which is slow and adds a per-bet gas cost and new failure modes (if the funding tx is slow or fails, the bet does not place). Worst UX and highest operator gas, best security. Reasonable only if bet latency of tens of seconds is acceptable. **As built:** the signing layer calls `Vault.fundPolymarketWallet(shortfall)` for the un-covered remainder of each bet right before submitting to the CLOB; a funding failure (deployment cap reached / vault illiquid) is reported as a recoverable FOK failure rather than a silent debit. The funded pUSD that does not fill is **left as a residual buffer** (see status banner) — the next bet reuses it and only onramps the new shortfall, so exposure accretes toward a small standing balance and the model converges on Option 4. `Vault.deployedToPolymarket` tracks the deployed amount and is decremented at settlement via `acknowledgePolymarketReturn`; the SEC-007 `deploymentCap` is the on-chain ceiling on exposure.

**4. Base buffer + JIT overflow (hybrid). — PLANNED SUCCESSOR.** Keep a small standing buffer (Option 2) sized to cover typical bet sizes so the common case fills instantly, and JIT-fund (Option 3) only for bets that exceed the buffer. This avoids holding a large standing balance just to cover rare large bets, so exposure stays small while UX stays good for the majority of bets. Large bets accept a short funding delay. **This is the intended next step.** The implemented Option-3 path already accretes a residual buffer and reuses it, so moving to Option 4 is mostly additive: a low/high-water buffer manager that proactively tops the buffer up in bulk (and lets it bleed back down during incidents) rather than relying purely on per-bet accretion, plus a governance `maxInFlight` (the existing `deploymentCap`) tuned to the target buffer. See FC-6 (bounded working-buffer) and FC-7 (JIT) in `future-changes.md`.

---

## Comparison


| Dimension                                  | 1. Deploy 100% at deposit                                                                                  | 2. Deploy X%, rebalance buffer (hot/cold)                            | 3. Deploy only at bet time (JIT)                                                 | 4. Base buffer + JIT overflow (hybrid)                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Bet fill speed / UX**                    | Best (always funded)                                                                                       | Good (instant up to buffer; large/burst bets may stall)              | Worst (onramp + confirmation before every fill)                                  | Good (instant for typical bets; only oversized bets wait) |
| **Deposit UX**                             | Slower / costs a conversion per deposit                                                                    | Fast (USDC at rest)                                                  | Fast (USDC at rest)                                                              | Fast (USDC at rest)                                       |
| **Withdrawal UX**                          | Poor: Vault holds ~no USDC, so withdrawals need the operator to offramp first (breaks permissionless exit) | Good for the at-rest majority; large withdrawals may wait on offramp | Best: nearly all funds at rest, always withdrawable                              | Good (same as Option 2)                                   |
| **Fee overhead to user**                   | Medium. Number of deposits are dramatically lower than the number of bets and settlements.                 | Low (conversions are bulk, operator-side)                            | High if passed on (one conversion per bet)                                       | Low                                                       |
| **Fee overhead to operator (gas)**         | None. Taken from user at every action                                                                      | Periodic bulk rebalances (amortized)                                 | None. Taken from user at every action                                            | Low base + occasional overflow onramp                     |
| **Backend / server overhead**              | Low (convert on deposit)                                                                                   | Moderate (balancing service or on-chain policy)                      | Moderate-high (per-bet funding, nonce/confirmation handling, more failure modes) | Moderate (buffer policy + overflow path)                  |
| **pUSD at risk (key compromise)**          | 100% of TVL                                                                                                | X% of TVL (tunable)                                                  | ~Only in-flight bet amounts, briefly                                             | Small base buffer + transient overflow                    |
| **Vault USDC kept safe / at-rest**         | ~0%                                                                                                        | (100 - X)%                                                           | ~All                                                                             | Most                                                      |
| **Stuck funds if backend down / key lost** | Entire fund                                                                                                | X% (resolved part sweepable)                                         | Almost nothing                                                                   | Small buffer only                                         |
| **Capital efficiency**                     | Full (all capital deployable)                                                                              | Tunable                                                              | Full but slow to mobilize                                                        | High                                                      |
| **Single operator vs TEE**                 | TEE strongly required (100% exposed)                                                                       | TEE valuable, cap limits exposure meanwhile                          | TEE least critical (little at risk)                                              | TEE valuable; exposure already small                      |
| **Deposit-wallet ownership sensitivity**   | Extreme (one wallet holds everything)                                                                      | Moderate                                                             | Low                                                                              | Low-moderate                                              |


---

## Deposit-wallet ownership (applies to all options)

Who owns the deposit wallet determines what a stolen key can do.

- **Single hot EOA owns everything (current code).** One key signs orders, owns the wallet, and is the on-chain operator. A leak drains whatever pUSD is deployed and can pull more. Worst case; only tolerable with a very low deployed percentage.
- **Fenced owner + session signer (recommended).** The wallet is owned by a multisig or a contract whose only outbound path is offramp-back-to-Vault, and a separate limited session key signs CLOB trades. A stolen session key can then only place (bad) trades, never transfer funds out, which turns "theft" into bounded "griefing." Add a permissionless `sweepResolvedToVault` so resolved funds come home even if we disappear.

The higher the deployed percentage, the more this matters: Option 1 effectively requires the fenced model, while Option 3 is forgiving because little is ever at stake.

---

## Single operator vs TEE (applies to all options)

A TEE (v2, AWS Nitro) keeps the signing key inside an enclave so it cannot be extracted, and the enclave only signs orders that match an on-chain authorization. Its importance scales with how much is deployed: with Option 1 it is close to mandatory, with Option 2/4a it is valuable but the `maxInFlight` cap bounds exposure in the meantime, and with Option 3 it is least critical because the at-risk amount is tiny. The cap-and-fence rails buy us time to ship the TEE rather than blocking on it.

---

## Recommendation

**Now (live-test phase): Option 3 (JIT) is shipped** — it maximizes safety (almost nothing exposed) at the cost of bet UX and operator gas, which is the right trade-off while validating the end-to-end Polymarket money path. The deposit-wallet proxy + relayer abstraction it runs on is the production model, so the live mainnet test reuses the same code.

**Next: Option 4 (base buffer + JIT overflow)**, with the governance `maxInFlight` cap (`deploymentCap`) and a fenced deposit-wallet owner. This keeps the majority of user funds cold, safe, and permissionlessly withdrawable, exposes only a bounded, tunable buffer, and restores instant fills for typical bets. The Option-3 implementation already accretes and reuses a residual buffer, so the step to Option 4 is the buffer-management policy (FC-6) layered on top.

Option 1 maximizes UX at the cost of the trustless-exit guarantee and maximum risk; Option 2 is Option 4 without the JIT-overflow path. The two open numbers for leadership are the target buffer / `maxInFlight` ceiling (as a percentage of TVL or a hard dollar cap) and whether the fenced-owner model is a v1 requirement or a v2 item.