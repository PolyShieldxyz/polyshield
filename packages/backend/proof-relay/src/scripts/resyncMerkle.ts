/**
 * Resync / backfill the backend database tree (merkle.db) from the chain, then verify it matches the
 * on-chain tree. Use when a deposit/bet/withdraw leaf isn't showing up in the cache (the background
 * poll stalled, the cache diverged during churn, or the cursor fell behind). It updates the DB tree
 * with everything emitted since the cache's cursor — i.e. the recent (e.g. last few days) activity —
 * and also catches up the event index that /recovery-data serves.
 *
 *   # run with the proof-relay STOPPED (avoids two writers on merkle.db):
 *   docker compose stop proof-relay
 *   docker compose run --rm --entrypoint node proof-relay dist/scripts/resyncMerkle.js
 *   docker compose start proof-relay
 *
 * Reads the same env as the relay: POLYGON_RPC_URL, TREE_ADDRESS, TREE_DEPLOY_BLOCK,
 * VAULT_CONTRACT_ADDRESS, PROOF_RELAY_DB_PATH.
 *
 * The merkle cache requires CONTIGUOUS leaves from index 0, so it self-heals correctly: if the
 * persisted leaves are intact it just appends the missing recent ones; if it detects a gap/divergence
 * below the cursor it rebuilds from the deploy block. If the report shows consistent=false or the
 * roots still differ, delete merkle.db and re-run for a clean full rebuild.
 */
import { ethers } from "ethers";
import pino from "pino";
import { RetryingJsonRpcProvider } from "../merkle";
import { CachedMerkleTree } from "../merkleTree";
import { VaultEventIndex } from "../eventIndex";

const logger = pino({ name: "resync-merkle" });

async function main(): Promise<void> {
  const rpc = process.env.POLYGON_RPC_URL;
  const treeAddress = process.env.TREE_ADDRESS;
  const vaultAddress = process.env.VAULT_CONTRACT_ADDRESS;
  const deployBlock = parseInt(process.env.TREE_DEPLOY_BLOCK ?? "0", 10);
  const dbPath = process.env.PROOF_RELAY_DB_PATH;
  if (!rpc || !treeAddress) throw new Error("POLYGON_RPC_URL and TREE_ADDRESS are required");
  if (!dbPath) throw new Error("PROOF_RELAY_DB_PATH is required (the cache DB to update)");

  const provider = new RetryingJsonRpcProvider(rpc);
  const head = await provider.getBlockNumber();
  const out = process.stdout;
  out.write(`\n===== resync database tree (merkle.db) =====\n`);
  out.write(`Tree:  ${treeAddress}\nDB:    ${dbPath}\nHead:  ${head}\n\n`);

  // 1) Backfill the merkle tree.
  const cache = new CachedMerkleTree(provider, treeAddress, deployBlock, dbPath);
  out.write("Catching up the merkle tree…\n");
  const m = await cache.catchUp();

  // 2) Verify against the on-chain tree (currentRoot + leaf count).
  const tree = new ethers.Contract(
    treeAddress,
    ["function currentRoot() view returns (bytes32)", "function nextIndex() view returns (uint32)"],
    provider,
  );
  const onChainRoot: string = await tree.currentRoot();
  let onChainLeaves = -1;
  try {
    onChainLeaves = Number(await tree.nextIndex());
  } catch {
    /* nextIndex getter may differ; leaf-count compare is best-effort */
  }

  const rootMatch = m.root.toLowerCase() === onChainRoot.toLowerCase();
  out.write(`\nMerkle tree:\n`);
  out.write(`  cache leaves:   ${m.leaves}${onChainLeaves >= 0 ? ` (on-chain: ${onChainLeaves})` : ""}\n`);
  out.write(`  cache cursor:   block ${m.lastBlock}\n`);
  out.write(`  consistent:     ${m.consistent}\n`);
  out.write(`  cache root:     ${m.root}\n`);
  out.write(`  on-chain root:  ${onChainRoot}\n`);
  out.write(`  ROOT MATCH:     ${rootMatch ? "✓ yes — tree is up to date" : "✗ NO"}\n`);

  // 3) Catch up the event index (recovery data) too, since it shares the DB and feeds /recovery-data.
  if (vaultAddress) {
    try {
      const idx = new VaultEventIndex(provider, vaultAddress, deployBlock, dbPath);
      const e = await idx.catchUp();
      out.write(`\nEvent index (recovery): caught up to block ${e.lastBlock}\n`);
    } catch (err) {
      out.write(`\nEvent index catch-up skipped: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  if (!m.consistent || !rootMatch) {
    out.write(
      `\n⚠ The cache is not consistent with the chain. Delete the DB and re-run for a clean full rebuild:\n` +
        `    docker compose stop proof-relay\n` +
        `    docker compose run --rm --entrypoint sh proof-relay -c 'rm -f ${dbPath} ${dbPath}-wal ${dbPath}-shm'\n` +
        `    docker compose run --rm --entrypoint node proof-relay dist/scripts/resyncMerkle.js\n` +
        `    docker compose start proof-relay\n\n`,
    );
    process.exit(2);
  }
  out.write(`\nDone — database tree updated and verified. Restart proof-relay to resume serving.\n\n`);
}

main().catch((err) => {
  logger.error({ err: String(err) }, "resync failed");
  process.stderr.write(`resync failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
