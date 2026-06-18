# packages/backend

Node.js / TypeScript backend services for Polyshield. In production **two** real services run
(proof-relay and signing-layer); the rest are local-dev helpers. Everything is TypeScript run via
`ts-node`.

> **Privacy invariant:** no backend service ever sees a note secret. The proof-relay serves only
> public, anonymous on-chain data; the signing-layer holds the vault EOA key and operator key, but
> never a user's note preimage. The only sanctioned exception is the optional ECIES-encrypted
> auto-settlement permission blob (encrypted to the operator's key). See [`../../CLAUDE.md`](../../CLAUDE.md).

---

## Services

```
backend/
  proof-relay/       Real. Submits spend-path proofs to the Vault (relayer EOA pays gas, so the
                     user wallet is never tx.from) AND is the backend index/cache + market catalog:
                       • CachedMerkleTree   → GET /merkle-path        (O(32), no client chain scan)
                       • VaultEventIndex    → /recovery-data, /events (recovery + explorer feed)
                       • /relay/settlement, /relay/bet, /relay/withdrawal, /relay/* (proof relays)
                       • marketCatalog.ts   → /markets, /markets/search, /markets/prices (Gamma, FC-15)
                       • analytics.ts       → POST /analytics (anonymous aggregate; no wallet/IP/id)
                       • betaConsent.ts     → beta consent signature gate
                     SQLite: merkle.db (cache/index) + catalog.db (markets).  Port 3002.
  signing-layer/     Real. Holds the vault EOA key; the operator. Centralized v1 (TEE = v2, planned):
                       • eventListener      → BetAuthorized → FAK / GTC / GTD CLOB orders
                       • settlementResolver → CTF resolved → Vault.resolveMarket + redemption
                       • jitFunding         → JIT collateral funding per bet (FC-7)
                       • terminalAttestation/attestationStore → FC-9 signed operator attestations
                       • circuitBreaker     → dead-man halt on Polymarket 403 / account ban
                       • autoSettlement     → HTTP API (attestations, limit orders, admin-cancel).  Port 3004.
  mock-clob-server/  Mock only. Fake Polymarket CLOB + builder relayer for local dev.  Port 3001.
  mock-env/          Local orchestration: starts Anvil, deploys contracts, launches all services
                     (this is what `pnpm dev:mock` runs).
```

There is **no separate indexer service** — settlement detection lives in the signing-layer
(`settlementResolver`) and settlement records / the explorer feed are served from the proof-relay
event index.

---

## Running

From the **repo root**:

```bash
pnpm dev:mock        # Anvil + deploy contracts + mock CLOB + proof-relay + signing-layer
pnpm dev:frontend    # (separate terminal) Next.js app on :3000
pnpm dev:all         # both together
```

Local ports: Anvil `8545`, mock CLOB `3001`, proof-relay `3002`, signing-layer `3004`,
frontend `3000`. Anvil resets on every `dev:mock` restart.

**Logging:** all services emit structured JSON (pino) to stdout, tee'd to
`logs/session-<timestamp>.jsonl`. Watch live with `tail -f logs/*.jsonl | jq .`.

---

## Tests

Per-service tests live in `*/src/__tests__/`. Mock the Polymarket API; test the circuit-breaker
logic. Never test against a real Polymarket EOA or real mainnet USDC.

---

## Critical constraints

- The vault EOA private key lives in **environment variables only** — never hardcoded, never logged.
- Signing must not start before the on-chain proof is finalized (≥1 block confirmation on Polygon).
- The circuit breaker halts all signing on a ban signal (`403` / `ACCOUNT_FLAGGED` / `ACCOUNT_BANNED`)
  and exits. Treat a signing-layer that has exited as an incident — investigate before restarting.
- Production needs a **full/archive RPC with a usable `eth_getLogs` range** — pruned public nodes and
  Alchemy's free tier (10-block cap) do not work. See `docs/architecture.md` §2.5.

For mainnet deployment of these services, see [`../../deploy/README.md`](../../deploy/README.md).
