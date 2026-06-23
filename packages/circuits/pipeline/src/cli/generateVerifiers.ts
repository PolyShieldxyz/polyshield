// Generate the snarkjs Groth16 Solidity verifier for each circuit and wrap it in the
// IVerifier adapter the Vault expects. Writes both to packages/circuits/pipeline/contracts/generated
// and to packages/contracts/src/verifiers/<Name>Verifier.sol.
//
// Output format (verified against the committed verifiers): a `<Name>G16Base` contract
// (snarkjs `Groth16Verifier`, renamed) + a `<Name>Verifier is IVerifier` adapter.
import * as snarkjs from "snarkjs";
import fs from "fs";
import path from "path";
import { CIRCUIT_IDS, CIRCUITS } from "../constants";
import { SETUP, GENERATED, VERIFIERS_DEST } from "../lib/paths";
import { buildAdapter } from "../lib/adapter";

function resolveTemplate(): string {
  // snarkjs ships the groth16 solidity template under its package.
  const candidates = [
    "snarkjs/templates/verifier_groth16.sol.ejs",
    "snarkjs/build/templates/verifier_groth16.sol.ejs",
  ];
  for (const c of candidates) {
    try {
      return require.resolve(c);
    } catch {
      /* try next */
    }
  }
  // Fallback: snarkjs >=0.7 ships an `exports` map that blocks bare subpath resolution
  // (ERR_PACKAGE_PATH_NOT_EXPORTED). Locate the package root from its main entry and
  // walk up looking for templates/verifier_groth16.sol.ejs.
  try {
    let dir = path.dirname(require.resolve("snarkjs"));
    for (let i = 0; i < 6; i++) {
      const cand = path.join(dir, "templates", "verifier_groth16.sol.ejs");
      if (fs.existsSync(cand)) return cand;
      dir = path.dirname(dir);
    }
  } catch {
    /* fall through to error */
  }
  throw new Error(
    "Could not locate snarkjs groth16 Solidity template. Check the snarkjs version/layout " +
      "(expected snarkjs/templates/verifier_groth16.sol.ejs)."
  );
}

async function main(): Promise<void> {
  fs.mkdirSync(GENERATED, { recursive: true });
  const template = fs.readFileSync(resolveTemplate(), "utf8");

  // ONLY_CIRCUIT=<id> regenerates a single verifier (leaves the others as committed).
  const only = process.env.ONLY_CIRCUIT;
  const ids = only ? CIRCUIT_IDS.filter((id) => id === only) : CIRCUIT_IDS;
  for (const id of ids) {
    const spec = CIRCUITS[id];
    const zkey = path.join(SETUP, `${id}.zkey`);
    if (!fs.existsSync(zkey)) throw new Error(`zkey not found (run setup:circuits first): ${zkey}`);

    const raw = await snarkjs.zKey.exportSolidityVerifier(zkey, { groth16: template });

    // Drop the snarkjs SPDX/pragma preamble; keep from the contract declaration onward
    // and rename the contract to the adapter's base name.
    const idx = raw.indexOf("contract Groth16Verifier");
    if (idx === -1) throw new Error(`unexpected snarkjs verifier output for ${id}`);
    const base = raw.slice(idx).replace(/Groth16Verifier/g, `${spec.verifier}G16Base`);

    const header =
      `// SPDX-License-Identifier: MIT\n` +
      `pragma solidity ^0.8.24;\n\n` +
      `import {IVerifier} from "../interfaces/IVerifier.sol";\n` +
      `import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";\n` +
      `import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";\n` +
      `import {OwnableUpgradeable} from "@openzeppelin-upgradeable/access/OwnableUpgradeable.sol";\n\n` +
      `// snarkJS-generated Groth16 verifier — ${id} circuit (${spec.publicSignals} public signals).\n` +
      `// The <Name>G16Base contract below is generated; the <Name>Verifier adapter is UUPS-upgradeable.\n` +
      `// Regenerate via packages/circuits/pipeline (pnpm generate:verifiers). Do not edit by hand.\n`;

    const sol = header + base + "\n" + buildAdapter(spec.verifier, spec.publicSignals);

    fs.writeFileSync(path.join(GENERATED, `${spec.verifier}Verifier.sol`), sol);
    fs.writeFileSync(path.join(VERIFIERS_DEST, `${spec.verifier}Verifier.sol`), sol);
    console.log(`[verifiers] ${id} -> ${spec.verifier}Verifier.sol`);
  }
  console.log("[verifiers] done");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
