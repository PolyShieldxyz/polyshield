import express from "express";
import pino from "pino";
import {
  relayAuthorizeBet,
  relayCreditSettlement,
  relayWithdraw,
  relayBetCancellationCredit,
  relayNACancellationCredit,
} from "./relayer.js";

// Source IP is NEVER logged — see pino redact config in index.ts
const logger = pino({ name: "proof-relay-api" });

export function createApp(): express.Application {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Log every incoming request (path + method only, no IPs)
  app.use((req, _res, next) => {
    logger.info({ method: req.method, path: req.path }, "incoming request");
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

  return app;
}
