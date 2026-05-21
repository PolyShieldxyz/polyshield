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

let _provider: ethers.JsonRpcProvider | null = null;
let _treeAddress: string | null = null;

export function initMerkle(provider: ethers.JsonRpcProvider, treeAddress: string): void {
  _provider = provider;
  _treeAddress = treeAddress;
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
      res.status(500).json({ error: "relay failed" });
    }
  });

  app.post("/relay/settlement", async (req, res) => {
    const { proof, inputs } = req.body;
    if (!proof || !inputs) {
      res.status(400).json({ error: "proof and inputs required" });
      return;
    }
    try {
      const txHash = await relayCreditSettlement(proof, inputs);
      logger.info({ txHash }, "creditSettlement relayed");
      res.json({ txHash });
    } catch (err) {
      logger.error({ err }, "creditSettlement relay failed");
      res.status(500).json({ error: "relay failed" });
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
      res.status(500).json({ error: "relay failed" });
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
      res.status(500).json({ error: "relay failed" });
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
      res.status(500).json({ error: "relay failed" });
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
