/**
 * One-off OPERATOR backfill: seed the proof-relay's durable market-NAME registry with every market
 * PolyShield has ever bet on.
 *
 * The registry self-seeds going forward (the 10-min catalog sync, and any on-demand resolution by a
 * REAL conditionId). But markets that RESOLVED and were purged from the bettable catalog BEFORE the
 * registry existed aren't captured — and a chain-recovered note (after a hard refresh / cache wipe)
 * knows only the FIELD-SAFE market_id, which can't be reversed to a conditionId. So those show a hex
 * id in "closed positions".
 *
 * `tracked_markets` (settlement.db) durably keeps the REAL conditionId for every bet market (it needs
 * it for resolveMarket). This walks them and GETs the proof-relay's public `/market-name/<conditionId>`
 * endpoint, whose resolution self-seeds the registry as a side effect. After this, those markets
 * resolve by their field-safe id forever — surviving any future cache wipe.
 *
 * Idempotent, read-only on-chain (just HTTP GETs). Safe to re-run.
 *
 * Usage (in the running container):
 *   docker compose exec signing-layer node dist/scripts/backfillMarketNames.js
 */

import pino from "pino";
import { config } from "../config";
import { getTrackedMarkets } from "../trackedMarkets";

const logger = pino({ name: "backfill-market-names" });

// Gentle pacing — the proof-relay's /market-name is rate-limited (120/min). One every ~600ms keeps
// the whole backfill comfortably under that even before network latency.
const GAP_MS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const base = config.proofRelayUrl;
  if (!base) {
    logger.error("PROOF_RELAY_URL not set — cannot reach the proof-relay to seed the name registry");
    process.exit(1);
  }
  const markets = getTrackedMarkets();
  if (markets.length === 0) {
    console.log("No tracked markets — nothing to backfill.");
    return;
  }
  console.log(`Backfilling ${markets.length} tracked market name(s) into the proof-relay registry via ${base}…\n`);

  let seeded = 0;
  let unresolved = 0;
  for (const m of markets) {
    const cid = m.rawConditionId;
    try {
      const res = await fetch(`${base}/market-name/${encodeURIComponent(cid)}`);
      const name = res.ok ? ((await res.json()) as { name?: string }).name : undefined;
      if (name) {
        seeded++;
        console.log(`  ✓ ${cid.slice(0, 12)}…  ${name.slice(0, 56)}`);
      } else {
        unresolved++;
        console.log(`  · ${cid.slice(0, 12)}…  (Gamma had no name — too old / delisted)`);
      }
    } catch (err) {
      unresolved++;
      logger.warn({ err: String(err), cid }, "backfill: /market-name request failed");
    }
    await sleep(GAP_MS);
  }
  console.log(`\nDone. seeded=${seeded}  unresolved=${unresolved}  total=${markets.length}`);
}

main().catch((err) => {
  logger.error({ err: String(err) }, "backfillMarketNames failed");
  process.exit(1);
});
