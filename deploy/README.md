# Polyshield — Single-Host Deployment (Phases 5 + 6)

Runs the **entire stack on one box** with Docker Compose: Caddy (HTTPS) → Next.js frontend →
three private backend services pointed at **Polygon mainnet + real Polymarket**.

```
internet ──443/80──► caddy ──► frontend:3000
                                 ├─ /api/relay/*        ─► proof-relay:3002   (submits proofs; pays gas)
                                 ├─ /api/merkle-path/*  ─► proof-relay:3002   (backend merkle cache — FC-12)
                                 ├─ /api/recovery-data/*─► proof-relay:3002   (note recovery index — FC-12)
                                 ├─ /api/events         ─► proof-relay:3002   (explorer event index — FC-12)
                                 ├─ /api/markets/*      ─► proof-relay:3002   (Gamma market catalog — FC-15)
                                 └─ /api/signing/*      ─► signing-layer:3004 (holds vault key; auto-settlement API)
```

Only two backend services run. The proof-relay is both the **proof submitter** and the **backend
index/cache + market catalog** (FC-12/FC-15): `CachedMerkleTree → /merkle-path`,
`VaultEventIndex → /recovery-data` + `/events`, settlement-credit relay, and the public market
catalog (`/markets`), persisted in its own SQLite (`merkle.db` / `catalog.db`). Clients fetch
merkle paths / recovery data / explorer events from it instead of scanning the chain — see
`docs/architecture.md` §2.4. **There is no separate indexer service** — settlement *detection*
runs inside the signing-layer (`settlementResolver`), and settlement *records* are served from the
proof-relay event index.

Only **Caddy publishes ports** (80/443). The backend services have no published ports, so they
are reachable only over the private compose network — never from the internet. No tunnel needed
because the frontend's server-side API routes proxy to the backend by container name.

### Hostnames (apex + 2 subdomains)

Caddy serves three hostnames off the one `SSLIP_HOST` (`{$SSLIP_HOST}` + `app.` + `explorer.`),
all proxied to the same Next server, which routes by subdomain in `src/middleware.ts`:

| Host | Serves |
|---|---|
| `polyshield.xyz` (apex) | Marketing site. `/app/*` 301s to the app subdomain; `/explorer` 301s to the explorer subdomain. |
| `app.polyshield.xyz` | The dApp (deposit/bet/settle/withdraw). |
| `explorer.polyshield.xyz` | The public on-chain activity explorer (single-page host; all other links bounce to apex/app). |

**DNS:** add an A record for **each** host → the box's public IP (`@`, `app`, `explorer`), DNS-only
(grey cloud) so Caddy can complete the Let's Encrypt HTTP-01 challenge for all three. Caddy requests
one cert covering all three names on first start.

---

## 0. Prerequisites (on the host)

- Docker Engine + Compose plugin (already present here: `docker compose v5.1.3`).
- Ports **80 and 443 open** to the internet (Caddy needs 80 for the Let's Encrypt HTTP-01
  challenge, 443 to serve). This host has a public IP (`84.32.231.156`), so they just need to be
  unblocked.
- The hostname **`84-32-231-156.sslip.io`** already resolves to this IP (sslip.io is automatic —
  nothing to register). Swap in a real domain later by editing `SSLIP_HOST` in `deploy/.env` and
  rebuilding.

> All `docker` commands below need `sudo` on this box (the `aria` user is not in the `docker` group).

---

## 1. Fill in config

```bash
cd deploy
cp .env.example .env
cp env/common.env.example        env/common.env
cp env/proof-relay.env.example   env/proof-relay.env
cp env/signing-layer.env.example env/signing-layer.env
cp env/frontend.env.example      env/frontend.env
chmod 600 env/*.env .env
```

Then edit each file:

| File | What goes in it | Secret? |
|---|---|---|
| `.env` | `SSLIP_HOST`, `NEXT_PUBLIC_*` (chain id, RPC, **Vault address**, USDC, WalletConnect id) | no (public) |
| `env/common.env` | `POLYGON_RPC_URL`, `VAULT_CONTRACT_ADDRESS`, `TREE_ADDRESS`, CTF/USDC/pUSD/onramp/**offramp** | addresses only |
| `env/proof-relay.env` | `RELAYER_PRIVATE_KEY` (gas payer, separate EOA) | **yes** |
| `env/signing-layer.env` | `VAULT_EOA_PRIVATE_KEY`, `POLY_API_KEY/SECRET/PASSPHRASE`, `OPERATOR_API_TOKEN`, operator addr, deposit wallet, builder creds | **yes (vault key)** |
| `env/frontend.env` | `OPERATOR_API_TOKEN` (**must equal** the signing-layer one) | yes |

**Must-verify before go-live:**
- `NEXT_PUBLIC_VAULT_ADDRESS`, `VAULT_CONTRACT_ADDRESS`, `TREE_ADDRESS` = your **Phase 4 proxy** addresses.
- `OFFRAMP_ADDRESS` — the value in the repo's root `.env.example` is **truncated/invalid**; set the real one.
- `USDC_ADDRESS` matches the token the on/offramp actually use (USDC.e vs native USDC — a mismatch breaks `fundPolymarketWallet`).
- `OPERATOR_API_TOKEN` is **identical** in `signing-layer.env` and `frontend.env`. Generate with `openssl rand -hex 32`.
- **RPC (`POLYGON_RPC_URL`) — hard requirements (learned the hard way, see `docs/architecture.md` §2.5):**
  - Must be a **full/archive node, NOT pruned.** Pruned public nodes (e.g. `publicnode`) return *"History has been pruned for this block"* and cannot rebuild the merkle tree / event index.
  - Must allow a **usable `eth_getLogs` block range.** **Alchemy's FREE tier caps it at 10 blocks** (`-32600 … up to a 10 block range`) → ~10k requests per history scan + blows the monthly compute budget. Use a paid/dedicated archive RPC.
  - For short free-tier testing only: set `LOG_SCAN_CHUNK=10` in `common.env` (one-time scans then grind but complete; they're cursor-persisted and resume).
  - `NEXT_PUBLIC_CHAIN_RPC` (frontend, baked at build) should point at the same archive RPC so client-side reads/recovery work.

---

## 2. Firewall (recommended)

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80,443/tcp
sudo ufw enable
```

> ⚠️ Docker publishes ports by editing iptables directly and **bypasses ufw**. That's fine here —
> we *want* 80/443 public, and the backend ports are never published so they stay private
> regardless. ufw above is mainly for SSH hygiene. Do **not** add `ports:` to the backend
> services in the compose file.

---

## 3. Build & start

```bash
cd deploy
sudo docker compose build      # first build is slow: frontend bakes ~93 MB of ZK assets
sudo docker compose up -d
sudo docker compose ps
```

Caddy fetches a Let's Encrypt cert for `SSLIP_HOST` on first start (watch `docker compose logs caddy`).

---

## 4. Verify

```bash
curl -I https://84-32-231-156.sslip.io/                       # 200, valid TLS
sudo docker compose exec proof-relay   node -e "require('http').get('http://127.0.0.1:3002/health',r=>{console.log(r.statusCode)})"
sudo docker compose exec signing-layer node -e "require('http').get('http://127.0.0.1:3004/',r=>{console.log(r.statusCode)})"
sudo docker compose logs -f signing-layer
```

Open `https://84-32-231-156.sslip.io` in a browser, connect a wallet, and walk one deposit →
bet → settle → withdraw on a small amount.

---

## 5. Persistence & backups

Named volumes (survive `down`/restarts/redeploys):

| Volume | Holds | If lost |
|---|---|---|
| `signing_data` (`/data/settlement.db`) | operator attestations + `tracked_markets` + event-listener cursor | **settlement breaks** — losing it can strand user funds |
| `proofrelay_data` (`/data/merkle.db`) | merkle cache + event index + market catalog (FC-12/FC-15) | rebuildable from chain — safe to lose, just a slow cold-start re-scan |
| `caddy_data` | TLS certs/account | re-issued automatically |

Back up the SQLite volumes on a schedule (`signing_data` is the critical one), e.g.:

```bash
sudo docker run --rm -v polyshield_signing_data:/d -v "$PWD":/b alpine \
  sh -c 'cp /d/settlement.db /b/settlement.$(date +%F).db'
```

---

## 6. Circuit breaker (READ THIS)

The signing-layer has a dead-man switch: on a Polymarket **403** or **`ACCOUNT_FLAGGED`/`ACCOUNT_BANNED`**
response it halts all signing and `process.exit(1)`s ([`circuitBreaker.ts`](../packages/backend/signing-layer/src/circuitBreaker.ts),
wired into every order path in `orderBuilder.ts`).

- The compose `restart: on-failure:2` for signing-layer means a tripped breaker **stays down**
  after the retries instead of resurrecting and hammering a banned account.
- **Known limitation:** the halt flag is in-memory, so it does **not** survive a manual restart.
  If you `docker compose restart signing-layer` after a ban, it will resume signing. **Treat a
  signing-layer that has exited as an incident** — investigate the ban before restarting.
- **Recommended follow-up (not yet implemented):** persist the halt flag to the `signing_data`
  volume and check it on boot, and add a real alert sink (PagerDuty/Telegram) in `halt()`.
  Ask if you want this — it's a small, safe change.

---

## 7. Operating

```bash
sudo docker compose logs -f                 # all services
sudo docker compose restart proof-relay
sudo docker compose down                    # stop (volumes preserved)

# Redeploy after pulling new code:
git pull && cd deploy && sudo docker compose build && sudo docker compose up -d
```

---

## 8. Security caveats for THIS box (mainnet vault key on a shared host)

You chose to run the real `VAULT_EOA_PRIVATE_KEY` here. This is a **shared, multi-session dev VM**
co-located with an unrelated Chainflip node. The key is only as safe as every other user/process
on the box. Hardening:

- `chmod 600 deploy/env/signing-layer.env`; ensure only your user can read it.
- Consider stopping the unrelated Chainflip container to reduce attack surface and free ~1.8 GB RAM.
- **Plan to relocate signing-layer to a dedicated, single-user host.** The container is
  self-contained (no workspace deps), so migration = copy `env/signing-layer.env` + the
  `signing_data` volume to the new host, run just that service there, and point
  `SIGNING_LAYER_URL` at it. No code change.

---

## Status / what's verified

The stack **builds and runs** on this box (all services Up + healthy; Caddy issued TLS for the apex
and `app.` subdomain; the dApp loads at `https://app.84-32-231-156.sslip.io/markets` with live
Polymarket data). The **full lifecycle — deposit → bet → claim → settle → withdraw — has been
exercised end-to-end on a live Polygon-mainnet market with real funds** (a BTC up/down market
resolved and the winning position settled to a fresh note, confirmed `CREDITED` on-chain). CSP is
left disabled in the Caddyfile on purpose — tune and enable after testing every wallet/proof flow.

---

## Live Polymarket integration status (FC-11 + FC-12)

The frontend serves **real Polymarket markets** (Gamma API) and the signing-layer resolves each
bet's `conditionId → real tokenId` via a market registry (synced at boot + every 10 min).

- **Works:** real market list/detail, real prices + order book, deposit/proving, **order placement**
  to the live CLOB (FAK market + GTC/GTD limit) with corrected price (1e8) and size (share count),
  and **settlement on live markets** — the FC-12 fixes closed the prior blocker:
  - `resolveMarket` reads the **real Gnosis CTF via the element accessor**
    (`payoutNumerators(conditionId, i)` + `getOutcomeSlotCount`) — the array getter only exists on
    `MockCTF` and reverts on mainnet, which is why settlement previously never landed.
  - The **settlement resolver** detects resolution via a `tracked_markets` poll (state read) +
    filtered `ctf.on`, and `resolveMarket` runs **before** redemption so a redeem hiccup can't block
    a user from settling.
  - The real `conditionId` flows through the market registry, so the bet's reduced `circuit_key`
    matches `pendingCredit[circuit_key]`.
- **Backend index/cache (FC-12):** clients fetch merkle paths, recovery data, and explorer events
  from the proof-relay instead of scanning the chain — this is also what makes the stack usable
  under a metered RPC (see the RPC requirements in §1).

**Before relying on live betting** confirm `market registry sync complete { upserted: N }` in the
signing-layer logs first (bets during the initial sync window fail recoverably), then check JIT
funding, POLY API creds, deposit-wallet approvals, and FAK partial-fill accounting against the real
CLOB response.

Rebuilding after backend/frontend changes: `sudo docker compose build signing-layer proof-relay frontend && sudo docker compose up -d`.
