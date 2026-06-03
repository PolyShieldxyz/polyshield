/**
 * Runs MockDeploy.s.sol via forge script and parses the emitted KEY=address lines.
 *
 * Returns a flat record of all contract addresses + market IDs + commitment hashes
 * that MockDeploy logs to stdout.
 */

import { execFileSync } from "child_process";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { findForge } from "./anvil";

// Ensure Foundry is on PATH (handles shells that don't source ~/.foundry/env)
const foundryBin = path.join(os.homedir(), ".foundry", "bin");
if (!process.env.PATH?.includes(foundryBin)) {
  process.env.PATH = `${foundryBin}:${process.env.PATH ?? ""}`;
}

const CONTRACTS_DIR = path.resolve(__dirname, "../../../../packages/contracts");

export interface DeployedAddresses {
  USDC_ADDRESS: string;
  PUSD_ADDRESS: string;
  ONRAMP_ADDRESS: string;
  OFFRAMP_ADDRESS: string;
  DEPOSIT_WALLET_PROXY: string;
  CTF_ADDRESS: string;
  POSEIDON_ADDRESS: string;
  REGISTRY_ADDRESS: string;
  TREE_ADDRESS: string;
  VAULT_ADDRESS: string;
  BET_AUTH_VERIFIER: string;
  SETTLEMENT_VERIFIER: string;
  WITHDRAWAL_VERIFIER: string;
  BET_CANCEL_VERIFIER: string;
  CANCEL_CREDIT_VERIFIER: string;
  RESOLVED_YES_MARKET: string;
  NA_MARKET: string;
  ALICE_COMMITMENT_1: string;
  BOB_COMMITMENT_1: string;
}

export async function deployContracts(rpcUrl = "http://127.0.0.1:8545"): Promise<DeployedAddresses> {
  const forge = findForge();

  // API-012: use execFileSync with array args (no shell) so neither `forge` nor
  // `rpcUrl` can be interpreted by a shell. Avoids command/argument injection if
  // any of these inputs are ever sourced from the environment or config.
  console.log("[deploy] building contracts...");
  execFileSync(forge, ["build", "--quiet"], { cwd: CONTRACTS_DIR, stdio: "inherit" });

  console.log("[deploy] running MockDeploy.s.sol... (first run takes 2–4 minutes)");
  const started = Date.now();
  const output = execFileSync(
    forge,
    ["script", "script/MockDeploy.s.sol", "--rpc-url", rpcUrl, "--broadcast"],
    { cwd: CONTRACTS_DIR, stdio: ["ignore", "pipe", "inherit"] }
  ).toString();
  console.log(`[deploy] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const addresses = parseAddresses(output);

  // Advance Anvil's clock past the 48-hour verifier timelock, then accept all verifiers.
  // vm.warp/vm.rpc inside a Forge script cannot reliably do this because vm.rpc fires
  // during the dry-run simulation (before broadcast), pushing verifierUpdateAt further out.
  console.log("[deploy] advancing Anvil time past 48-hour verifier timelock...");
  await rpcCall(rpcUrl, "evm_increaseTime", [172801]); // 48 h + 1 s
  await rpcCall(rpcUrl, "evm_mine", []);

  console.log("[deploy] accepting verifiers...");
  execFileSync(
    forge,
    ["script", "script/MockAcceptVerifiers.s.sol", "--rpc-url", rpcUrl, "--broadcast"],
    { cwd: CONTRACTS_DIR, env: { ...process.env, VAULT_ADDRESS: addresses.VAULT_ADDRESS }, stdio: "inherit" }
  );

  return addresses;
}

/**
 * API-012: minimal JSON-RPC call over http.request (mirrors waitForRpc in anvil.ts).
 * Replaces the previous `curl ... -d '{...}'` execSync helper, which interpolated
 * the method/params straight into a shell command (shell-injection surface). The
 * deploy flow awaits each call so evm_increaseTime is applied before evm_mine,
 * preserving the original sequencing.
 */
function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const url = new URL(rpcUrl);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const req = http.request(
      {
        host: url.hostname,
        port: url.port || 80,
        method: "POST",
        path: url.pathname || "/",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`[deploy] RPC ${method} failed with HTTP ${res.statusCode}`));
          } else {
            resolve();
          }
        });
      },
    );
    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

function parseAddresses(output: string): DeployedAddresses {
  const result: Record<string, string> = {};

  // Matches lines like:   VAULT_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3
  const pattern = /^\s*([A-Z0-9_]+)=(0x[0-9a-fA-F]+)\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(output)) !== null) {
    result[match[1]] = match[2];
  }

  const required: (keyof DeployedAddresses)[] = [
    "USDC_ADDRESS", "PUSD_ADDRESS", "ONRAMP_ADDRESS", "OFFRAMP_ADDRESS", "DEPOSIT_WALLET_PROXY", "CTF_ADDRESS", "POSEIDON_ADDRESS", "REGISTRY_ADDRESS",
    "TREE_ADDRESS", "VAULT_ADDRESS", "BET_AUTH_VERIFIER", "SETTLEMENT_VERIFIER",
    "WITHDRAWAL_VERIFIER", "BET_CANCEL_VERIFIER", "CANCEL_CREDIT_VERIFIER",
    "RESOLVED_YES_MARKET", "NA_MARKET", "ALICE_COMMITMENT_1", "BOB_COMMITMENT_1",
  ];

  for (const key of required) {
    if (!result[key]) {
      throw new Error(`[deploy] missing address for ${key}. Full output:\n${output}`);
    }
  }

  return result as unknown as DeployedAddresses;
}
