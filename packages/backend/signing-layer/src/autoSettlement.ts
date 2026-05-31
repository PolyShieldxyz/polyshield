import express from "express";
import Database from "better-sqlite3";
import { ethers } from "ethers";
import pino from "pino";
import path from "path";
import { resolveMarketManually } from "./settlementResolver";
import { submitFOKSellOrder } from "./orderBuilder";
import { recordLimitOrder } from "./limitOrderStore";
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
  // FC-1: pre-settlement close (FOK SELL) requests.
  db.exec(`
    CREATE TABLE IF NOT EXISTS close_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nullifier_of_bet TEXT NOT NULL,
      position_id TEXT NOT NULL,
      sold_shares TEXT NOT NULL,
      limit_price TEXT NOT NULL,
      requested_at INTEGER NOT NULL
    )
  `);
  logger.info({ path: DB_PATH }, "claim_permissions + close_requests tables ready");
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
   * POST /close-request  (FC-1)
   * Body: { nullifier_of_bet, position_id, sold_shares, limit_price }
   *   sold_shares, limit_price are 1e6-scaled decimal strings.
   *
   * Submits a FOK SELL for the requested shares at the user's limit price. On fill,
   * the operator calls reportSold and the user credits their note via closePosition.
   * On no-fill nothing is debited and the position stays open.
   */
  app.post("/close-request", async (req, res) => {
    const { nullifier_of_bet, position_id, sold_shares, limit_price } = req.body as {
      nullifier_of_bet?: string;
      position_id?: string;
      sold_shares?: string;
      limit_price?: string;
    };

    if (!nullifier_of_bet || !position_id || !sold_shares || !limit_price) {
      res.status(400).json({ error: "nullifier_of_bet, position_id, sold_shares, limit_price are required" });
      return;
    }

    let soldSharesBig: bigint;
    let limitPriceBig: bigint;
    try {
      soldSharesBig = BigInt(sold_shares);
      limitPriceBig = BigInt(limit_price);
    } catch {
      res.status(400).json({ error: "sold_shares and limit_price must be integer strings (1e6-scaled)" });
      return;
    }
    if (soldSharesBig <= 0n || limitPriceBig <= 0n || limitPriceBig > 1_000_000n) {
      res.status(400).json({ error: "invalid sold_shares or limit_price (limit_price must be 1..1e6)" });
      return;
    }

    db.prepare(`
      INSERT INTO close_requests (nullifier_of_bet, position_id, sold_shares, limit_price, requested_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(nullifier_of_bet, position_id, sold_shares, limit_price, Math.floor(Date.now() / 1000));

    logger.info({ nullifier_of_bet, position_id, sold_shares, limit_price }, "Close request recorded — submitting FOK SELL");

    // Fire-and-forget: the SELL + reportSold runs async; the frontend polls bet status
    // (CLOSING) before generating the close proof.
    submitFOKSellOrder(
      { nullifier_of_bet, position_id, sold_shares: soldSharesBig, limit_price: limitPriceBig },
      wallet,
      provider
    ).catch((err) => {
      logger.error({ err, nullifier_of_bet }, "submitFOKSellOrder failed");
    });

    res.json({ ok: true });
  });

  /**
   * POST /limit-order  (FC-4)
   * Body: { nullifier_of_bet, order_type: "GTC" | "GTD", expiration?: number }
   *
   * Registers a limit-order intent for a bet. Called by the frontend right after it
   * relays authorizeBet for an advanced-mode (limit) bet. When the BetAuthorized
   * event fires, the event listener consults this intent and submits a resting
   * GTC/GTD order instead of the default FOK. `expiration` is the GTD effective
   * lifetime in seconds (ignored for GTC).
   */
  app.post("/limit-order", (req, res) => {
    const { nullifier_of_bet, order_type, expiration } = req.body as {
      nullifier_of_bet?: string;
      order_type?: string;
      expiration?: number;
    };

    if (!nullifier_of_bet || (order_type !== "GTC" && order_type !== "GTD")) {
      res.status(400).json({ error: 'nullifier_of_bet and order_type ("GTC" | "GTD") are required' });
      return;
    }
    const exp = typeof expiration === "number" && expiration > 0 ? Math.floor(expiration) : 0;

    recordLimitOrder({ nullifier_of_bet, order_type, expiration: exp });
    logger.info({ nullifier_of_bet, order_type, expiration: exp }, "Limit-order intent recorded");
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
