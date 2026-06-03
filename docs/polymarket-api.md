# Polymarket API and Protocol Reference

**Version:** 0.3 (Verified)
**Last updated:** 2026-06-02
**Status:** All sections verified against official Polymarket documentation ([api-reference](https://docs.polymarket.com/api-reference), [builders/overview](https://docs.polymarket.com/builders/overview)) and GitHub source. v0.3 adds the API-surface overview (Gamma / Data / Bridge APIs), the L1 request-header list, the **Builder Program & Relayer Client** section, and current SDK/relayer package names. No more [UNVERIFIED] sections — any future changes to Polymarket's contracts or API require re-verification.

> **v0.3 diff vs. official docs (comparison summary).** The CLOB order types, the two-level (L1/L2) auth model, the four signature types (EOA/POLY_PROXY/GNOSIS_SAFE/POLY_1271), the EIP-712 order struct, the heartbeat behaviour, and the contract addresses below all still match the official reference. New in the official docs and now reflected here: (1) Polymarket exposes **four** API services — Gamma, Data, CLOB, Bridge (§3.0); (2) L1 credential-creation requests carry a `POLY_NONCE` header (§3); (3) the **Builder Program** with `builderCode` order attribution and the gas-free **Relayer Client** (§5.1); (4) georestriction/region routing for the CLOB (§3.0).

---

## 1. Polymarket Chain and Contracts

Polymarket operates on **Polygon mainnet** (chain ID 137). All contracts below are verified against the [official Polymarket documentation](https://docs.polymarket.com/resources/contracts).

### Core Trading Contracts

| Contract | Address | Notes |
|---|---|---|
| CTF Exchange (V2) | `0xE111180000d2663C0091e4f400237545B87B996B` | Current live exchange. Audited by Quantstamp and Cantina, March 2026. |
| Neg Risk CTF Exchange | `0xe2222d279d744050d28e00520010520000310F59` | For multi-outcome (3+) markets. Requires `negRisk: true` in order options. |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` | Adapter for multi-outcome markets. |
| Conditional Tokens (CTF) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | ERC-1155 outcome share tokens (YES/NO). |

**Deprecated:** CTF Exchange V1 (`0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`) is the old exchange, still deployed on-chain but no longer the active exchange. Do not target V1 in new implementations.

**Testnet (Polygon Amoy):** CTF Exchange V1 is deployed at `0xdFE02Eb6733538f8Ea35D585af8DE5958AD99E40` on Amoy. A V2 testnet address is not yet confirmed.

### Collateral Contracts

**CRITICAL: Polymarket does NOT use USDC directly as collateral.** The exchange uses **pUSD** (Polymarket USD), a wrapped stable coin. USDC must be converted to pUSD via the onramp contract before it can be used for trading. See Section 4 for Polyshield implications.

| Contract | Address | Purpose |
|---|---|---|
| pUSD (proxy) | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` | Active collateral token. The ERC-20 the Exchange contract spends. |
| pUSD (impl) | `0x6bBCef9f7ef3B6C592c99e0f206a0DE94Ad0925f` | Implementation behind the proxy. |
| CollateralOnramp | `0x93070a847efEf7F70739046A929D47a521F5B8ee` | Converts USDC → pUSD. |
| CollateralOfframp | `0x2957922Eb93268531d39fAcCA3B4dC5854` | Converts pUSD → USDC. |
| CtfCollateralAdapter | `0xAdA100Db00Ca00073811820692005400218FcE1f` | Standard markets collateral adapter. |
| NegRiskCtfCollateralAdapter | `0xadA2005600Dec949baf300f4C6120000bDB6eAab` | Neg Risk markets collateral adapter. |

### Wallet Factory Contracts

| Contract | Address | Purpose |
|---|---|---|
| Deposit Wallet Factory | `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` | Factory for the new deposit wallet architecture (recommended for all new API integrations). |
| Polymarket Proxy Factory | `0xaB45c5A4B0c941a2F231C04C3f49182e1A254052` | Factory for the legacy Proxy Wallet (`POLY_PROXY`, signatureType 1). Still used by existing browser-based Polymarket users. |
| Gnosis Safe Factory | `0xaacfeea03eb1561c4e67d661e40682bd20e3541b` | Factory for Safe-based accounts. |

### Resolution Contracts

| Contract | Address | Purpose |
|---|---|---|
| UMA Adapter | `0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74` | Bridge between Polymarket and UMA's oracle. |
| UMA Optimistic Oracle | `0xCB1822859cEF82Cd2Eb4E6276C7916e692995130` | UMA's oracle that settles market resolutions. |

---

## 2. Conditional Token Framework (CTF)

Polymarket uses the Gnosis Conditional Token Framework. Understanding it is essential for the Settlement Credit proof and for the Indexer.

### Key Concepts

**Condition:** A question with N possible outcomes. Identified by:
```
conditionId = keccak256(abi.encodePacked(oracle, questionId, outcomeSlotCount))
```

**Outcome tokens (ERC-1155):** For each condition, CTF mints YES and NO tokens. Each token is redeemable for 1 pUSD if its outcome resolves true, 0 pUSD otherwise.

**Position ID:**
```
positionId = keccak256(abi.encodePacked(collateralToken, collectionId))
collectionId = keccak256(abi.encodePacked(conditionId, indexSet))
```
This is the ERC-1155 token ID used to query share balances.

**Resolution:** When Polymarket resolves a market, the oracle calls:
```
CTF.reportPayouts(questionId, payouts[])
```
Where `payouts` is an array summing to `1e18`. For a YES win: `payouts = [1e18, 0]`. For a NO win: `payouts = [0, 1e18]`.

**Redemption:** After resolution, the vault calls:
```
CTF.redeemPositions(collateral, parentCollectionId, conditionId, indexSets)
```
This exchanges winning outcome tokens for pUSD. The vault EOA or its Deposit Wallet must initiate this.

### Payout Per Share Calculation

```
payout_per_share = payoutNumerators[outcomeIndex] / payoutDenominator
```

For a binary YES win: `payoutNumerators[0] = 1e18`, `payoutDenominator = 1e18`, so `payout_per_share = 1.0` (full 1 pUSD per share).

This value is derived directly from on-chain CTF state — not from an external oracle — and is used in the Settlement Credit ZK circuit.

---

## 3. CLOB (Central Limit Order Book)

Polymarket's CLOB is off-chain. Order matching happens server-side at Polymarket. Settlement happens on-chain via the CTF Exchange V2 contract when orders are matched.

### 3.0 API Surface Overview

The official reference splits the platform into four HTTP services. Polyshield only needs the **CLOB API** for order flow plus optionally the **Data API** for position/redemption queries; the others are listed for completeness.

| Service | Base URL | Auth | Used by Polyshield |
|---|---|---|---|
| CLOB API | `https://clob.polymarket.com` | public reads; L2 for trading | **Yes** — order submission, status, cancel, heartbeat (signing layer) |
| Data API | `https://data-api.polymarket.com` | none | Optional — positions, trades, holder data; useful cross-check for the Indexer |
| Gamma API | `https://gamma-api.polymarket.com` | none | Optional — markets/events/tags metadata (market discovery in the frontend) |
| Bridge API | `https://bridge.polymarket.com` | n/a | No — deposit/withdrawal proxy to fun.xyz; Polyshield manages its own collateral path |

Docs index for machine consumption: `https://docs.polymarket.com/llms.txt`. Official client libraries exist for **TypeScript, Python, and Rust** (see §5.1 for exact package names).

**Region / georestriction:** the CLOB is served primarily from `eu-west-2`, with `eu-west-1` as a non-georestricted alternative; KYC/KYB unlocks direct colocation. The signing layer's egress region matters operationally (a georestricted region can have orders rejected) — pin the signing layer to a permitted region.

### Order Types

All four order types are confirmed supported:

| Type | Behavior | Polyshield use |
|---|---|---|
| GTC (Good-Til-Cancelled) | Rests on book until filled or cancelled | Not used |
| GTD (Good-Til-Date) | Active until a specified expiration timestamp | Not used |
| **FOK (Fill-Or-Kill)** | Must fill entirely and immediately, or entire order is cancelled | **Primary order type for Polyshield v1** |
| FAK (Fill-And-Kill) | Fills as much as available immediately, cancels remainder | Fallback option |

**FOK is confirmed** — there is an explicit CLOB error code `FOK_ORDER_NOT_FILLED_ERROR` for orders that cannot fill. FOK orders are the correct choice for Polyshield v1 because they eliminate partial fill accounting (see Q7 resolution in `open-questions.md`).

### Authentication: Two-Level Model

**Signing orders is not sufficient.** The CLOB requires two distinct authentication mechanisms:

**L1 (Private Key / EIP-712):** Used to create or derive API credentials. Signs a `ClobAuth` EIP-712 struct with these fields:

```typescript
const domain = {
  name: "ClobAuthDomain",
  version: "1",
  chainId: 137,
};

const types = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
};
```

The L1 credential-creation/derivation request itself carries these headers (distinct from the L2 set below):

| Header | Description |
|---|---|
| `POLY_ADDRESS` | Polygon signer address |
| `POLY_SIGNATURE` | EIP-712 `ClobAuth` signature |
| `POLY_TIMESTAMP` | Current UNIX timestamp |
| `POLY_NONCE` | Request nonce |

**L2 (HMAC-SHA256 / API Key):** Required on every authenticated trading endpoint (order submission, cancellation, heartbeat). Five headers must be sent:

| Header | Description |
|---|---|
| `POLY_ADDRESS` | Polygon signer address |
| `POLY_SIGNATURE` | HMAC-SHA256 signature of the request (signed with API secret) |
| `POLY_TIMESTAMP` | Current UNIX timestamp |
| `POLY_API_KEY` | API key UUID |
| `POLY_PASSPHRASE` | API key passphrase |

**Implication for the Signing Layer:** The Signing Layer must manage L2 API credentials (key, secret, passphrase) in addition to the signing EOA private key. These credentials must be stored securely and are independent of the on-chain signing key. In v2 (TEE), both the signing key and the L2 credentials must live inside the enclave.

### Order Signature Types

When submitting orders, the `signatureType` field determines how the order signature is validated:

| Type | Value | Description |
|---|---|---|
| EOA | 0 | Standard EOA ECDSA signature. Funder is the EOA. |
| POLY_PROXY | 1 | Legacy Polymarket Proxy Wallet. For existing proxy-wallet users. |
| GNOSIS_SAFE | 2 | Gnosis Safe wallet. |
| **POLY_1271** | **3** | **Deposit Wallet via ERC-1271. Recommended for new API integrations.** |

**Polyshield should use signatureType 3 (POLY_1271) and the Deposit Wallet architecture.** See Section 5 for the full wallet architecture.

### EIP-712 Order Structure (CTF Exchange V2)

The raw order submitted to the CLOB for a POLY_1271 deposit wallet order:

```typescript
{
  "deferExec": false,
  "order": {
    "salt": 123456789,
    "maker": "0xDepositWallet",      // deposit wallet address, NOT EOA
    "signer": "0xDepositWallet",     // same as maker for deposit wallets
    "tokenId": "TOKEN_ID",           // ERC-1155 position ID (outcome token)
    "makerAmount": "5000000",        // pUSD amount (6 decimals) for BUY
    "takerAmount": "10000000",       // shares amount for BUY
    "side": "BUY",
    "expiration": "0",               // 0 = no expiration (FOK orders don't need this)
    "signatureType": 3,              // POLY_1271
    "timestamp": "1760000000",
    "metadata": "0x0000...",
    "builder": "0x0000...",
    "signature": "0xWrapped1271Sig"  // ERC-7739-wrapped ERC-1271 signature (see below)
  },
  "owner": "CLOB_API_KEY",
  "orderType": "FOK"
}
```

**Signature construction for POLY_1271:** The order signature is NOT a plain EIP-712 signature. It is an ERC-7739-wrapped `TypedDataSign` payload that lets the Deposit Wallet validate the order via ERC-1271. The signing key signs a nested payload under the `DepositWallet` EIP-712 domain:

```typescript
const walletDomain = {
  name: "DepositWallet",
  version: "1",
  chainId: 137,
  verifyingContract: depositWalletAddress,
  salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
};
```

The Polymarket SDK builds this wrapper automatically when `POLY_1271` and a deposit wallet funder are configured. The Signing Layer should use the official SDK (`@polymarket/clob-client-v2`) rather than implementing this manually.

### Heartbeat Requirement

**Critical for the Signing Layer:** The CLOB requires a heartbeat every ~5 seconds. If a valid heartbeat is not received within **10 seconds** (with a 5-second buffer), **all open orders are automatically cancelled**.

```typescript
let heartbeatId = "";
setInterval(async () => {
  const resp = await client.postHeartbeat(heartbeatId);
  heartbeatId = resp.heartbeat_id;
}, 5000);
```

The Signing Layer must run a heartbeat loop in its main process. A crash or network partition that prevents heartbeats will clear all resting limit orders — this is actually a useful safety property for Polyshield (open orders are cleaned up automatically on failure), but must be accounted for in the operational design.

### CLOB API Endpoints

Base URL: `https://clob.polymarket.com`

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/order` | POST | L2 | Submit a signed order |
| `/orders/:orderId` | GET | L2 | Get order status |
| `/orders` | GET | L2 | Get open orders |
| `/trades` | GET | L2 | Get trade history |
| `/heartbeat` | POST | L2 | Send heartbeat |
| `/auth/api-key` | POST | L1 | Create L2 API credentials |
| `/auth/derive-api-key` | GET | L1 | Derive existing L2 API credentials |

---

## 4. pUSD: Collateral Architecture and Polyshield Implications

Polymarket uses **pUSD** (Polymarket USD), not USDC, as collateral. This is a significant architectural impact on the Vault contract.

### What Is pUSD?

pUSD is an ERC-20 token on Polygon that Polymarket maintains as its internal settlement currency. USDC can be converted to pUSD via the `CollateralOnramp` contract and converted back via `CollateralOfframp`.

### Implications for the Vault Contract

The Vault contract currently assumes USDC as its collateral asset. This must be reconsidered:

**Option A: Vault accepts USDC, converts to pUSD before funding the Deposit Wallet.**
- Users deposit USDC into the Vault. The Vault holds USDC internally.
- When funding the Polymarket Deposit Wallet, the Vault calls `CollateralOnramp` to convert USDC to pUSD and sends pUSD to the Deposit Wallet.
- When settling withdrawals, pUSD is converted back to USDC via `CollateralOfframp` before returning to depositors.
- Pro: Users interact only with USDC, which is familiar and liquid.
- Con: Two on-chain conversion transactions (onramp on deposit-to-Polymarket, offramp on settlement-to-Vault).

**Option B: Vault accepts pUSD directly.**
- Users must obtain pUSD before depositing (or the frontend handles the USDC→pUSD swap transparently).
- Simpler on-chain logic.
- Con: Adds a UX step for users and depends on pUSD liquidity in the broader market.

**Current recommendation:** Option A for v1. The Vault remains USDC-denominated from the depositor's perspective. The USDC-to-pUSD conversion is an internal step in the `fundPolymarketAccount()` function. This is addressed in Q13 in `open-questions.md`.

---

## 5. Deposit Wallet Architecture

Polymarket's Deposit Wallet is the required wallet architecture for new API integrations. It replaces what was previously called the "Proxy Wallet" for this use case.

### Architecture

A Deposit Wallet is an **ERC-1967 proxy contract** deployed by the Deposit Wallet Factory. One wallet per user (or per programmatic account).

- The wallet holds **pUSD** and **CTF outcome tokens** on-chain
- The owner EOA (or an approved session signer) controls the wallet
- pUSD held by the owner EOA does NOT count as CLOB buying power — it must be held by the Deposit Wallet
- All CLOB orders must have `maker = depositWalletAddress` and `signer = depositWalletAddress`

### Deterministic Address Derivation

The Deposit Wallet address is deterministic from the owner EOA:

```
walletId = bytes32(owner)                    // owner address, left-padded to 32 bytes
args = abi.encode(factory, walletId)
salt = keccak256(args)
bytecodeHash = SoladyLibClone.initCodeHashERC1967(implementation, args)
depositWallet = CREATE2(factory, salt, bytecodeHash)
```

SDK helper: `deriveDepositWalletAddress()` (TypeScript) or `get_expected_deposit_wallet()` (Python).

### Share Balance Query Path

When querying CTF outcome share balances for the Settlement Credit proof, query the **Deposit Wallet address** in the CTF ERC-1155 contract:

```solidity
uint256 shares = CTF.balanceOf(depositWalletAddress, positionId);
```

NOT the vault's signing EOA address. The Deposit Wallet holds the tokens, not the EOA.

### Wallet Lifecycle for Polyshield

1. **At vault deployment:** The vault operator deploys a Deposit Wallet for the vault's signing EOA via `POST /relayer/submit` with `type: "WALLET-CREATE"`. The Deposit Wallet address is stored in the Vault contract. **One-time approvals** (pUSD → CTF Exchange V2 and pUSD → offramp) are submitted from the Deposit Wallet via a `WALLET` batch (`DepositWalletExecutor.ensureApprovals`).
2. **Funding — JIT (Option 3 / FC-7):** Deposits accumulate as USDC in the Vault; nothing is converted at deposit time. **Per bet**, just before order submission, the Signing Layer calls `Vault.fundPolymarketWallet(shortfall)` to convert only the uncovered remainder of `bet_amount` (USDC → pUSD via `CollateralOnramp`) and forward it to the Deposit Wallet. pUSD left after a no-fill is reused as a residual buffer, so subsequent bets onramp less; the steady state converges on the Option-4 base buffer. (Earlier docs described a *periodic* bulk `fundPolymarketAccount()` — that is the Option-2/4 bulk variant; the implemented path is per-bet JIT.)
3. **Trading:** The Signing Layer uses the deposit wallet as the order maker, signs with POLY_1271, submits FOK orders via the CLOB API.
4. **Settlement:** After market resolution, the Signing Layer (or Indexer) submits a `WALLET` batch via the relayer abstraction (`DepositWalletExecutor`) calling `CTF.redeemPositions(...)` from the Deposit Wallet, then `approve`/`CollateralOfframp.withdraw`/`transfer` to send USDC back to the Vault, and the operator calls `acknowledgePolymarketReturn` to decrement `deployedToPolymarket`. Locally this runs against the `MockDepositWallet` proxy via the mock relayer route; in production against the Polymarket builder relayer.
5. **User withdrawal:** When a user generates a valid Withdrawal ZK proof, the Vault contract transfers USDC to the recipient address.

---

## 5.1 Builder Program & Relayer Client

Source: [docs.polymarket.com/builders/overview](https://docs.polymarket.com/builders/overview). This is the integration path Polyshield already follows (deposit wallet + relayer + POLY_1271), so the signing layer should adopt the official Builder tooling rather than hand-rolling relayer calls.

### What a "builder" is

A **builder** routes user orders to Polymarket and in return gets (1) **gas-free** on-chain operations through Polymarket's relayer and (2) volume attribution on a public leaderboard. Two mechanics matter for Polyshield:

- **`builderCode` attribution.** The app attaches its `builderCode` to the order struct; *"the builder code is serialized on-chain as part of the signed order."* This is exactly the `builder` field shown in the EIP-712 order in §3 (currently `0x0000...`). **For the live test, set `order.builder` to Polyshield's registered builder code** so orders are attributed and eligible for gas-free relaying. The builder code is created/managed in the Builder dashboard.
- **Gas-free relayer.** *"Gas-free wallet deployment, approvals, order execution and CTF operations."* The relayer covers the Polygon gas for: deposit-wallet deployment (`WALLET-CREATE`), one-time approvals (pUSD + outcome tokens), order execution, and CTF operations (`redeemPositions`, etc.). This is the mechanism behind Polyshield's `DepositWalletExecutor` `WALLET` batches (see §5) — in production those batches go to the **builder relayer**, removing the need for the relay EOA to hold MATIC for deposit-wallet actions.

### SDK clients (current package/repo names)

| Client | Language | Repo / package |
|---|---|---|
| CLOB Client | TypeScript | `github.com/Polymarket/clob-client-v2` |
| CLOB Client | Python | `github.com/Polymarket/py-clob-client-v2` |
| CLOB Client | Rust | `github.com/Polymarket/rs-clob-client-v2` |
| Relayer Client | TypeScript | `github.com/Polymarket/builder-relayer-client` |
| Relayer Client | Python | `github.com/Polymarket/py-builder-relayer-client` |

The Signing Layer should use the **CLOB Client** (order signing/submission, builder attribution, POLY_1271 wrapping — see §3) and the **Relayer Client** (gas-free wallet create / approvals / redemption batches — the production backend for `DepositWalletExecutor`). L2 API credentials are derived from wallet (L1) authentication and managed via the Builder dashboard.

### Implications for Polyshield

- The previously-noted flat `relayGasFeeUSDC` (P2 fee, see CLAUDE.md) covers the relay EOA's Polygon gas for the **on-chain proof relay**, which is separate from Polymarket's builder relayer; deposit-wallet/CLOB on-chain actions become gas-free under the builder relayer, so the operator's MATIC burn is limited to the proof-relay path.
- Builder enrollment is an operational prerequisite for the live mainnet test: register a builder profile, obtain a `builderCode`, and wire it into the order builder so `order.builder` is non-zero.

---

## 6. Market Resolution and Payout Retrieval

After a market resolves, the Indexer must:

1. **Detect resolution:** Listen for `CTF.ConditionResolution(bytes32 conditionId, address oracle, bytes32 questionId, uint outcomeSlotCount, uint[] payoutNumerators)` event.

2. **Retrieve payout data:** Call:
   ```solidity
   uint256[] memory numerators = CTF.payoutNumerators(conditionId);
   uint256 denominator = CTF.payoutDenominator(conditionId);
   ```
   Compute `payout_per_share[i] = numerators[i] / denominator` (in pUSD units, scaled by 1e6).

3. **Initiate redemption:** If the Deposit Wallet holds winning shares, the Signing Layer must submit a `WALLET` batch calling:
   ```solidity
   CTF.redeemPositions(pUSD_address, bytes32(0), conditionId, indexSets)
   ```
   This converts winning CTF tokens into pUSD held by the Deposit Wallet.

4. **Store settlement record:** The Indexer exposes `GET /settlement/:market_id` returning `{ conditionId, positionId, payout_per_share, block_number, outcome }` for frontend WASM provers to use as witness data.

---

## 7. Open Research Tasks (Remaining)

The following items require hands-on testing and are tracked in `open-questions.md`:

- **Q13 [NEW — BLOCKER for Vault contract]:** pUSD vs USDC — should the Vault accept USDC and convert, or accept pUSD directly? Decision needed before Vault.sol is written.
- **Q14 [NEW]:** L2 API key management in the Signing Layer. How are CLOB API credentials generated, stored, and rotated, especially in v2 (TEE)?
- Confirm payout_per_share computation from CTF contract state for a recently resolved market (requires live Polygon RPC call).
- Test `CTF.redeemPositions` from a Deposit Wallet on Amoy testnet or a forked mainnet.
- Confirm the pUSD onramp/offramp flow end-to-end on testnet.
- Review Polymarket's terms of service for any restrictions on programmatic trading or vault-style usage patterns.
