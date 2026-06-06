import express from "express";
import Database from "better-sqlite3";
import { ethers } from "ethers";
import pino from "pino";
import path from "path";
import crypto from "crypto";
import { z } from "zod";
import { resolveMarketManually } from "./settlementResolver";
import { submitFOKSellOrder } from "./orderBuilder";
import { recordLimitOrder } from "./limitOrderStore";
import { getAttestation } from "./attestationStore";
import { config } from "./config";

const logger = pino({ name: "auto-settlement" });

// API-001: operator bearer-token auth for all mutating routes.
// Constant-time comparison against OPERATOR_API_TOKEN. Fails closed (401) when
// the env token is unset so a misconfigured deployment cannot accept calls.
function operatorAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const expected = process.env.OPERATOR_API_TOKEN;
  if (!expected) {
    logger.warn({ path: req.path }, "OPERATOR_API_TOKEN unset — rejecting mutating request (fail closed)");
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const header = req.headers.authorization;
  const presented =
    typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  // timingSafeEqual throws on unequal-length buffers; hash both sides to fixed
  // length first so the comparison itself stays constant-time and length-safe.
  const a = crypto.createHash("sha256").update(presented).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

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
  app.use(express.json({ limit: "32kb" })); // API-006: cap request body size

  // API-003: shared validators for mutating routes.
  const HEX32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
  const claimPermissionSchema = z.object({
    market_id: HEX32,
    nullifier_of_bet: HEX32,
  });
  const closeRequestSchema = z.object({
    nullifier_of_bet: HEX32,
    position_id: HEX32,
    // sold_shares / limit_price arrive as 1e6-scaled integer strings; the existing
    // BigInt range checks below remain authoritative for the numeric bounds.
    sold_shares: z.string().regex(/^[0-9]+$/),
    limit_price: z.string().regex(/^[0-9]+$/),
  });
  const limitOrderSchema = z.object({
    nullifier_of_bet: HEX32,
    // FAK is a fill-and-kill market order; GTC/GTD are resting limit orders. FOK is the
    // default and needs no intent.
    order_type: z.enum(["GTC", "GTD", "FAK"]),
    expiration: z.number().int().nonnegative().optional(),
  });

  /**
   * POST /claim-permission
   * Body: { market_id: string, nullifier_of_bet: string }
   *
   * Called by the frontend when the user wants to claim settlement credit.
   * Records the request and triggers a manual resolveMarket if the market
   * is already settled on CTF but not yet in the Vault.
   */
  app.post("/claim-permission", operatorAuth, async (req, res) => {
    const parsed = claimPermissionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid inputs" });
      return;
    }
    const { market_id, nullifier_of_bet } = parsed.data;

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
  app.post("/close-request", operatorAuth, async (req, res) => {
    const parsed = closeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid inputs" });
      return;
    }
    const { nullifier_of_bet, position_id, sold_shares, limit_price } = parsed.data;

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
   * Body: { nullifier_of_bet, order_type: "GTC" | "GTD" | "FAK", expiration?: number }
   *
   * Registers a non-default order-type intent for a bet. Called by the frontend right
   * after it relays authorizeBet for an advanced-mode bet. When the BetAuthorized
   * event fires, the event listener consults this intent and submits a FAK
   * (fill-and-kill market order) or a resting GTC/GTD limit order instead of the
   * default FOK. `expiration` is the GTD effective lifetime in seconds (ignored for
   * GTC and FAK).
   */
  app.post("/limit-order", operatorAuth, (req, res) => {
    const parsed = limitOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid inputs" });
      return;
    }
    const { nullifier_of_bet, order_type, expiration } = parsed.data;
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

  /**
   * GET /attestation/:nullifier  (FC-9)
   *
   * PUBLIC (no operatorAuth): the nullifier_of_bet is already public on-chain, and
   * the returned EIP-712 signature is what the frontend submits alongside its credit
   * proof. The Vault recovers the signer on-chain and requires == signingLayerOperator,
   * so serving the attestation openly leaks nothing and authorizes nothing.
   *
   * Returns { nullifierOfBet, reportType, amountA, amountB, signature } or 404 if the
   * operator has not yet signed a terminal attestation for this bet.
   *
   * TODO(FC-9): rate-limit this route like the proof-relay does
   * (express-rate-limit, 20 req/min). express-rate-limit is not currently a
   * dependency of @polyshield/signing-layer; add it before exposing this beyond
   * loopback / behind a gateway that does not already rate-limit.
   */
  app.get("/attestation/:nullifier", (req, res) => {
    const nullifier = req.params.nullifier;
    if (!/^0x[0-9a-fA-F]{64}$/.test(nullifier)) {
      res.status(400).json({ error: "invalid nullifier" });
      return;
    }
    // Optional ?reportType=N selects a specific attestation slot. The position-close
    // flow passes reportType=4 (SOLD) so it gets the close attestation even when a
    // FILLED bet-outcome attestation also exists for the same bet. Without it, the
    // bet-outcome attestation (FILLED/FAILED/PARTIAL) is returned (settlement / partial
    // / portfolio-status callers).
    const rtRaw = req.query.reportType;
    let reportType: number | undefined;
    if (typeof rtRaw === "string" && rtRaw !== "") {
      const n = Number(rtRaw);
      if (!Number.isInteger(n) || n < 1 || n > 4) {
        res.status(400).json({ error: "reportType must be an integer 1..4" });
        return;
      }
      reportType = n;
    }
    const attestation = getAttestation(nullifier, reportType);
    if (!attestation) {
      res.status(404).json({ error: "no attestation yet" });
      return;
    }
    res.json(attestation);
  });

  // Health/root route. Without this, anything that opens http://<host>:<port>/ (a probe,
  // a curl, or the editor's automatic port-forward "open in browser") gets Express's bare
  // "Cannot GET /" 404, which looks like an error. Return a small JSON descriptor instead.
  app.get("/", (_req, res) => {
    res.json({
      service: "polyshield-signing-layer",
      ok: true,
      routes: ["GET /operator-pubkey", "GET /attestation/:nullifier", "POST /claim-permission", "POST /close-request", "POST /limit-order"],
    });
  });

  // API-001/API-005: bind to loopback by default; override only via BIND_HOST.
  app.listen(port, process.env.BIND_HOST || "127.0.0.1", () => {
    logger.info({ port }, "Auto-settlement HTTP server listening");
  });
}
