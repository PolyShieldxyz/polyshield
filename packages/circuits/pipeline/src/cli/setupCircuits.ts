// Groth16 phase-2 setup for every circuit: newZKey -> contribute -> export vkey.
// Produces setup/<id>.zkey and setup/<id>.vkey.json.
//
// The per-circuit phase-2 contribution entropy is typed by the operator at runtime
// (no-echo). It is never hardcoded, logged, written to disk, or passed on the command
// line. Keep the value you type secret; anyone who knows it can forge proofs.
import * as snarkjs from "snarkjs";
import fs from "fs";
import path from "path";
import readline from "readline";
import { Writable } from "stream";
import { CIRCUIT_IDS } from "../constants";
import { ARTIFACTS, SETUP, PTAU } from "../lib/paths";

// Read a secret from the terminal without echoing it. Requires an interactive TTY so
// the value can never be supplied via env/argv (which would leak through process lists
// and shell history) or run unattended with a predictable fallback.
function readSecretEntropy(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(
      new Error(
        "Refusing to run non-interactively: phase-2 entropy must be typed at the prompt " +
          "so it is never stored, logged, or passed on the command line. Run from a terminal."
      )
    );
  }
  return new Promise((resolve) => {
    let muted = false;
    const out = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
    process.stdout.write(promptText);
    muted = true;
    rl.question("", (answer) => {
      muted = false;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  if (!fs.existsSync(PTAU)) {
    throw new Error(
      `Powers-of-Tau file not found at ${PTAU}.\n` +
        `Download one sized to the largest circuit (check with \`snarkjs r1cs info <r1cs>\`; ` +
        `depth-32 Poseidon circuits typically need 2^17–2^18), e.g.:\n` +
        `  mkdir -p ${path.dirname(PTAU)}\n` +
        `  curl -L -o ${PTAU} https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau\n` +
        `Or set POT_PATH to an existing .ptau file.`
    );
  }
  fs.mkdirSync(SETUP, { recursive: true });

  // Operator-supplied phase-2 entropy, read once and reused (snarkjs additionally mixes
  // in OS CSPRNG bytes per contribution, so each circuit's contribution is independent).
  const entropy = (
    await readSecretEntropy("Enter secret phase-2 entropy (will NOT be echoed; only you should ever know it): ")
  ).trim();
  if (entropy.length < 16) {
    throw new Error("Entropy too short — type at least 16 characters of unpredictable text (30+ recommended).");
  }

  // ONLY_CIRCUIT=<id> runs setup for a single circuit (leaves the other zkeys/vkeys intact,
  // so their committed verifiers keep verifying). Default: all circuits.
  const only = process.env.ONLY_CIRCUIT;
  const ids = only ? CIRCUIT_IDS.filter((id) => id === only) : CIRCUIT_IDS;
  for (const id of ids) {
    const r1cs = path.join(ARTIFACTS, id, `${id}.r1cs`);
    if (!fs.existsSync(r1cs)) throw new Error(`r1cs not found (run compile:circuits first): ${r1cs}`);
    const zkey0 = path.join(SETUP, `${id}_0000.zkey`);
    const zkeyFinal = path.join(SETUP, `${id}.zkey`);
    const vkeyFile = path.join(SETUP, `${id}.vkey.json`);

    console.log(`[setup] ${id}: newZKey`);
    await snarkjs.zKey.newZKey(r1cs, PTAU, zkey0);
    console.log(`[setup] ${id}: contribute`);
    await snarkjs.zKey.contribute(zkey0, zkeyFinal, `polyshield-${id}`, `${entropy}:${id}`);
    const vk = await snarkjs.zKey.exportVerificationKey(zkeyFinal);
    fs.writeFileSync(vkeyFile, JSON.stringify(vk, null, 2));
    fs.rmSync(zkey0);
  }
  console.log("[setup] done");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
