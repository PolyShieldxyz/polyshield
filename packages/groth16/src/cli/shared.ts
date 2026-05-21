import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

import {
  ARTIFACTS_DIR,
  CIRCUIT_IDS,
  GENERATED_CONTRACTS_DIR,
  PACKAGE_ROOT,
  SETUP_DIR,
} from "../constants";
import { getCircuitArtifacts } from "../artifacts";
import type { CircuitId } from "../interfaces";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function sha256File(filePath: string): string {
  const contents = fs.readFileSync(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

export function runOrThrow(bin: string, args: string[], cwd = PACKAGE_ROOT): void {
  const result = spawnSync(bin, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${bin} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
}

export function manifestPath(): string {
  return path.join(ARTIFACTS_DIR, "manifest.json");
}

export function loadManifest(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(manifestPath(), "utf8")) as Record<string, unknown>;
}

export function saveManifest(manifest: Record<string, unknown>): void {
  fs.writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function assertSnarkjsInstalled(): void {
  const localBinary = path.join(PACKAGE_ROOT, "node_modules", ".bin", process.platform === "win32" ? "snarkjs.cmd" : "snarkjs");
  if (!fs.existsSync(localBinary)) {
    throw new Error("snarkjs is not installed in packages/groth16. Run `npm install` in that package first.");
  }
}

export function localSnarkjsBinary(): string {
  return path.join(PACKAGE_ROOT, "node_modules", ".bin", process.platform === "win32" ? "snarkjs.cmd" : "snarkjs");
}

export function setupDirectories(): void {
  ensureDir(ARTIFACTS_DIR);
  ensureDir(SETUP_DIR);
  ensureDir(GENERATED_CONTRACTS_DIR);
  for (const circuitId of CIRCUIT_IDS) {
    ensureDir(getCircuitArtifacts(circuitId).outputDir);
  }
}

export function circuitMetadata(circuitId: CircuitId): Record<string, string> {
  const artifacts = getCircuitArtifacts(circuitId);
  return {
    circuitPath: path.relative(PACKAGE_ROOT, artifacts.circuitPath),
    r1csPath: path.relative(PACKAGE_ROOT, artifacts.r1csPath),
    wasmPath: path.relative(PACKAGE_ROOT, artifacts.wasmPath),
    symPath: path.relative(PACKAGE_ROOT, artifacts.symPath),
    zkeyPath: path.relative(PACKAGE_ROOT, artifacts.zkeyPath),
    verificationKeyPath: path.relative(PACKAGE_ROOT, artifacts.verificationKeyPath),
    generatedVerifierPath: path.relative(PACKAGE_ROOT, artifacts.generatedVerifierPath),
  };
}
