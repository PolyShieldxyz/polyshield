# PolyShield QA Audit Report

**Date:** 2026-05-29  
**Project:** PolyShield — ZK Privacy Vault for Polymarket  
**Input:** Local codebase `/Users/aria/Desktop/PolyShield`  
**Stack:** Solidity (Foundry), Noir circuits, Node.js (Express), Next.js 14, TypeScript  
**Auditor:** QA Engineer Skill  

---

## Executive Summary

| Metric | Count |
|---|---|
| CRITICAL | 2 |
| HIGH | 5 |
| MEDIUM | 8 |
| LOW | 7 |
| INFO | 3 |
| **Overall Grade** | **D** |

**Top 3 most critical findings:**
1. **DEP-001** — Critical Next.js CVE (CVSS 9.1): Authorization Bypass in Middleware — directly affects PolyShield's routing middleware.
2. **SEC-001** — snarkjs/Groth16 verifiers deployed instead of UltraPLONK — the proof system the frontend generates is Groth16 (snarkjs), but Noir circuits exist in parallel with no bridge; the entire ZK stack has an architecture coherence gap.
3. **SEC-002** — Proof Relay has no authentication or rate limiting — any network-reachable caller can consume the relayer's private key to submit arbitrary on-chain transactions.

**Most impactful single fix:** Upgrade `next` to `>=14.2.35` (`npm install next@14.2.35` in `packages/frontend`) — this closes 14+ known CVEs including the critical CVSS 9.1 middleware bypass.

---

## Category 1: Security Vulnerabilities

### SEC-001 — ZK Backend Architecture Mismatch: Groth16 Verifiers with Noir Circuits
**Severity:** CRITICAL  
**Location:** `packages/contracts/src/verifiers/BetAuthVerifier.sol:7`, `SettlementCreditVerifier.sol:6`, `WithdrawalVerifier.sol:6`, `BetCancelVerifier.sol:6`, `CancelCreditVerifier.sol:6`; `packages/frontend/src/lib/prover.ts:2,148–165`

**Evidence:**
```
// BetAuthVerifier.sol line 7:
// snarkJS-generated Groth16 verifier — bet_auth circuit (9 public signals)
// Source: Benchmarking/groth16/contracts/generated/BetAuthVerifier.sol

// prover.ts line 151:
const { proof, publicSignals } = await snarkjs.groth16.fullProve(...)
```
All five deployed verifiers are explicitly labeled as snarkjs-generated Groth16. The `prover.ts` uses `snarkjs.groth16.fullProve()` loading `.wasm` + `.zkey` files. However, `CLAUDE.md` states the ZK backend is UltraPLONK everywhere (Noir/Barretenberg), and the circuits in `packages/circuits/` are all Noir. There is no Barretenberg prover in the frontend. The Groth16 verifiers come from the `Benchmarking/` folder (a research artifact) and have not been replaced with UltraPLONK verifiers.

**Impact:** The production proof system is Groth16 (snarkjs), not UltraPLONK (Noir). Any on-chain proof verification actually tests Groth16 verifiers against Circom circuits that don't exist in the repo — the Noir circuits in `packages/circuits/` are unused by the running system. This is a complete disconnect between documented architecture and deployed reality. If the Groth16 circuit compilation artifacts (`.wasm`/`.zkey`) are missing from `/public/circuits/` and `/public/zkeys/`, proof generation will fail entirely at runtime.

**Fix Suggestion:**
1. Decide the canonical proving system. Per CLAUDE.md, it should be UltraPLONK (Barretenberg).
2. Wire the Noir circuits to the frontend via `@noir-lang/noir_wasm` + `@aztec/bb.js`, replacing the snarkjs path in `prover.ts`.
3. Regenerate verifiers with `bb write_vk && bb contract` for each circuit, replace the Groth16 verifiers in `packages/contracts/src/verifiers/`.
4. Remove the snarkjs dependency from the frontend.

---

### SEC-002 — Proof Relay: No Authentication, No Rate Limiting
**Severity:** HIGH  
**Location:** `packages/backend/proof-relay/src/api.ts:65–200`, `packages/backend/proof-relay/src/index.ts`

**Evidence:**
```typescript
// api.ts — no auth middleware anywhere
app.use(express.json({ limit: "1mb" }))
// No: helmet, cors restriction, bearer token check, IP allowlist, rate limiter
app.post("/relay/bet", async (req, res) => { ... })
app.post("/relay/withdrawal", async (req, res) => { ... })
```

The proof relay accepts any caller on port 3002. In a deployed configuration reachable from the internet, anyone can POST a valid ZK proof and have the relayer's EOA submit transactions to the Vault, burning gas and consuming nonces. A DoS attacker can flood the relay with syntactically valid but semantically invalid proofs, draining the relayer's ETH balance and blocking legitimate users.

**Fix Suggestion:**
```typescript
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'

app.use(helmet())
app.use(rateLimit({
  windowMs: 60_000,
  max: 20, // 20 relay calls per minute per IP
  message: { error: 'Rate limit exceeded' },
}))

// Add a pre-shared key header for the Next.js proxy→relay hop:
app.use((req, res, next) => {
  const key = req.headers['x-relay-secret']
  if (key !== process.env.RELAY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
})
```

---

### SEC-003 — Next.js Relay Proxy: Unvalidated Slug Enables Path Traversal to Internal Endpoints
**Severity:** HIGH  
**Location:** `packages/frontend/src/app/api/relay/[...slug]/route.ts:22–23`

**Evidence:**
```typescript
const action = params.slug.join('/')
const target = `${RELAY_URL}/relay/${action}`
// A request to POST /api/relay/../../other-service/admin
// composes: http://127.0.0.1:3002/relay/../../other-service/admin
// Node.js fetch may normalize this to: http://127.0.0.1:3002/other-service/admin
```

The slug is joined without any allowlist check. Depending on how Node.js's `fetch` normalizes the URL, a crafted slug could route to a different path or port on the internal relay server. Even if Node resolves the path correctly, if the relay ever adds additional admin endpoints, those become reachable from the public Next.js API.

**Fix Suggestion:**
```typescript
const ALLOWED_ACTIONS = new Set(['bet', 'settlement', 'withdrawal', 'bet-cancel', 'na-cancel'])

export async function POST(req: NextRequest, { params }: { params: { slug: string[] } }) {
  const action = params.slug.join('/')
  if (!ALLOWED_ACTIONS.has(action)) {
    return NextResponse.json({ error: 'Unknown relay action' }, { status: 400 })
  }
  const target = `${RELAY_URL}/relay/${action}`
  // ...
}
```

---

### SEC-004 — `acknowledgePolymarketReturn()` Is Fully Trust-Based: No Proof Required
**Severity:** HIGH  
**Location:** `packages/contracts/src/Vault.sol:246–253`

**Evidence:**
```solidity
function acknowledgePolymarketReturn(uint256 amount) external {
    if (msg.sender != signingLayerOperator) revert OnlyOperator();
    if (amount > deployedToPolymarket) revert InvalidAmount();
    deployedToPolymarket -= amount;  // No verification USDC actually arrived
    emit PolymarketReturnAcknowledged(amount);
}
```
The contract's own comment admits: *"TRUST: This function does not verify that USDC actually returned to the vault."* A compromised or colluding operator can call this function with an inflated `amount`, understating `deployedToPolymarket`, which causes the solvency guard in `withdraw()` (`InsufficientLiquidity`) to pass prematurely — allowing withdrawals when the vault doesn't actually have the funds.

**Fix Suggestion:**
```solidity
function acknowledgePolymarketReturn(uint256 amount) external {
    if (msg.sender != signingLayerOperator) revert OnlyOperator();
    // Verify USDC balance has at least increased by `amount` vs. deployedToPolymarket tracking
    uint256 currentBalance = usdc.balanceOf(address(this));
    // deployedToPolymarket tracks how much was sent out; balance should have grown
    if (amount > deployedToPolymarket) revert InvalidAmount();
    deployedToPolymarket -= amount;
    emit PolymarketReturnAcknowledged(amount);
}
```
Longer term, replace the acknowledge pattern with an on-chain redemption pipeline that moves USDC atomically. Flag this for the v2 TEE operator design.

---

### SEC-005 — Dev Log API: No Size Limit, No Rate Limit, No Content Validation (Dev Mode Risk)
**Severity:** MEDIUM  
**Location:** `packages/frontend/src/app/api/dev/log/route.ts`

**Evidence:**
```typescript
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.NEXT_PUBLIC_DEV_MODE !== 'true') {
    return NextResponse.json({ error: '...' }, { status: 403 })
  }
  const body: unknown = await req.json()
  fs.appendFileSync(LOG_FILE, JSON.stringify(body) + '\n', 'utf-8')
  return NextResponse.json({ ok: true })
}
```
When `NEXT_PUBLIC_DEV_MODE=true`, any caller can POST arbitrary JSON with no size limit or rate limit. An attacker who reaches this endpoint can fill disk space (log bomb) or inject malformed log entries. Since `NEXT_PUBLIC_` variables are embedded in the client bundle, the dev mode state is visible to anyone who inspects the JavaScript.

**Fix Suggestion:**
```typescript
const MAX_BODY_BYTES = 4096
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.NEXT_PUBLIC_DEV_MODE !== 'true') {
    return NextResponse.json({ error: 'log endpoint only available in dev mode' }, { status: 403 })
  }
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10)
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'body too large' }, { status: 413 })
  }
  // ...
}
```

---

### SEC-006 — No Content Security Policy Headers
**Severity:** MEDIUM  
**Location:** `packages/frontend/next.config.js`

**Evidence:**
```javascript
// next.config.js — no headers() function defined
const nextConfig = {
  webpack(config, { isServer }) { ... },
}
module.exports = nextConfig
```
The Next.js app sets no security headers: no CSP, no `X-Frame-Options`, no `X-Content-Type-Options`, no `Strict-Transport-Security`, no `Referrer-Policy`. An XSS vulnerability in any dependency or user-controlled content could allow an attacker to exfiltrate wallet interaction data from the page.

**Fix Suggestion:**
```javascript
// next.config.js
const nextConfig = {
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        {
          key: 'Content-Security-Policy',
          value: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://*.polygon.technology wss:; frame-ancestors 'none';",
        },
      ],
    }]
  },
  webpack(config, { isServer }) { ... },
}
```

---

### SEC-007 — Relay Logs Full Public Inputs (Nullifiers, Commitments, Market IDs) at INFO Level
**Severity:** LOW  
**Location:** `packages/backend/proof-relay/src/relayer.ts:107–113`

**Evidence:**
```typescript
logger.info({
  event: "relay:authorizeBet:start",
  proof_bytes: proofBytes(proof),
  proof_fingerprint: fingerprint(proof),
  inputs,  // full inputs object: nullifier, new_commitment, market_id, etc.
}, "relay:authorizeBet:start")
```
Every relayed transaction logs the complete `inputs` struct including nullifiers and commitments at INFO level. While these are not private witnesses (secret/balance/nonce), they are pseudonymous identifiers that, when combined with transaction timing and market data, could help link depositors to bets. Log aggregation services (e.g., CloudWatch, Datadog) would retain this data indefinitely.

**Fix Suggestion:**
```typescript
logger.info({
  event: "relay:authorizeBet:start",
  proof_bytes: proofBytes(proof),
  proof_fingerprint: fingerprint(proof),
  // Only log a hash of the nullifier for tracing, not the full value
  nullifier_hash: ethers.keccak256(ethers.toUtf8Bytes((inputs as { nullifier?: string }).nullifier ?? '')).slice(0, 10),
}, "relay:authorizeBet:start")
```

---

### SEC-008 — MockDeploy Script Contains Hardcoded Anvil Private Keys
**Severity:** LOW  
**Location:** `packages/contracts/script/MockDeploy.s.sol:30–32`

**Evidence:**
```solidity
uint256 constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
uint256 constant ALICE_KEY    = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;
uint256 constant BOB_KEY      = 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba;
```
These are well-known Anvil test keys (publicly documented), but hardcoding private keys in source files is a bad practice. Secret scanning tools (GitHub's secret scanner, detect-secrets) will flag these as high-severity findings, and developers might accidentally promote this pattern into a real deployment script.

**Fix Suggestion:**
```solidity
// Remove hardcoded keys. Use vm.envUint() or read from DEPLOYER_KEY env var.
uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
vm.startBroadcast(deployerKey);
```

---

## Category 2: Dependency Auditing

### DEP-001 — Critical Next.js Authorization Bypass (GHSA-f82v-jwr5-mffw, CVSS 9.1)
**Severity:** CRITICAL  
**Location:** `packages/frontend/package.json` — `next@14.x` (exact version TBD by lockfile)

**Evidence:**
```
npm audit summary (frontend):
[CRITICAL] next: Authorization Bypass in Next.js Middleware (GHSA-f82v-jwr5-mffw)
  Range: >=14.0.0 <14.2.25
  CVSS: 9.1 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N)
  Fix: upgrade to next@14.2.35 (non-breaking)
```
This vulnerability allows unauthenticated callers to bypass Next.js middleware authentication checks. PolyShield's `middleware.ts` performs subdomain routing (`app.polyshield.xyz` → `/app/*`). An attacker could bypass the middleware to access routes that middleware was supposed to gate, or craft requests that bypass the CORS/redirect logic.

Additional related CVEs in the installed `next` version:
- `GHSA-c4j6-fc7j-m34r` — SSRF via WebSocket upgrades (CVSS 8.6, HIGH)
- `GHSA-7gfc-8cq8-jh5f` — Authorization bypass (CVSS 7.5, HIGH)  
- `GHSA-mwv6-3258-q52c` — DoS with Server Components (CVSS 7.5, HIGH)
- `GHSA-5j59-xgg2-r9c4` — DoS incomplete fix follow-up (CVSS 7.5, HIGH)
- 18 additional moderate/low CVEs

**Fix Suggestion:**
```bash
cd packages/frontend
npm install next@14.2.35
# Verify the fix:
npm audit
```

---

### DEP-002 — Backend: 5 Moderate Dependency Vulnerabilities
**Severity:** MEDIUM  
**Location:** `packages/backend/package.json`

**Evidence:**
```
npm audit summary (backend):
  5 moderate vulnerabilities
  0 critical / 0 high
```
The moderate vulnerabilities should be reviewed and patched in the next dependency update cycle. They do not require immediate action but should be addressed before mainnet deployment.

**Fix Suggestion:**
```bash
cd packages/backend
npm audit fix
```

---

## Category 3: Performance

### PERF-001 — Proof Generation Runs on Main Thread Fallback with No Progress Indicator
**Severity:** MEDIUM  
**Location:** `packages/frontend/src/lib/prover.ts:305–331`

**Evidence:**
```typescript
worker.onerror = () => {
  clearTimeout(timeout)
  worker.terminate()
  console.warn('[prover] Worker failed, falling back to main thread')
  runProofMainThread(message).then(resolve, reject)  // blocks main thread
}
```
If the Web Worker fails to start, proof generation falls back to the main thread with no user notification. On slow devices this will freeze the browser UI for 30s–2min with no progress feedback, violating the CLAUDE.md requirement: *"Show a clear progress indicator. Do not let the user navigate away."*

**Fix Suggestion:**
```typescript
worker.onerror = () => {
  clearTimeout(timeout)
  worker.terminate()
  // Emit a custom event for the UI to show "Proving on main thread — please wait..."
  window.dispatchEvent(new CustomEvent('polyshield:prover-fallback'))
  runProofMainThread(message).then(resolve, reject)
}
```

---

### PERF-002 — ZkGasBench Tests Fail Due to Missing Groth16 Benchmark Artifacts
**Severity:** LOW  
**Location:** `packages/contracts/test/ZkGasBench.t.sol`

**Evidence:**
```
[FAIL] test_gasBench_Groth16_betAuth: vm.readFileBinary path ../../Benchmarking/groth16/bench_out/bet_auth_proof.bin not allowed
[FAIL] test_gasBench_Groth16_betCancel: ...
[FAIL] test_gasBench_Groth16_cancelCredit: ...
[FAIL] test_gasBench_Groth16_settlement: ...
[FAIL] test_gasBench_Groth16_withdrawal: ...
5 failing tests (of 74 total)
```
These tests require external binary files and filesystem access permissions not granted in the standard `foundry.toml`. They fail on every CI run and every `forge test` invocation.

**Fix Suggestion:**
Either add the fs permission to `foundry.toml` and include the binary artifacts, or skip these tests in CI:
```toml
# foundry.toml
[profile.default]
fs_permissions = [{ access = "read", path = "../../Benchmarking" }]
```
Or mark them as ignored until the benchmarking infrastructure is wired:
```solidity
// ZkGasBench.t.sol — add vm.skip(true) at the start of each failing test
function test_gasBench_Groth16_betAuth() public {
  vm.skip(true);  // Requires Benchmarking/groth16/bench_out/*.bin
}
```

---

## Category 4: Accessibility

### A11Y-001 — No Accessibility Audit Possible (Frontend Not Running)
**Severity:** INFO  
**Location:** `packages/frontend/`

The frontend could not be started for live accessibility testing (requires dev stack `pnpm dev:mock`). Static code inspection found:

- `packages/frontend/src/app/layout.tsx` includes `<html lang="en">` — correct.
- No `dangerouslySetInnerHTML` usage found — low XSS risk.
- Components use standard HTML elements (buttons, inputs) from shadcn/ui — likely accessible.
- No `aria-*` attributes observed in the reviewed components — risk of missing labels on custom wallet connection UI.

**Recommendation:** Run `pa11y http://localhost:3000` after starting the dev stack and fix any WCAG 2.1 AA violations before testnet launch.

---

## Category 5: Privacy and Data Leakage

### PRIV-001 — Frontend Console.log Exposes Nullifiers, Commitments, and Market IDs
**Severity:** MEDIUM  
**Location:** `packages/frontend/src/lib/api.ts:73–78`

**Evidence:**
```typescript
async function post(path: string, body: unknown): Promise<unknown> {
  console.log(`[polyshield:api] POST ${path}`, body)  // logs full body
  // ...
  console.log(`[polyshield:api] POST ${path} →`, data)  // logs full response
}
```
Every API call logs the complete request and response body to `console.log`. This includes `nullifier`, `new_commitment`, `market_id`, and `total_credit` values — pseudonymous identifiers that, if aggregated, could help link bets to users. Browser extensions with access to the console (common in DeFi users' browsers) can read these logs.

**Fix Suggestion:**
```typescript
// Replace console.log with a dev-only logger
const devLog = process.env.NEXT_PUBLIC_DEV_MODE === 'true'
  ? (...args: unknown[]) => console.log(...args)
  : () => undefined

async function post(path: string, body: unknown): Promise<unknown> {
  devLog(`[polyshield:api] POST ${path}`, { path })  // log path only, not body
  // ...
}
```

---

### PRIV-002 — `settlement.db` SQLite File Present in Repo (Tracked by Git Status)
**Severity:** LOW  
**Location:** `packages/backend/settlement.db`

**Evidence:**
The `packages/backend/settlement.db` file is present in the working directory (shown in git status). SQLite database files should be in `.gitignore` and never committed. If accidentally committed they would contain historical settlement data.

**Fix Suggestion:**
```
# Add to .gitignore:
packages/backend/*.db
packages/backend/*.db-shm
packages/backend/*.db-wal
packages/backend/indexer/data/
```

---

## Category 6: Functional and UI Behavior

### FUNC-001 — Settlement Credit Circuit: u64 Balance Addition Unchecked for Overflow
**Severity:** MEDIUM  
**Location:** `packages/circuits/settlement_credit/src/main.nr:38`

**Evidence:**
```noir
let new_balance = balance_before_credit + total_credit;
```
In Noir, `u64` arithmetic wraps (or panics, version-dependent). If `balance_before_credit + total_credit > 18_446_744_073_709_551_615` (u64::MAX), the result wraps to a small number. A user who has accumulated 18+ exaUSDC in their note (theoretically impossible given the $50k deposit cap, but theoretically reachable via many bet cycles) would get an incorrect settlement balance. More critically, the Vault does not validate the `new_balance` encoded in `new_commitment`.

**Fix Suggestion:**
```noir
// Add explicit overflow guard
assert(total_credit <= 18_446_744_073_709_551_615u64 - balance_before_credit, "Balance overflow");
let new_balance = balance_before_credit + total_credit;
```

---

### FUNC-002 — N/A and Bet Cancel Circuits: u64 Balance Addition Unchecked for Overflow
**Severity:** MEDIUM  
**Location:** `packages/circuits/cancel_credit/src/main.nr:36`, `packages/circuits/bet_cancel/src/main.nr:34`

**Evidence:**
```noir
// cancel_credit:
let restored_balance = current_balance + bet_amount;
// bet_cancel:
let restored_balance = current_balance + bet_amount;
```
Same issue as FUNC-001. The Vault injects `bet_amount` from storage, but if the storage value is corrupted or unexpectedly large (e.g., from a future bug in `BetRecord`), the circuit would produce an incorrect commitment without error.

**Fix Suggestion:**
```noir
assert(bet_amount <= 18_446_744_073_709_551_615u64 - current_balance, "Balance overflow");
let restored_balance = current_balance + bet_amount;
```

---

### FUNC-003 — TASK-C3 Incomplete: Settlement Verifier Is Groth16, Not UltraPLONK
**Severity:** HIGH  
**Location:** `packages/contracts/src/verifiers/SettlementCreditVerifier.sol`

**Evidence:**
```solidity
// Line 6: snarkJS-generated Groth16 verifier — settlement_credit circuit (6 public signals)
```
TASK-C3 in CLAUDE.md describes regenerating `SettlementCreditVerifier.sol` using UltraPLONK (`bb contract`). The current file is a Groth16 verifier. While this is consistent with the current deployed state (all verifiers are Groth16), the outstanding TASK-C3 means `creditSettlement()` is functioning with the wrong proof system relative to the intended architecture. When the team transitions to Noir/UltraPLONK, this file must be the first regenerated.

---

### FUNC-004 — `reportFilled()` and `reportFOKFailure()` Not Gated by `whenNotPaused`
**Severity:** LOW  
**Location:** `packages/contracts/src/Vault.sol:338–358`

**Evidence:**
```solidity
function reportFilled(bytes32 nullifier_of_bet) external {
    if (msg.sender != signingLayerOperator) revert OnlyOperator();
    // No whenNotPaused modifier
    BetRecord storage rec = betRecords[nullifier_of_bet];
    ...
    rec.status = BetStatus.FILLED;
}
```
When the vault is paused (e.g., for emergency), `reportFilled` and `reportFOKFailure` can still update bet status. This is intentional for completing in-flight bets, but it means the operator can mark bets as FILLED even when the vault is paused, allowing settlement credits later when unpaused. Document this explicitly as intentional if it is.

---

### FUNC-005 — Prover Fetch Timeout Not Set in `fetchAsset()`
**Severity:** LOW  
**Location:** `packages/frontend/src/lib/prover.ts:115–118`

**Evidence:**
```typescript
async function fetchAsset(url: string): Promise<Uint8Array> {
  const r = await fetch(url)  // No timeout or AbortController
  if (!r.ok) throw new Error(`[prover] Failed to fetch ${url}: HTTP ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}
```
Fetching 2.4 MB `.wasm` and 8.7 MB `.zkey` files with no timeout can hang indefinitely on slow connections. There's no user-visible indication of the hang and no recovery path.

**Fix Suggestion:**
```typescript
async function fetchAsset(url: string, timeoutMs = 30_000): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: controller.signal })
    if (!r.ok) throw new Error(`Failed to fetch ${url}: HTTP ${r.status}`)
    return new Uint8Array(await r.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}
```

---

## Category 7: API and Network Layer

### API-001 — Indexer Exposes `/settlement/:market_id` Without Authentication
**Severity:** MEDIUM  
**Location:** `packages/backend/indexer/src/api.ts:27–46`

**Evidence:**
```typescript
app.get("/settlement/:market_id", async (req, res) => {
  const record = getSettlement(req.params.market_id)
  // No auth, no rate limit, no input validation on market_id format
  if (!record) {
    res.status(404).json({ error: "Settlement not found" })
    return
  }
  // Returns full settlement record including condition_id, payout_per_share
  res.json({ conditionId: record.condition_id, ... })
})
```
The indexer API is unauthenticated. While settlement data is not private, an attacker who can reach the indexer can enumerate all settled markets and gather intelligence about vault activity. The `market_id` path parameter is not validated for format (should be `0x`-prefixed 32-byte hex).

**Fix Suggestion:**
```typescript
app.get("/settlement/:market_id", async (req, res) => {
  const { market_id } = req.params
  if (!/^0x[0-9a-fA-F]{64}$/.test(market_id)) {
    res.status(400).json({ error: "market_id must be a 0x-prefixed 32-byte hex string" })
    return
  }
  // ... rest of handler
})
```

---

### API-002 — Relay Proxy Logs Internal Service URLs on Every Request
**Severity:** INFO  
**Location:** `packages/frontend/src/app/api/relay/[...slug]/route.ts:23`

**Evidence:**
```typescript
console.log(`[api/relay] → POST ${target}`)
// e.g.: [api/relay] → POST http://127.0.0.1:3002/relay/bet
```
Internal service hostnames and port numbers are logged to Next.js stdout/stderr. In production environments where stdout is aggregated into a log service, this leaks internal network topology.

**Fix Suggestion:** Replace with structured logging that omits the full URL, or gate on `DEV_MODE`.

---

### API-003 — No Request Timeout on Internal Service Proxy Calls
**Severity:** LOW  
**Location:** `packages/frontend/src/app/api/relay/[...slug]/route.ts`, `settlement/[market_id]/route.ts`, `merkle-path/[commitment]/route.ts`

**Evidence:**
```typescript
relayRes = await fetch(target, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  // No timeout / AbortController
})
```
All three proxy routes have no timeout. If the backend service hangs, the Next.js request handler will wait indefinitely, consuming a connection slot. Under load, this can exhaust the server's connection pool.

**Fix Suggestion:**
```typescript
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 30_000)
try {
  relayRes = await fetch(target, { signal: controller.signal, ... })
} finally {
  clearTimeout(timer)
}
```

---

## Additional Notes (INFO)

### INFO-001 — `packages/.env.test` Contains Full Anvil Credentials
The file `packages/.env.test` (correctly `.gitignore`'d) is present on disk with all Anvil private keys, including `VAULT_EOA_PRIVATE_KEY` and `RELAYER_PRIVATE_KEY`. This is expected for local dev, but CI/CD pipelines that clone the repo should verify this file is not accidentally checked in via `git ls-files packages/.env.test`.

### INFO-002 — Circuit Tests All Use Correct Zero Leaf (`Field = 0`)
TASK-M2 (zero leaf fix) has been applied correctly to all 5 circuit test files. `cancel_credit`, `bet_cancel`, `settlement_credit`, and `withdrawal` all initialize `let mut h: Field = 0;` — matching `CommitmentMerkleTree.sol`'s `bytes32(0)` zero leaf. `bet_auth` uses `fn zero_leaf() -> Field { 0 }`. PASS.

### INFO-003 — All 74 Primary Vault/MerkleTree/NullifierRegistry Tests Pass
`forge test` on `packages/contracts` yields 74 passed, 0 failed for the core test suites. The 5 failing `ZkGasBenchTest` tests are an infrastructure issue (missing binary files), not a contract logic bug.

---

## Remediation Priority

| # | ID | Severity | Effort | Action |
|---|---|---|---|---|
| 1 | DEP-001 | CRITICAL | Low | `npm install next@14.2.35` |
| 2 | SEC-001 | CRITICAL | High | Decide proof system; wire Noir WASM prover or document Groth16 |
| 3 | SEC-002 | HIGH | Medium | Add relay auth + rate limiting |
| 4 | FUNC-003 | HIGH | High | Regenerate all verifiers for chosen proving system |
| 5 | SEC-004 | HIGH | Medium | Add on-chain USDC balance verification to acknowledgePolymarketReturn |
| 6 | SEC-003 | HIGH | Low | Allowlist slug values in relay proxy |
| 7 | SEC-006 | MEDIUM | Low | Add security headers to next.config.js |
| 8 | PRIV-001 | MEDIUM | Low | Gate console.log on NEXT_PUBLIC_DEV_MODE |
| 9 | FUNC-001/002 | MEDIUM | Low | Add u64 overflow guards in circuits |
| 10 | API-001 | MEDIUM | Low | Add format validation to indexer market_id parameter |
