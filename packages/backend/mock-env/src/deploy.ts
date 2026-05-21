/**
 * Runs MockDeploy.s.sol via forge script and parses the emitted KEY=address lines.
 *
 * Returns a flat record of all contract addresses + market IDs + commitment hashes
 * that MockDeploy logs to stdout.
 */

import { execSync } from "child_process";
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

export function deployContracts(rpcUrl = "http://127.0.0.1:8545"): DeployedAddresses {
  const forge = findForge();

  console.log("[deploy] building contracts...");
  execSync(`${forge} build --quiet`, { cwd: CONTRACTS_DIR, stdio: "inherit" });

  console.log("[deploy] running MockDeploy.s.sol... (first run takes 2–4 minutes)");
  const started = Date.now();
  const output = execSync(
    `${forge} script script/MockDeploy.s.sol --rpc-url ${rpcUrl} --broadcast`,
    { cwd: CONTRACTS_DIR, stdio: ["ignore", "pipe", "inherit"] }
  ).toString();
  console.log(`[deploy] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  return parseAddresses(output);
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
    "USDC_ADDRESS", "CTF_ADDRESS", "POSEIDON_ADDRESS", "REGISTRY_ADDRESS",
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
