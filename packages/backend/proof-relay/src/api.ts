import express from "express";
import pino from "pino";
import { ethers } from "ethers";
import {
  relayAuthorizeBet,
  relayCreditSettlement,
  relayWithdraw,
  relayBetCancellationCredit,
  relayNACancellationCredit,
} from "./relayer";
import { computeMerkleProof } from "./merkle";

// Source IP is NEVER logged — see pino redact config in index.ts
const logger = pino({ name: "proof-relay-api" });

/**
 * Extract a human-readable revert reason from an ethers.js error.
 * For `require(cond, "message")` reverts, err.reason contains the string.
 * For custom errors (revert BetNotFilled()), err.message contains the selector name.
 * Falls back to the full message truncated at 200 chars.
 */
function extractRevertReason(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e["reason"] === "string" && e["reason"]) return e["reason"];
    if (typeof e["message"] === "string") {
      const msg = e["message"] as string;
      // ethers wraps custom errors like: "execution reverted (unknown custom error)"
      // or: 'execution reverted: "BetNotFilled()"'
      // Surface the first 200 chars which usually contains the selector name.
      return msg.slice(0, 200);
    }
  }
  return "relay failed";
}

let _provider: ethers.JsonRpcProvider | null = null;
let _treeAddress: string | null = null;
let _vaultAddress: string | null = null;

export function initMerkle(provider: ethers.JsonRpcProvider, treeAddress: string, vaultAddress?: string): void {
  _provider = provider;
  _treeAddress = treeAddress;
  if (vaultAddress) _vaultAddress = vaultAddress;
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

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/relay/bet", async (req, res) => {
    const { proof, inputs } = req.body;
    if (!proof || !inputs) {
      res.status(400).json({ error: "proof and inputs required" });
      return;
    }
    try {
      const txHash = await relayAuthorizeBet(proof, inputs);
      logger.info({ txHash }, "authorizeBet relayed");
      res.json({ txHash });
    } catch (err) {
      logger.error({ err }, "authorizeBet relay failed");
      res.status(500).json({ error: extractRevertReason(err) });
    }
  });

  app.post("/relay/settlement", async (req, res) => {
    const { proof, inputs } = req.body;
    if (!proof || !inputs) {
      res.status(400).json({ error: "proof and inputs required" });
      return;
    }
    // Pre-flight: confirm the signing layer has called reportFilled on-chain.
    // If the bet is still ACTIVE the Vault will revert with BetNotFilled — surface
    // a clear 409 instead of burning a nonce and returning an opaque 500.
    const nullifierOfBet = (inputs as Record<string, string>)["nullifier_of_bet"];
    if (nullifierOfBet) {
      const { ok, status } = await checkBetFilled(nullifierOfBet);
      if (!ok) {
        const label = status === BET_STATUS.ACTIVE ? "not yet filled by signing layer — retry after reportFilled is confirmed"
          : status === BET_STATUS.FAILED ? "bet was FOK-failed; use /relay/bet-cancel instead"
          : status === BET_STATUS.CREDITED ? "settlement already claimed"
          : `unexpected bet status ${status}`;
        logger.warn({ nullifierOfBet, betStatus: status }, "creditSettlement pre-flight failed");
        res.status(409).json({ error: `bet ${label}` });
        return;
      }
    }
    try {
      const txHash = await relayCreditSettlement(proof, inputs);
      logger.info({ txHash }, "creditSettlement relayed");
      res.json({ txHash });
    } catch (err) {
      logger.error({ err }, "creditSettlement relay failed");
      const msg = extractRevertReason(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/relay/withdrawal", async (req, res) => {
    const { proof, inputs, recipientAddress } = req.body;
    if (!proof || !inputs || !recipientAddress) {
      res.status(400).json({ error: "proof, inputs, and recipientAddress required" });
      return;
    }
    try {
      const txHash = await relayWithdraw(proof, inputs, recipientAddress);
      logger.info({ txHash }, "withdraw relayed");
      res.json({ txHash });
    } catch (err) {
      logger.error({ err }, "withdraw relay failed");
      res.status(500).json({ error: extractRevertReason(err) });
    }
  });

  app.post("/relay/bet-cancel", async (req, res) => {
    const { proof, inputs } = req.body;
    if (!proof || !inputs) {
      res.status(400).json({ error: "proof and inputs required" });
      return;
    }
    try {
      const txHash = await relayBetCancellationCredit(proof, inputs);
      logger.info({ txHash }, "betCancellationCredit relayed");
      res.json({ txHash });
    } catch (err) {
      logger.error({ err }, "betCancellationCredit relay failed");
      res.status(500).json({ error: extractRevertReason(err) });
    }
  });

  app.post("/relay/na-cancel", async (req, res) => {
    const { proof, inputs } = req.body;
    if (!proof || !inputs) {
      res.status(400).json({ error: "proof and inputs required" });
      return;
    }
    try {
      const txHash = await relayNACancellationCredit(proof, inputs);
      logger.info({ txHash }, "naCancellationCredit relayed");
      res.json({ txHash });
    } catch (err) {
      logger.error({ err }, "naCancellationCredit relay failed");
      res.status(500).json({ error: extractRevertReason(err) });
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
      const proof = await computeMerkleProof(_treeAddress, commitment, _provider);
      if (!proof) {
        res.status(404).json({ error: "commitment not found in tree" });
        return;
      }
      logger.info({ commitment, leafIndex: proof.leafIndex }, "merkle-path served");
      res.json(proof);
    } catch (err) {
      logger.error({ err, commitment }, "merkle-path error");
      res.status(500).json({ error: "merkle path computation failed" });
    }
  });

  return app;
}
