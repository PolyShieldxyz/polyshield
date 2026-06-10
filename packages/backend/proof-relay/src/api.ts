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

// Source IP is NEVER logged — see pino redact config in index.ts
const logger = pino({ name: "proof-relay-api" });

// API-004: allowlist of known Vault custom-error names. Any error whose message
// contains one of these is surfaced verbatim (it leaks nothing sensitive); every
// other error is collapsed to a generic message + correlation id. The full error
// is always logged server-side under that id.
const KNOWN_VAULT_ERRORS = [
  "BetNotFilled",
  "NullifierSpent",
  "UnknownRoot",
  "InvalidProof",
  "BetNotFound",
  "WrongMarket",
  "BetNotCancellable",
  "ConditionNotResolved",
  "NotNA",
] as const;

/**
 * API-004: produce a SAFE client-facing error response and log the full error
 * server-side under a correlation id. Known Vault custom errors are mapped to
 * their clean name; everything else returns a generic "relay failed".
 */
function safeError(logger: pino.Logger, context: string, err: unknown): { error: string; ref: string } {
  const ref = crypto.randomBytes(8).toString("hex");
  logger.error({ err, ref, context }, `${context} failed`);

  let message = "";
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e["reason"] === "string") message += e["reason"];
    if (typeof e["message"] === "string") message += " " + (e["message"] as string);
  }
  const matched = KNOWN_VAULT_ERRORS.find((name) => message.includes(name));
  return { error: matched ?? "relay failed", ref };
}

let _provider: ethers.JsonRpcProvider | null = null;
let _treeAddress: string | null = null;
let _vaultAddress: string | null = null;
let _treeDeployBlock = 0; // start block for merkle-path log scans (tree deploy block)
let _merkleCache: { proofFor: (commitment: string) => unknown } | null = null;

/** Register the backend Merkle read-cache. The /merkle-path route serves from it (O(depth), no chain
 * call) and falls back to on-the-fly computation on a cache miss / inconsistency. */
export function setMerkleCache(cache: { proofFor: (commitment: string) => unknown }): void {
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
    try {
      // Fast path: serve from the backend cache (O(depth) in-memory, no chain query). Returns null on
      // a cache miss (leaf not yet ingested / cache not ready / diverged) → fall back to the
      // authoritative on-the-fly reconstruction below.
      const cached = _merkleCache?.proofFor(commitment) as
        | { path: string[]; pathIndices: number[]; root: string; leafIndex: number }
        | null
        | undefined;
      if (cached) {
        logger.info({ commitment, leafIndex: cached.leafIndex, source: "cache" }, "merkle-path served");
        res.json(cached);
        return;
      }
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

  return app;
}
