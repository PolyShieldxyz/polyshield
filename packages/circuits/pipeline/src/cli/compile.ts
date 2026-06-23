// Compile every active Circom circuit to r1cs + wasm + sym.
// Requires circom 2.1.6 on PATH and circomlib resolvable at packages/circuits/node_modules
// (provided by packages/circuits/package.json — run `pnpm install` first).
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { CIRCUIT_IDS } from "../constants";
import { ARTIFACTS, CIRCUITS_SRC, CIRCOMLIB_LIB } from "../lib/paths";

function main(): void {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  // ONLY_CIRCUIT=<id> builds a single circuit in isolation (leaves the others' artifacts
  // untouched). Useful when adding a circuit without re-keying the whole set.
  const only = process.env.ONLY_CIRCUIT;
  const ids = only ? CIRCUIT_IDS.filter((id) => id === only) : CIRCUIT_IDS;
  for (const id of ids) {
    const out = path.join(ARTIFACTS, id);
    fs.mkdirSync(out, { recursive: true });
    const src = path.join(CIRCUITS_SRC, `${id}.circom`);
    if (!fs.existsSync(src)) throw new Error(`circuit source not found: ${src}`);
    console.log(`[compile] ${id}`);
    // -l adds an include search path (belt-and-suspenders; the .circom files also use
    // relative includes that resolve against packages/circuits/node_modules).
    execFileSync(
      "circom",
      [src, "--r1cs", "--wasm", "--sym", "-l", CIRCOMLIB_LIB, "-o", out],
      { stdio: "inherit" }
    );
  }
  console.log("[compile] done");
}

main();
