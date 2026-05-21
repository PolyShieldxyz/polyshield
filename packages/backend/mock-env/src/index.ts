/**
 * Mock environment orchestrator.
 *
 * Starts the full local Polyshield dev environment in order:
 *   1. Anvil (local Polygon node) on port 8545
 *   2. forge script MockDeploy.s.sol — deploys all contracts + seeds state
 *   3. mock-clob-server on port 3001  (Polymarket CLOB mock)
 *   4. proof-relay on port 3002       (relays ZK proofs to Vault)
 *   5. indexer on port 3003           (watches CTF settlements)
 *   6. signing-layer                  (watches BetAuthorized, submits to CLOB)
 *   7. Writes packages/backend/.env.test + packages/frontend/.env.local
 *   8. Prints a summary banner with all service URLs
 *
 * Usage (from repo root):
 *   pnpm dev:mock
 *
 * To stop: Ctrl+C — all child processes are killed on SIGINT/SIGTERM.
 */

import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { startAnvil, stopAnvil } from "./anvil";
import { deployContracts, DeployedAddresses } from "./deploy";

const CLOB_PORT       = 3001;
const RELAY_PORT      = 3002;
const INDEXER_PORT    = 3003;

const BACKEND_DIR       = path.resolve(__dirname, "../..");
const MOCK_CLOB_ENTRY   = path.resolve(__dirname, "../../mock-clob-server/src/index.ts");
const PROOF_RELAY_ENTRY = path.resolve(__dirname, "../../proof-relay/src/index.ts");
const INDEXER_ENTRY     = path.resolve(__dirname, "../../indexer/src/index.ts");
const SIGNING_ENTRY     = path.resolve(__dirname, "../../signing-layer/src/index.ts");

const ENV_OUT           = path.resolve(__dirname, "../../../.env.test");
const FRONTEND_ENV_OUT  = path.resolve(__dirname, "../../../../packages/frontend/.env.local");

// ── Session log file ──────────────────────────────────────────────────────────
// All service stdout is mirrored here in addition to the terminal.
// One file per dev:mock session, timestamped.
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const LOGS_DIR  = path.join(REPO_ROOT, "logs");
const SESSION_TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const SESSION_LOG = path.join(LOGS_DIR, `session-${SESSION_TS}.jsonl`);

let sessionLog: fs.WriteStream | null = null;

function initSessionLog(): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    sessionLog = fs.createWriteStream(SESSION_LOG, { flags: "a" });
    console.log(`[mock-env] session log → ${SESSION_LOG}`);
  } catch (e) {
    console.warn("[mock-env] could not open session log file:", e);
  }
}

function writeSessionLog(service: string, line: string): void {
  if (!sessionLog) return;
  // Attempt to parse pino JSON lines; if not JSON, wrap as plain text
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
    entry["_service"] = service;
  } catch {
    entry = { ts: new Date().toISOString(), _service: service, msg: line };
  }
  sessionLog.write(JSON.stringify(entry) + "\n");
}

// Anvil deterministic account private keys (same as Hardhat/Foundry defaults)
const ACCOUNTS = {
  OWNER_PRIVATE_KEY:    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  OWNER_ADDRESS:        "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  OPERATOR_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  OPERATOR_ADDRESS:     "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  DEPOSIT_WALLET_KEY:   "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  DEPOSIT_WALLET:       "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  RELAYER_PRIVATE_KEY:  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  RELAYER_ADDRESS:      "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  ALICE_PRIVATE_KEY:    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  ALICE_ADDRESS:        "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  BOB_PRIVATE_KEY:      "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  BOB_ADDRESS:          "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  ATTACKER_PRIVATE_KEY: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  ATTACKER_ADDRESS:     "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
};

const children: ChildProcess[] = [];

function cleanup(): void {
  console.log("\n[mock-env] shutting down...");
  stopAnvil();
  for (const c of children) c.kill("SIGTERM");
  if (sessionLog) {
    sessionLog.end(() => process.exit(0));
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

function findTsNode(): string {
  // Prefer the backend workspace's ts-node (most likely installed)
  const candidates = [
    path.join(BACKEND_DIR, "node_modules/.bin/ts-node"),
    path.join(BACKEND_DIR, "mock-clob-server/node_modules/.bin/ts-node"),
    "ts-node",
  ];
  for (const c of candidates) {
    try { if (c === "ts-node" || fs.existsSync(c)) return c; } catch (_) {}
  }
  return "ts-node";
}

function spawnService(
  label: string,
  entry: string,
  extraEnv: Record<string, string> = {},
  exitIsFatal = true,
): ChildProcess {
  const tsNode = findTsNode();
  console.log(`[mock-env] starting ${label} via ${tsNode}`);

  const proc = spawn(tsNode, [entry], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });

  proc.stdout?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      process.stdout.write(`[${label}] ${line}\n`);
      writeSessionLog(label, line);
    }
  });
  proc.stderr?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      process.stderr.write(`[${label}:err] ${line}\n`);
      writeSessionLog(`${label}:err`, line);
    }
  });
  proc.on("exit", (code) => {
    if (code !== 0 && exitIsFatal) {
      console.error(`[mock-env] ${label} exited with code ${code} — shutting down`);
      cleanup();
    } else if (code !== 0) {
      console.warn(`[mock-env] ${label} exited with code ${code} (non-fatal)`);
    }
  });

  children.push(proc);
  return proc;
}

function writeEnvTest(addrs: DeployedAddresses): void {
  const lines = [
    "# Auto-generated by pnpm dev:mock — do not commit",
    "# Overwrite-safe: regenerated on every dev:mock start",
    "",
    "# ── Blockchain ────────────────────────────────────────────",
    "POLYGON_RPC_URL=http://127.0.0.1:8545",
    "CHAIN_ID=31337",
    "",
    "# ── Anvil accounts ────────────────────────────────────────",
    ...Object.entries(ACCOUNTS).map(([k, v]) => `${k}=${v}`),
    "",
    "# ── Deployed contracts ────────────────────────────────────",
    ...Object.entries(addrs).map(([k, v]) => `${k}=${v}`),
    "",
    "# ── Mock CLOB server ──────────────────────────────────────",
    `POLY_API_URL=http://127.0.0.1:${CLOB_PORT}`,
    "POLY_API_KEY=mock-api-key-0000",
    "POLY_SECRET=mock-secret-0000",
    "POLY_PASSPHRASE=mock-passphrase-0000",
    "",
    "# ── Backend env aliases ───────────────────────────────────",
    `VAULT_CONTRACT_ADDRESS=${addrs.VAULT_ADDRESS}`,
    `SIGNING_LAYER_OPERATOR_ADDRESS=${ACCOUNTS.OPERATOR_ADDRESS}`,
    `VAULT_EOA_PRIVATE_KEY=${ACCOUNTS.OPERATOR_PRIVATE_KEY}`,
    `RELAYER_PRIVATE_KEY=${ACCOUNTS.RELAYER_PRIVATE_KEY}`,
    "",
    "# ── Service ports ─────────────────────────────────────────",
    `PROOF_RELAY_PORT=${RELAY_PORT}`,
    `INDEXER_PORT=${INDEXER_PORT}`,
    "",
  ];

  fs.writeFileSync(ENV_OUT, lines.join("\n"));
  console.log(`[mock-env] wrote backend env → ${ENV_OUT}`);
}

function writeFrontendEnv(addrs: DeployedAddresses): void {
  // Read existing .env.local to preserve any WC project ID the user may have set
  let existing: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(FRONTEND_ENV_OUT, "utf-8");
    for (const line of raw.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0 && !line.startsWith("#")) {
        existing[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }
  } catch (_) {}

  const wcId = existing["NEXT_PUBLIC_WC_PROJECT_ID"] ?? "";
  const customRpc = existing["NEXT_PUBLIC_POLYGON_RPC"] ?? "";

  const lines = [
    "# Auto-generated by pnpm dev:mock — safe to commit the template, not the values",
    "# Re-generated on every 'pnpm dev:mock' to reflect new contract addresses",
    "",
    "# ── Wallet Connect (optional — leave blank for MetaMask-only mode) ──────",
    `NEXT_PUBLIC_WC_PROJECT_ID=${wcId}`,
    "",
    "# ── Production Polygon RPC (optional) ────────────────────────────────────",
    `NEXT_PUBLIC_POLYGON_RPC=${customRpc}`,
    "",
    "# ── Local dev environment (populated by pnpm dev:mock) ──────────────────",
    "NEXT_PUBLIC_DEV_MODE=true",
    "NEXT_PUBLIC_CHAIN_ID=31337",
    "NEXT_PUBLIC_CHAIN_RPC=http://127.0.0.1:8545",
    `NEXT_PUBLIC_VAULT_ADDRESS=${addrs.VAULT_ADDRESS}`,
    `NEXT_PUBLIC_USDC_ADDRESS=${addrs.USDC_ADDRESS}`,
    `NEXT_PUBLIC_CTF_ADDRESS=${addrs.CTF_ADDRESS}`,
    "",
    "# ── Backend service URLs (Next.js server-side proxy targets) ─────────────",
    `PROOF_RELAY_URL=http://127.0.0.1:${RELAY_PORT}`,
    `INDEXER_URL=http://127.0.0.1:${INDEXER_PORT}`,
    `MOCK_CLOB_URL=http://127.0.0.1:${CLOB_PORT}`,
    "",
  ];

  fs.writeFileSync(FRONTEND_ENV_OUT, lines.join("\n"));
  console.log(`[mock-env] wrote frontend env → ${FRONTEND_ENV_OUT}`);
}

function buildSharedEnv(addrs: DeployedAddresses): Record<string, string> {
  return {
    POLYGON_RPC_URL:                   "http://127.0.0.1:8545",
    VAULT_CONTRACT_ADDRESS:            addrs.VAULT_ADDRESS,
    CTF_ADDRESS:                       addrs.CTF_ADDRESS,
    TREE_ADDRESS:                      addrs.TREE_ADDRESS,
    DEPLOYER_PRIVATE_KEY:              ACCOUNTS.OWNER_PRIVATE_KEY,  // mock-clob settle endpoint
    VAULT_EOA_PRIVATE_KEY:             ACCOUNTS.OPERATOR_PRIVATE_KEY,
    RELAYER_PRIVATE_KEY:               ACCOUNTS.RELAYER_PRIVATE_KEY,
    SIGNING_LAYER_OPERATOR_ADDRESS:    ACCOUNTS.OPERATOR_ADDRESS,
    POLY_API_KEY:                      "mock-api-key-0000",
    POLY_SECRET:                       "mock-secret-0000",
    POLY_PASSPHRASE:                   "mock-passphrase-0000",
    POLY_API_URL:                      `http://127.0.0.1:${CLOB_PORT}`,
    PROOF_RELAY_PORT:                  String(RELAY_PORT),
    INDEXER_PORT:                      String(INDEXER_PORT),
    INDEXER_DB_PATH:                   "/tmp/polyshield-indexer-dev.db",
  };
}

function printBanner(addrs: DeployedAddresses): void {
  console.log("\n" + "═".repeat(64));
  console.log("  Polyshield — full local dev environment ready");
  console.log("═".repeat(64));
  console.log(`  Anvil RPC:          http://127.0.0.1:8545  (chain 31337)`);
  console.log(`  Mock CLOB API:      http://127.0.0.1:${CLOB_PORT}`);
  console.log(`  CLOB admin:         http://127.0.0.1:${CLOB_PORT}/admin/set-behavior`);
  console.log(`  Settle market:      POST http://127.0.0.1:${CLOB_PORT}/admin/settle-market`);
  console.log(`  Proof relay:        http://127.0.0.1:${RELAY_PORT}`);
  console.log(`  Indexer API:        http://127.0.0.1:${INDEXER_PORT}`);
  console.log(`  Frontend:           http://localhost:3000  (pnpm dev in packages/frontend)`);
  console.log("");
  console.log(`  Vault:              ${addrs.VAULT_ADDRESS}`);
  console.log(`  USDC:               ${addrs.USDC_ADDRESS}`);
  console.log(`  CTF:                ${addrs.CTF_ADDRESS}`);
  console.log("");
  console.log(`  Alice ($100k USDC): ${ACCOUNTS.ALICE_ADDRESS}`);
  console.log(`  Bob ($10k USDC):    ${ACCOUNTS.BOB_ADDRESS}`);
  console.log(`  Operator:           ${ACCOUNTS.OPERATOR_ADDRESS}`);
  console.log(`  Relayer:            ${ACCOUNTS.RELAYER_ADDRESS}`);
  console.log("");
  console.log(`  Backend config:     ${ENV_OUT}`);
  console.log(`  Frontend config:    ${FRONTEND_ENV_OUT}`);
  console.log("═".repeat(64));
  console.log("  Add Anvil to MetaMask: RPC http://127.0.0.1:8545  Chain ID 31337");
  console.log("  Import test wallet:    private key in .env.test (ALICE_PRIVATE_KEY)");
  console.log("═".repeat(64));
  console.log("  Ctrl+C to stop all services");
  console.log("═".repeat(64) + "\n");
}

async function main(): Promise<void> {
  console.log("[mock-env] ── Step 1: Starting Anvil ──────────────────────────");
  await startAnvil();

  console.log("[mock-env] ── Step 2: Deploying contracts ─────────────────────");
  const addrs = deployContracts();
  console.log(`[mock-env] Vault deployed at ${addrs.VAULT_ADDRESS}`);
  console.log(`[mock-env] USDC  deployed at ${addrs.USDC_ADDRESS}`);
  console.log(`[mock-env] CTF   deployed at ${addrs.CTF_ADDRESS}`);

  const sharedEnv = buildSharedEnv(addrs);

  console.log("[mock-env] ── Step 3: Writing env files + opening session log ──");
  writeEnvTest(addrs);
  writeFrontendEnv(addrs);
  initSessionLog();

  console.log("[mock-env] ── Step 4: Starting mock CLOB server ───────────────");
  spawnService("mock-clob", MOCK_CLOB_ENTRY, {
    ...sharedEnv,
    PORT: String(CLOB_PORT),
  });

  console.log("[mock-env] ── Step 5: Starting proof relay ────────────────────");
  spawnService("proof-relay", PROOF_RELAY_ENTRY, sharedEnv);

  console.log("[mock-env] ── Step 6: Starting indexer ────────────────────────");
  spawnService("indexer", INDEXER_ENTRY, sharedEnv);

  console.log("[mock-env] ── Step 7: Starting signing layer ──────────────────");
  spawnService("signing-layer", SIGNING_ENTRY, sharedEnv, false);

  // Give services time to bind their ports before printing the banner
  await new Promise((r) => setTimeout(r, 2_000));

  printBanner(addrs);

  console.log("[mock-env] All services started. Logs are prefixed by service name.");
  console.log("[mock-env] Use the frontend at http://localhost:3000 (run pnpm dev separately).\n");
}

main().catch((err) => {
  console.error("[mock-env] fatal:", err);
  cleanup();
});
