import express from "express";
import rateLimit from "express-rate-limit";
import pino from "pino";
import crypto from "crypto";
import { z } from "zod";
import { ethers } from "ethers";
import {
  relayAuthorizeBet,
  relayCreditSettlement,
  relayWithdraw,
  relayBetCancellationCredit,
  relayNACancellationCredit,
  relayClosePosition,
  relayPartialFillCredit,
  relayConsolidate,
} from "./relayer";
import { computeMerkleProof } from "./merkle";
import {
  queryCatalog,
  getMarketByCondition,
  ingestByConditionId,
  resolveMarketName,
  searchMarkets,
  fetchMidpoints,
} from "./marketCatalog";
import { recordEvents } from "./analytics";
import { recordConsent, hasConsent, ConsentError, CONSENT_VERSION } from "./betaConsent";

// Source IP is NEVER logged — see pino redact config in index.ts
const logger = pino({ name: "proof-relay-api" });

// API-004 + legibility: the Vault reverts with custom errors. On a metered RPC ethers reports them
// as "unknown custom error" with only the raw 4-byte selector in `data` (the relay's call ABI does
// not carry the error defs), so a name-substring match never fires and everything collapsed to the
// useless "relay failed". We decode the selector against the full Vault error set and return a clear,
// actionable message (the error NAME is protocol-level, not sensitive). The full error is still
// logged server-side under a correlation id.
const VAULT_ERROR_SIGS = [
  "AlreadyPartiallyClosed()", "AttestationMismatch()", "AttestationRequired()", "BadRecipient()",
  "BelowMinimum()", "BetNotActive()", "BetNotCancellable()", "BetNotClosing()", "BetNotFailed()",
  "BetNotFilled()", "BetNotFound()", "BetNotPartialFillable()", "BetNotPartialFilled()",
  "BetNotReportable()", "BetTimeoutNotElapsed()", "CannotCloseResolvedMarket()", "ConditionNotRegistered()",
  "ConditionNotResolved()", "DeployCapExceeded()", "DepositCapExceeded()", "EmptyConsolidation()",
  "InsufficientLiquidity(uint256,uint256)", "InsufficientVaultLiquidity()", "InvalidAmount()",
  "InvalidAttestation()", "InvalidFilledShares()", "InvalidProof()", "InvalidSoldShares()",
  "InvalidSpentAmount()", "MarketAlreadyResolved()", "MarketNotResolved()", "NonMonotonicProceeds()",
  "NotFeeRecipient()", "NotNA()", "NullifierSpent()", "OnlyOperator()", "PayoutRoundsToZero()",
  "UnknownRoot()", "VerifierTimelockActive()", "WrongMarket()", "ZeroAddress()",
];
const VAULT_ERRORS_IFACE = new ethers.Interface(VAULT_ERROR_SIGS.map((s) => `error ${s}`));

// User-actionable hints for the errors a depositor can actually hit + resolve. Anything else falls
// back to the decoded error name (still legible), then to "relay failed" if undecodable.
const ERROR_HINTS: Record<string, string> = {
  NullifierSpent: "This note was already spent — your wallet is out of sync with the chain. Open Portfolio → Restore to recover your notes, then retry.",
  UnknownRoot: "Your note's Merkle root is no longer in the vault's recent window — recover your notes (Portfolio → Restore) and retry.",
  InvalidProof: "Proof verification failed (often a fee or input mismatch). Refresh the page and try again.",
  BelowMinimum: "Amount is below the minimum allowed.",
  DepositCapExceeded: "This would exceed the $50,000 per-address deposit cap.",
  InsufficientLiquidity: "The vault is temporarily short on USDC to pay this out — try a smaller amount or retry shortly.",
  ConditionNotResolved: "This market hasn't resolved yet — settlement isn't available.",
  MarketNotResolved: "This market hasn't resolved yet — settlement isn't available.",
  BadRecipient: "Withdrawals can only go to your depositing wallet.",
  BetNotFound: "No matching bet was found on-chain for this note.",
};

/** Pull the raw revert selector (0x........) out of an ethers v6 error, from any of the shapes it uses. */
function extractRevertData(err: unknown): string | null {
  const e = err as { data?: unknown; info?: { error?: { data?: unknown } }; error?: { data?: unknown }; message?: unknown };
  for (const c of [e?.data, e?.info?.error?.data, e?.error?.data]) {
    if (typeof c === "string" && /^0x[0-9a-fA-F]{8}/.test(c)) return c;
  }
  const m = typeof e?.message === "string" ? e.message.match(/data="?(0x[0-9a-fA-F]{8,})"?/) : null;
  return m ? m[1] : null;
}

/** Decode a reverted relay error to a Vault error name + actionable hint, or null if undecodable. */
function decodeVaultError(err: unknown): { name: string; hint?: string } | null {
  const data = extractRevertData(err);
  if (!data) return null;
  try {
    const d = VAULT_ERRORS_IFACE.parseError(data);
    if (d) return { name: d.name, hint: ERROR_HINTS[d.name] };
  } catch {
    /* not a known Vault custom error */
  }
  return null;
}

/**
 * API-004: produce a SAFE, ACTIONABLE client-facing error and log the full error server-side under a
 * correlation id. Decodes the Vault custom-error selector to a clear message + machine `code`; falls
 * back to a name-in-message match, then a generic message.
 */
function safeError(
  logger: pino.Logger,
  context: string,
  err: unknown,
): { error: string; code?: string; ref: string } {
  const ref = crypto.randomBytes(8).toString("hex");
  logger.error({ err, ref, context }, `${context} failed`);

  const decoded = decodeVaultError(err);
  if (decoded) return { error: decoded.hint ?? decoded.name, code: decoded.name, ref };

  // Fallback: some providers do include the name in the reason/message string.
  let message = "";
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e["reason"] === "string") message += e["reason"];
    if (typeof e["message"] === "string") message += " " + (e["message"] as string);
  }
  const matched = VAULT_ERROR_SIGS.map((s) => s.split("(")[0]).find((name) => message.includes(name));
  return { error: matched ?? "relay failed", code: matched, ref };
}

let _provider: ethers.JsonRpcProvider | null = null;
let _treeAddress: string | null = null;
let _vaultAddress: string | null = null;
let _treeDeployBlock = 0; // start block for merkle-path log scans (tree deploy block)
interface MerkleCacheLike {
  proofFor: (commitment: string) => unknown;
  syncNow: () => Promise<void>;
  isReady: () => boolean;
}
let _merkleCache: MerkleCacheLike | null = null;

/** Register the backend Merkle read-cache. The /merkle-path route serves from it (O(depth), no chain
 * call). On a miss it does a quick incremental catch-up (syncNow) for a freshly-inserted leaf, and
 * only falls back to the slow full-from-deploy reconstruction when the cache is unavailable/diverged. */
export function setMerkleCache(cache: MerkleCacheLike): void {
  _merkleCache = cache;
}

interface EventIndexLike {
  isReady: () => boolean;
  recoveryData: (depositor: string) => { deposits: unknown[]; spends: unknown[] };
  blockTimestamps: (blocks: number[]) => Record<number, number>;
  allEvents: (limit?: number) => Array<{ type: string; blockNumber: number; logIndex: number; txHash: string; blockTs: number | null; args: Record<string, unknown> }>;
}
let _eventIndex: EventIndexLike | null = null;
export function setEventIndex(idx: EventIndexLike): void {
  _eventIndex = idx;
}

export function initMerkle(
  provider: ethers.JsonRpcProvider,
  treeAddress: string,
  vaultAddress?: string,
  treeDeployBlock?: number,
): void {
  _provider = provider;
  _treeAddress = treeAddress;
  if (vaultAddress) _vaultAddress = vaultAddress;
  if (treeDeployBlock && treeDeployBlock > 0) _treeDeployBlock = treeDeployBlock;
}

const BET_RECORDS_ABI = [
  "function betRecords(bytes32 nullifier) view returns (bytes32 market_id, bytes32 condition_id, bytes32 position_id, uint64 expected_shares, uint64 bet_amount, uint8 outcome_side, uint8 status)",
];

// BetStatus enum order from Vault.sol
const BET_STATUS = { ACTIVE: 0, FILLED: 1, FAILED: 2, CREDITED: 3, CANCELLED_CREDITED: 4 };

async function checkBetFilled(nullifierOfBet: string): Promise<{ ok: boolean; status: number }> {
  if (!_provider || !_vaultAddress) return { ok: true, status: -1 };
  try {
    const vault = new ethers.Contract(_vaultAddress, BET_RECORDS_ABI, _provider);
    const rec = await (vault as ethers.Contract & {
      betRecords: (n: string) => Promise<[string, string, string, bigint, bigint, bigint, bigint]>
    }).betRecords(nullifierOfBet);
    const status = Number(rec[6]); // ethers v6 returns all uint types as BigInt
    return { ok: status === BET_STATUS.FILLED, status };
  } catch {
    return { ok: true, status: -1 }; // if read fails, let the tx attempt surface the real error
  }
}

// API-003: zod schemas validating the public-input objects for each relay route,
// applied BEFORE the relay function allocates a nonce. Numeric fields arrive as
// decimal strings; HEX32 = 0x-prefixed 32-byte hex. Mirrors the rigor of the
// /merkle-path/:commitment regex check below.
const HEX32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const NUM = z.string().regex(/^[0-9]+$/); // 1e6-scaled decimal integer string
const PROOF = z.string().regex(/^0x[0-9a-fA-F]*$/); // 0x hex blob

const betInputsSchema = z.object({
  merkle_root: HEX32,
  nullifier: HEX32,
  new_commitment: HEX32,
  bet_amount: NUM,
  price: NUM,
  expected_shares: NUM,
  market_id: HEX32,
  outcome_side: NUM,
  position_id: HEX32,
});
const settlementInputsSchema = z.object({
  merkle_root: HEX32,
  nullifier: HEX32,
  new_commitment: HEX32,
  nullifier_of_bet: HEX32,
  market_id: HEX32,
  total_credit: NUM,
});
const withdrawalInputsSchema = z.object({
  merkle_root: HEX32,
  nullifier: HEX32,
  withdrawal_amount: NUM,
  recipient_hash: HEX32,
  new_commitment: HEX32,
});
// bet-cancel / close / partial-credit all share the 4-field shape.
const fourFieldInputsSchema = z.object({
  merkle_root: HEX32,
  nullifier: HEX32,
  new_commitment: HEX32,
  nullifier_of_bet: HEX32,
});
const naCancelInputsSchema = z.object({
  merkle_root: HEX32,
  nullifier: HEX32,
  new_commitment: HEX32,
  nullifier_of_bet: HEX32,
  market_id: HEX32,
});

// FC-9: optional operator EIP-712 attestation forwarded with a credit proof. Present for an
// ACTIVE bet (full fill / fail / partial / sold); absent when the bet is already FILLED/FAILED.
const attestationSchema = z
  .object({
    nullifierOfBet: HEX32,
    reportType: z.number().int().min(1).max(4),
    amountA: NUM,
    amountB: NUM,
  })
  .optional();
const SIG = z.string().regex(/^0x[0-9a-fA-F]*$/).optional();

const betSchema = z.object({ proof: PROOF, inputs: betInputsSchema });
const settlementSchema = z.object({
  proof: PROOF,
  inputs: settlementInputsSchema,
  attestation: attestationSchema,
  signature: SIG,
});
const withdrawalSchema = z.object({
  proof: PROOF,
  inputs: withdrawalInputsSchema,
  recipientAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});
const betCancelSchema = z.object({ proof: PROOF, inputs: fourFieldInputsSchema, attestation: attestationSchema, signature: SIG });
const naCancelSchema = z.object({ proof: PROOF, inputs: naCancelInputsSchema, attestation: attestationSchema, signature: SIG });
const closeSchema = z.object({ proof: PROOF, inputs: fourFieldInputsSchema, attestation: attestationSchema, signature: SIG });
const partialCreditSchema = z.object({ proof: PROOF, inputs: fourFieldInputsSchema, attestation: attestationSchema, signature: SIG });
// FC-8: consolidate — exactly 4 nullifiers (HEX32 also matches the 0x00..00 inactive sentinel).
const consolidateInputsSchema = z.object({
  merkle_root: HEX32,
  nullifiers: z.array(HEX32).length(4),
  new_commitment: HEX32,
});
const consolidateSchema = z.object({ proof: PROOF, inputs: consolidateInputsSchema });

export function createApp(): express.Application {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Log every incoming request (path + method + body size, never source IP)
  app.use((req, res, next) => {
    const start = Date.now();
    const bodySize = req.headers["content-length"] ? parseInt(req.headers["content-length"]) : 0;
    logger.info({ event: "request:in", method: req.method, path: req.path, body_bytes: bodySize }, "request:in");
    res.on("finish", () => {
      logger.info({ event: "request:out", method: req.method, path: req.path, status: res.statusCode, duration_ms: Date.now() - start }, "request:out");
    });
    next();
  });

  // API-002: rate-limit the relay surface (20 req/min per client) before routing.
  app.use(
    "/relay",
    rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }),
  );

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/relay/bet", async (req, res) => {
    const parsed = betSchema.safeParse(req.body); // API-003
    if (!parsed.success) {
      res.status(400).json({ error: "invalid inputs" });
      return;
    }
    const { proof, inputs } = parsed.data;
    try {
      const txHash = await relayAuthorizeBet(proof, inputs);
      logger.info({ txHash }, "authorizeBet relayed");
      res.json({ txHash });
    } catch (err) {
      res.status(500).json(safeError(logger, "authorizeBet relay", err)); // API-004
    }
  });

  app.post("/relay/settlement", async (req, res) => {
    const parsed = settlementSchema.safeParse(req.body); // API-003
    if (!parsed.success) {
      res.status(400).json({ error: "invalid inputs" });
      return;
    }
    const { proof, inputs, attestation, signature } = parsed.data;
    // FC-9 pre-flight: settlement is valid for a FILLED bet (no attestation) OR an ACTIVE bet
    // carrying a FILLED attestation. Only short-circuit clearly-terminal states (already
    // claimed / FOK-failed) to avoid burning a nonce; everything else hits the Vault, which
    // gives the precise revert.
    const nullifierOfBet = (inputs as Record<string, string>)["nullifier_of_bet"];
    if (nullifierOfBet) {
      // API-008: reject a present-but-malformed nullifier before any contract read.
      if (!/^0x[0-9a-fA-F]{64}$/.test(nullifierOfBet)) {
        res.status(400).json({ error: "invalid inputs" });
        return;
      }
      const { status } = await checkBetFilled(nullifierOfBet);
      const terminal =
        status === BET_STATUS.CREDITED ? "settlement already claimed"
        : status === BET_STATUS.FAILED ? "bet was FOK-failed; use /relay/bet-cancel instead"
        : status === BET_STATUS.ACTIVE && !attestation ? "not yet filled — include the operator fill attestation"
        : null;
      if (terminal) {
        logger.warn({ nullifierOfBet, betStatus: status }, "creditSettlement pre-flight failed");
        res.status(409).json({ error: `bet ${terminal}` });
        return;
      }
    }
    try {
      const txHash = await relayCreditSettlement(proof, inputs, attestation, signature);
      logger.info({ txHash }, "creditSettlement relayed");
      res.json({ txHash });
    } catch (err) {
      res.status(500).json(safeError(logger, "creditSettlement relay", err)); // API-004
    }
  });

  app.post("/relay/withdrawal", async (req, res) => {
    const parsed = withdrawalSchema.safeParse(req.body); // API-003
    if (!parsed.success) {
      res.status(400).json({ error: "invalid inputs" });
      return;
    }
    const { proof, inputs, recipientAddress } = parsed.data;
    try {
      const txHash = await relayWithdraw(proof, inputs, recipientAddress);
      logger.info({ txHash }, "withdraw relayed");
      res.json({ txHash });
    } catch (err) {
      res.status(500).json(safeError(logger, "withdraw relay", err)); // API-004
    }
  });

  app.post("/relay/bet-cancel", async (req, res) => {
    const parsed = betCancelSchema.safeParse(req.body); // API-003
    if (!parsed.success) {
      res.status(400).json({ error: "invalid inputs" });
      return;
    }
    const { proof, inputs, attestation, signature } = parsed.data;
    try {
      const txHash = await relayBetCancellationCredit(proof, inputs, attestation, signature);
      logger.info({ txHash }, "betCancellationCredit relayed");
      res.json({ txHash });
    } catch (err) {
      res.status(500).json(safeError(logger, "betCancellationCredit relay", err)); // API-004
    }
  });

  app.post("/relay/na-cancel", async (req, res) => {
    const parsed = naCancelSchema.safeParse(req.body); // API-003
    if (!parsed.success) {
      res.status(400).json({ error: "invalid inputs" });
      return;
    }
    const { proof, inputs, attestation, signature } = parsed.data;
    try {
      const txHash = await relayNACancellationCredit(proof, inputs, attestation, signature);
      logger.info({ txHash }, "naCancellationCredit relayed");
      res.json({ txHash });
    } catch (err) {
      res.status(500).json(safeError(logger, "naCancellationCredit relay", err)); // API-004
    }
  });

  // FC-1: relay a position-close credit proof (pre-settlement secondary sale).
  app.post("/relay/close", async (req, res) => {
    const parsed = closeSchema.safeParse(req.body); // API-003
    if (!parsed.success) {
      res.status(400).json({ error: "invalid inputs" });
      return;
    }
    const { proof, inputs, attestation, signature } = parsed.data;
    try {
      const txHash = await relayClosePosition(proof, inputs, attestation, signature);
      logger.info({ txHash }, "closePosition relayed");
      res.json({ txHash });
    } catch (err) {
      res.status(500).json(safeError(logger, "closePosition relay", err)); // API-004
    }
  });

  // FC-4: relay a partial-fill credit proof (limit order partially filled then terminated).
  app.post("/relay/partial-credit", async (req, res) => {
    const parsed = partialCreditSchema.safeParse(req.body); // API-003
    if (!parsed.success) {
      res.status(400).json({ error: "invalid inputs" });
      return;
    }
    const { proof, inputs, attestation, signature } = parsed.data;
    try {
      const txHash = await relayPartialFillCredit(proof, inputs, attestation, signature);
      logger.info({ txHash }, "partialFillCredit relayed");
      res.json({ txHash });
    } catch (err) {
      res.status(500).json(safeError(logger, "partialFillCredit relay", err)); // API-004
    }
  });

  // FC-8: relay a note-consolidation proof (merge up to 4 notes into one).
  app.post("/relay/consolidate", async (req, res) => {
    const parsed = consolidateSchema.safeParse(req.body); // API-003
    if (!parsed.success) {
      res.status(400).json({ error: "invalid inputs" });
      return;
    }
    const { proof, inputs } = parsed.data;
    try {
      const txHash = await relayConsolidate(proof, inputs);
      logger.info({ txHash }, "consolidate relayed");
      res.json({ txHash });
    } catch (err) {
      res.status(500).json(safeError(logger, "consolidate relay", err)); // API-004
    }
  });

  // GET /merkle-path/:commitment
  // Returns the Merkle inclusion proof for the given leaf commitment.
  // The frontend uses this to build ZK proof witnesses.
  app.get("/merkle-path/:commitment", async (req, res) => {
    if (!_provider || !_treeAddress) {
      res.status(503).json({ error: "merkle provider not initialised" });
      return;
    }
    const { commitment } = req.params;
    if (!/^0x[0-9a-fA-F]{64}$/.test(commitment)) {
      res.status(400).json({ error: "commitment must be 0x-prefixed 32-byte hex" });
      return;
    }
    type CachedProof = { path: string[]; pathIndices: number[]; root: string; leafIndex: number };
    try {
      const cache = _merkleCache;
      if (cache) {
        // Fast path: serve from the backend cache (O(depth) in-memory, no chain query).
        let cached = cache.proofFor(commitment) as CachedProof | null;
        // Cache miss on a healthy cache → almost always a freshly-inserted leaf the poll hasn't
        // ingested yet. Do a quick INCREMENTAL catch-up (only new blocks since the cursor) and
        // re-check — NOT the slow full-from-deploy scan, which is what hung on a metered RPC.
        if (!cached && cache.isReady()) {
          await cache.syncNow();
          cached = cache.proofFor(commitment) as CachedProof | null;
        }
        if (cached) {
          logger.info({ commitment, leafIndex: cached.leafIndex, source: "cache" }, "merkle-path served");
          res.json(cached);
          return;
        }
        // Cache is healthy and caught up to (head − confirmations) but still lacks this leaf: it is
        // either genuinely not in the tree, or inserted within the last few (unconfirmed) blocks.
        // Return fast so the client polls — do NOT trigger a full chain scan.
        if (cache.isReady()) {
          res.status(404).json({ error: "commitment not yet indexed — retry shortly" });
          return;
        }
        // else: cache not ready / diverged → fall through to the authoritative on-chain path.
      }
      // Fallback (cache unavailable or diverged only): authoritative full reconstruction.
      const proof = await computeMerkleProof(_treeAddress, commitment, _provider, {
        fromBlock: _treeDeployBlock,
      });
      if (!proof) {
        res.status(404).json({ error: "commitment not found in tree" });
        return;
      }
      logger.info({ commitment, leafIndex: proof.leafIndex, source: "chain" }, "merkle-path served");
      res.json(proof);
    } catch (err) {
      logger.error({ err, commitment }, "merkle-path error");
      res.status(500).json({ error: "merkle path computation failed" });
    }
  });

  // GET /recovery-data/:depositor
  // Returns the PUBLIC on-chain data the frontend needs to rebuild a wallet's notes WITHOUT scanning
  // the chain through its own RPC: the wallet's Deposited events + all anonymous spend events + the
  // referenced block timestamps + feeConfig + currentRoot. The client does the secret-based matching
  // locally — we never see secrets and cannot link spends to a wallet (privacy preserved).
  app.get("/recovery-data/:depositor", async (req, res) => {
    const { depositor } = req.params;
    if (!/^0x[0-9a-fA-F]{40}$/.test(depositor)) {
      res.status(400).json({ error: "depositor must be a 0x-prefixed 20-byte address" });
      return;
    }
    if (!_eventIndex || !_eventIndex.isReady() || !_provider || !_treeAddress || !_vaultAddress) {
      res.status(503).json({ error: "recovery index not ready" });
      return;
    }
    try {
      const { deposits, spends } = _eventIndex.recoveryData(depositor);
      const blocks = [...new Set([...deposits, ...spends].map((e) => (e as { blockNumber: number }).blockNumber))];
      const blockTimestamps = _eventIndex.blockTimestamps(blocks);

      // feeConfig (betFeeBps, relayGasFeeUSDC) + currentRoot — cheap on-chain state reads.
      const vault = new ethers.Contract(_vaultAddress, [
        "function feeConfig() view returns (uint16 betFeeBps, uint64 relayGasFeeUSDC, uint64 minBet, uint64 withdrawalFeeUSDC, uint64 minWithdrawal, address feeRecipient)",
      ], _provider);
      const tree = new ethers.Contract(_treeAddress, ["function currentRoot() view returns (bytes32)"], _provider);
      let betFeeBps = "0", relayGasFeeUSDC = "0", currentRoot = "0x";
      try { const fc = await vault.feeConfig(); betFeeBps = fc[0].toString(); relayGasFeeUSDC = fc[1].toString(); } catch { /* older vault */ }
      try { currentRoot = await tree.currentRoot(); } catch { /* leave */ }

      res.json({ deposits, spends, blockTimestamps, feeConfig: { betFeeBps, relayGasFeeUSDC }, currentRoot, deployBlock: _treeDeployBlock });
    } catch (err) {
      logger.error({ err, depositor }, "recovery-data error");
      res.status(500).json({ error: "recovery data fetch failed" });
    }
  });

  // GET /events?limit=N — all indexed Vault events (anonymous, public) for the Explorer, served from
  // the backend index so the browser doesn't scan the chain itself.
  app.get("/events", (req, res) => {
    if (!_eventIndex || !_eventIndex.isReady()) {
      res.status(503).json({ error: "event index not ready" });
      return;
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "1000"), 10) || 1000, 1), 5000);
    res.json({ events: _eventIndex.allEvents(limit) });
  });

  // ── FC-15: market catalog (public, anonymous data) ──────────────────────────
  // Light rate-limit on the Gamma-touching/search surface so it can't be abused into upstream load.
  const marketsLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });

  // Browse: paginated/sorted/filtered read from the local catalog (no Gamma call).
  app.get("/markets", marketsLimiter, (req, res) => {
    const { markets, total } = queryCatalog({
      offset: parseInt(String(req.query.offset ?? "0"), 10) || 0,
      limit: parseInt(String(req.query.limit ?? "60"), 10) || 60,
      sort: req.query.sort ? String(req.query.sort) : undefined,
      category: req.query.category ? String(req.query.category) : undefined,
      q: req.query.q ? String(req.query.q) : undefined,
    });
    res.json({ markets, total });
  });

  // Name-only resolution for a conditionId, INCLUDING closed/ended markets (filtered out of the
  // bettable catalog). Lets the portfolio label historical/settled/expired bets instead of showing a
  // hex id. Separate from /markets/:conditionId (which is bettable-only + fetches the order book).
  app.get("/market-name/:conditionId", marketsLimiter, async (req, res) => {
    const cid = String(req.params.conditionId);
    if (!/^0x[0-9a-fA-F]{64}$/.test(cid)) {
      res.status(400).json({ error: "conditionId must be a 0x-prefixed 32-byte hex" });
      return;
    }
    const name = await resolveMarketName(cid);
    if (!name) {
      res.status(404).json({ error: "name not found" });
      return;
    }
    res.json({ name });
  });

  // Live search: local catalog first, then Gamma public-search (upserts long-tail). Registered
  // BEFORE /markets/:conditionId so the literal path wins.
  app.get("/markets/search", marketsLimiter, async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) {
      res.json({ markets: [], wentLive: false });
      return;
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 100);
    try {
      res.json(await searchMarkets(q, limit));
    } catch (err) {
      logger.warn({ err: String(err) }, "market search failed");
      res.json({ markets: [], wentLive: false });
    }
  });

  // Odds overlay: batch CLOB midpoints for the visible markets' token ids.
  app.get("/markets/prices", marketsLimiter, async (req, res) => {
    const ids = String(req.query.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
    if (ids.length === 0) {
      res.json({ prices: {} });
      return;
    }
    try {
      res.json({ prices: await fetchMidpoints(ids) });
    } catch (err) {
      logger.warn({ err: String(err) }, "midpoint fetch failed");
      res.json({ prices: {} });
    }
  });

  // Single market by conditionId — catalog hit, else ingest-on-miss from Gamma. Registered LAST.
  app.get("/markets/:conditionId", marketsLimiter, async (req, res) => {
    const cid = String(req.params.conditionId);
    if (!/^0x[0-9a-fA-F]{64}$/.test(cid)) {
      res.status(400).json({ error: "conditionId must be a 0x-prefixed 32-byte hex" });
      return;
    }
    let market = getMarketByCondition(cid);
    if (!market) {
      try {
        market = await ingestByConditionId(cid);
      } catch { /* fall through to 404 */ }
    }
    if (!market) {
      res.status(404).json({ error: "market not found" });
      return;
    }
    res.json({ market });
  });

  // FC-15: anonymous aggregate analytics — counters only, NO wallet/IP/id (see analytics.ts).
  app.post("/analytics", rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }), (req, res) => {
    const body = req.body as { events?: Array<{ scope?: unknown; key?: unknown }> };
    const events = Array.isArray(body?.events)
      ? body.events
          .map((e) => ({ scope: String(e?.scope ?? ""), key: String(e?.key ?? "") }))
          .filter((e) => e.scope && e.key)
      : [];
    const recorded = events.length > 0 ? recordEvents(events) : 0;
    res.json({ ok: true, recorded });
  });

  // Beta terms acknowledgement (see betaConsent.ts). Records a signed disclaimer per wallet at
  // connect time. Rate-limited; the address it stores is no more sensitive than a public deposit.
  const consentLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

  app.get("/beta-consent/:address", consentLimiter, (req, res) => {
    res.json({ consented: hasConsent(req.params.address), version: CONSENT_VERSION });
  });

  app.post("/beta-consent", consentLimiter, (req, res) => {
    const body = req.body as { address?: unknown; signature?: unknown };
    const address = String(body?.address ?? "");
    const signature = String(body?.signature ?? "");
    if (!address || !signature) {
      res.status(400).json({ error: "address and signature required" });
      return;
    }
    try {
      const { address: addr } = recordConsent(address, signature, Date.now());
      logger.info({ event: "beta-consent:recorded", version: CONSENT_VERSION }, "beta consent recorded");
      res.json({ ok: true, address: addr, version: CONSENT_VERSION });
    } catch (err) {
      if (err instanceof ConsentError) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "could not record consent" });
    }
  });

  return app;
}
