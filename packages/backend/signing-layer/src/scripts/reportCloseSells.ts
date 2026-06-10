/**
 * Operator diagnostic (READ-ONLY): report the vault EOA's actual SELL fills for a bet's token from
 * the CLOB trade history. Use it to (a) get the REAL realized proceeds to correct a SOLD attestation
 * that was signed at a wrong/low limit, and (b) detect a pool double-sell (total shares sold across
 * multiple close attempts exceeding the position's expected_shares).
 *
 * Changes nothing. Usage (in the running container — built to dist/):
 *   docker compose exec signing-layer node dist/scripts/reportCloseSells.js <nullifier_of_bet>
 * Or in dev: pnpm --filter @polyshield/signing-layer report-close-sells <nullifier_of_bet>
 *
 * Output includes `realized_proceeds_micro` — plug it into attestSold to fix the SOLD attestation:
 *   node dist/scripts/attestSold.js <nullifier_of_bet> <realized_proceeds_micro>
 * The raw trades are also printed so the SELL fields/units can be verified against the live CLOB.
 */

import { ethers } from "ethers";
import pino from "pino";
import { config } from "../config";
import { getOrCreateClobClient } from "../orderBuilder";
import { resolveToken } from "../marketRegistry";

const logger = pino({ name: "report-close-sells" });

const BET_RECORDS_ABI = [
  "function betRecords(bytes32) view returns (bytes32 market_id, bytes32 condition_id, bytes32 position_id, uint64 expected_shares, uint64 bet_amount, uint8 outcome_side, uint8 status)",
];

async function main(): Promise<void> {
  const nullifier = process.argv[2];
  if (!nullifier || !/^0x[0-9a-fA-F]{64}$/.test(nullifier)) {
    logger.error("usage: reportCloseSells <nullifier_of_bet 0x..64>");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(config.polygonRpcUrl);
  const wallet = new ethers.Wallet(config.vaultEoaPrivateKey, provider);

  // Resolve the bet's real CLOB token + conditionId from on-chain (market_id, outcome_side).
  const vault = new ethers.Contract(config.vaultContractAddress, BET_RECORDS_ABI, provider);
  const rec = await vault.betRecords(nullifier);
  const expectedShares = Number(BigInt(rec.expected_shares ?? rec[3])) / 1e6;
  const resolved = resolveToken(String(rec.market_id ?? rec[0]), Number(rec.outcome_side ?? rec[5]));
  if (!resolved) {
    logger.error(
      { nullifier, market_id: String(rec.market_id ?? rec[0]) },
      "no market-registry entry — cannot resolve token/conditionId for this bet",
    );
    process.exit(1);
  }
  const { tokenId, conditionId } = resolved;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = await getOrCreateClobClient(wallet);
  if (!client) {
    logger.error("CLOB client unavailable (mock mode / not configured)");
    process.exit(1);
  }

  // getTrades is authenticated → returns OUR trades for the market. Narrow to this outcome token
  // and to SELL fills (taker side SELL, or our maker order side SELL). Schema varies across CLOB
  // versions, so this is best-effort — the raw trades are dumped below for verification.
  const trades = await client.getTrades({ market: conditionId }).catch((e: unknown) => {
    logger.warn({ err: String(e) }, "getTrades failed");
    return null;
  });
  const arr: unknown[] = Array.isArray(trades) ? trades : [];
  const me = (config.depositWalletAddress || "").toLowerCase();

  let shares = 0;
  let proceeds = 0;
  const matched: Array<{ role: string; size: number; price: number }> = [];
  for (const tRaw of arr) {
    const t = tRaw as Record<string, unknown>;
    const assetId = String(t.asset_id ?? "");
    if (tokenId && assetId && assetId !== tokenId) continue; // a conditionId has 2 tokens (YES/NO)
    // Taker side: a market SELL crosses the book as the taker.
    const takerSide = String(t.side ?? "").toUpperCase();
    const traderSide = String(t.trader_side ?? "").toUpperCase();
    if (takerSide === "SELL" && (traderSide === "TAKER" || traderSide === "")) {
      const sz = Number(t.size ?? 0);
      const px = Number(t.price ?? 0);
      if (sz > 0) { shares += sz; proceeds += sz * px; matched.push({ role: "taker", size: sz, price: px }); }
    }
    // Maker side: a resting SELL fills as a maker.
    const makerOrders = (t.maker_orders ?? []) as Array<Record<string, unknown>>;
    for (const mo of makerOrders) {
      const isMine = !me || String(mo.maker_address ?? "").toLowerCase() === me;
      if (isMine && String(mo.side ?? "").toUpperCase() === "SELL") {
        const sz = Number(mo.matched_amount ?? 0);
        const px = Number(mo.price ?? 0);
        if (sz > 0) { shares += sz; proceeds += sz * px; matched.push({ role: "maker", size: sz, price: px }); }
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        nullifier,
        tokenId,
        conditionId,
        expected_shares: expectedShares.toFixed(4),
        sells_matched: matched,
        total_shares_sold: shares.toFixed(4),
        total_realized_proceeds_usdc: proceeds.toFixed(6),
        realized_proceeds_micro: Math.round(proceeds * 1e6),
        double_sell_suspected: shares > expectedShares * 1.01,
        raw_trade_count: arr.length,
      },
      null,
      2,
    ),
  );
  console.log("\n--- raw trades for this market (verify SELL field names/units against your CLOB) ---");
  console.log(JSON.stringify(arr, null, 2));
}

main().catch((err) => {
  logger.error({ err: String(err) }, "reportCloseSells failed");
  process.exit(1);
});
