import express from "express";
import { ethers } from "ethers";
import pino from "pino";
import { getSettlement } from "./database";

const logger = pino({ name: "indexer-api" });

const VAULT_ABI = [
  "function marketResolvedAt(bytes32 market_id) view returns (uint64)",
  "function pendingCredit(bytes32 market_id) view returns (uint64)",
];

async function fetchVaultResolvedAt(marketId: string): Promise<number | null> {
  const rpc = process.env.POLYGON_RPC_URL;
  const vault = process.env.VAULT_CONTRACT_ADDRESS;
  if (!rpc || !vault) return null;
  try {
    const provider = new ethers.JsonRpcProvider(rpc);
    const contract = new ethers.Contract(vault, VAULT_ABI, provider);
    const ts: bigint = await contract.marketResolvedAt(marketId);
    return ts > 0n ? Number(ts) : null;
  } catch {
    return null;
  }
}

export function createApp(): express.Application {
  const app = express();
  app.use(express.json({ limit: "32kb" })); // API-006: cap request body size

  // Log every request
  app.use((req, _res, next) => {
    logger.info({ method: req.method, path: req.path }, "incoming request");
    next();
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/settlement/:market_id", async (req, res) => {
    const record = getSettlement(req.params.market_id);
    if (!record) {
      res.status(404).json({ error: "Settlement not found" });
      return;
    }
    const vaultResolvedAt = await fetchVaultResolvedAt(req.params.market_id);
    res.json({
      conditionId: record.condition_id,
      positionId: record.position_id,
      payout_per_share: record.payout_per_share,
      block_number: record.block_number,
      outcome: record.outcome,
      resolved_at: vaultResolvedAt ?? record.resolved_at ?? null,
      claimable: (vaultResolvedAt ?? record.resolved_at ?? 0) > 0,
    });
  });

  return app;
}

export function startServer(app: express.Application, port: number): void {
  // API-005: bind to loopback by default; override only via BIND_HOST.
  app.listen(port, process.env.BIND_HOST || "127.0.0.1", () => {
    logger.info({ port }, "Indexer API listening");
  });
}
