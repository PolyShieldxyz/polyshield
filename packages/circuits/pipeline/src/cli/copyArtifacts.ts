// Copy compiled wasm + zkey artifacts into the frontend public dirs the prover fetches
// from (`/circuits/<id>.wasm`, `/zkeys/<id>.zkey`). These files are gitignored.
import fs from "fs";
import path from "path";
import { CIRCUIT_IDS } from "../constants";
import { ARTIFACTS, SETUP, FRONTEND_WASM, FRONTEND_ZKEY } from "../lib/paths";

function main(): void {
  fs.mkdirSync(FRONTEND_WASM, { recursive: true });
  fs.mkdirSync(FRONTEND_ZKEY, { recursive: true });
  // ONLY_CIRCUIT=<id> copies a single circuit's artifacts. Default: all circuits.
  const only = process.env.ONLY_CIRCUIT;
  const ids = only ? CIRCUIT_IDS.filter((id) => id === only) : CIRCUIT_IDS;
  for (const id of ids) {
    const wasm = path.join(ARTIFACTS, id, `${id}_js`, `${id}.wasm`);
    const zkey = path.join(SETUP, `${id}.zkey`);
    if (!fs.existsSync(wasm)) throw new Error(`wasm not found (run compile:circuits): ${wasm}`);
    if (!fs.existsSync(zkey)) throw new Error(`zkey not found (run setup:circuits): ${zkey}`);
    fs.copyFileSync(wasm, path.join(FRONTEND_WASM, `${id}.wasm`));
    fs.copyFileSync(zkey, path.join(FRONTEND_ZKEY, `${id}.zkey`));
    console.log(`[copy] ${id}.wasm + ${id}.zkey -> frontend/public`);
  }
  console.log("[copy] done");
}

main();
