import express from "express";
import pino from "pino";
import { getSettlement } from "./database.js";

const logger = pino({ name: "indexer-api" });

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());

  // Log every request
  app.use((req, _res, next) => {
    logger.info({ method: req.method, path: req.path }, "incoming request");
    next();
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/settlement/:market_id", (req, res) => {
    const record = getSettlement(req.params.market_id);
    if (!record) {
      res.status(404).json({ error: "Settlement not found" });
      return;
    }
    res.json({
      conditionId: record.condition_id,
      positionId: record.position_id,
      payout_per_share: record.payout_per_share,
      block_number: record.block_number,
      outcome: record.outcome,
    });
  });

  return app;
}

export function startServer(app: express.Application, port: number): void {
  app.listen(port, () => {
    logger.info({ port }, "Indexer API listening");
  });
}
