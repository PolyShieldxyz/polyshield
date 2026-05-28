import express from "express";
import Database from "better-sqlite3";
import { ethers } from "ethers";
import pino from "pino";
import path from "path";
import { resolveMarketManually } from "./settlementResolver";
import { config } from "./config";

const logger = pino({ name: "auto-settlement" });

const DB_PATH = process.env.SETTLEMENT_DB_PATH ?? path.join(process.cwd(), "settlement.db");

let db: Database.Database;

function initDb(): void {
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS claim_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      nullifier_of_bet TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      resolved_at INTEGER,
      UNIQUE(market_id, nullifier_of_bet)
    )
  `);
  logger.info({ path: DB_PATH }, "claim_permissions table ready");
}

export function startAutoSettlementServer(
  provider: ethers.JsonRpcProvider,
  wallet: ethers.Wallet,
  port = 3004
): void {
  initDb();

  const app = express();
  app.use(express.json());

  /**
   * POST /claim-permission
   * Body: { market_id: string, nullifier_of_bet: string }
   *
   * Called by the frontend when the user wants to claim settlement credit.
   * Records the request and triggers a manual resolveMarket if the market
   * is already settled on CTF but not yet in the Vault.
   */
  app.post("/claim-permission", async (req, res) => {
    const { market_id, nullifier_of_bet } = req.body as {
      market_id?: string;
      nullifier_of_bet?: string;
    };

    if (!market_id || !nullifier_of_bet) {
      res.status(400).json({ error: "market_id and nullifier_of_bet are required" });
      return;
    }

    // Upsert claim record
    db.prepare(`
      INSERT OR IGNORE INTO claim_permissions (market_id, nullifier_of_bet, requested_at)
      VALUES (?, ?, ?)
    `).run(market_id, nullifier_of_bet, Math.floor(Date.now() / 1000));

    logger.info({ market_id, nullifier_of_bet }, "Claim permission recorded");

    // Attempt to resolve the market in Vault (no-op if already resolved or not yet settled on CTF)
    resolveMarketManually(provider, wallet, market_id).catch((err) => {
      logger.error({ err, market_id }, "resolveMarketManually failed");
    });

    res.json({ ok: true });
  });

  /**
   * GET /operator-pubkey
   * Returns the operator's Ethereum address so the frontend can verify
   * which address is authorized to call resolveMarket.
   */
  app.get("/operator-pubkey", (_req, res) => {
    res.json({ address: config.signingLayerOperatorAddress });
  });

  app.listen(port, () => {
    logger.info({ port }, "Auto-settlement HTTP server listening");
  });
}
