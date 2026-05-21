/**
 * Groth16 prover timing benchmark — N runs per circuit, average + stddev.
 * Mirrors the structure of packages/circuits/bench.sh for direct comparison.
 *
 * Usage: cd packages/groth16 && npm run bench:prover
 */

// @ts-ignore
import { groth16 } from "snarkjs";
// @ts-ignore
import { poseidon2, poseidon3 } from "poseidon-lite";

import { getCircuitArtifacts } from "../artifacts";
import type { CircuitId } from "../interfaces";

const N = 5;
const CIRCUITS: CircuitId[] = ["bet_auth", "settlement_credit", "withdrawal", "bet_cancel", "cancel_credit"];

const ZEROS32 = Array(32).fill("0");
const INDICES32 = Array(32).fill("0");

function merkleRootFromLeaf(leaf: bigint): bigint {
  let h = leaf;
  for (let i = 0; i < 32; i++) h = poseidon2([h, 0n]) as bigint;
  return h;
}

function buildInputs(circuitId: CircuitId): Record<string, string | string[]> {
  switch (circuitId) {
    case "bet_auth": {
      const secret = 1n, balance = 1_000_000_000n, nonce = 0n;
      const betAmount = 100_000_000n, price = 65_000_000n;
      const SCALE = 100_000_000n;
      const expectedShares = (betAmount * SCALE) / price;
      const shareRemainder = (betAmount * SCALE) - expectedShares * price;
      const oldCommitment = poseidon3([secret, balance, nonce]) as bigint;
      const merkleRoot = merkleRootFromLeaf(oldCommitment);
      const nullifier = poseidon2([secret, nonce]) as bigint;
      const newCommitment = poseidon3([secret, balance - betAmount, nonce + 1n]) as bigint;
      return {
        secret: secret.toString(), current_balance: balance.toString(), nonce: nonce.toString(),
        merkle_path: ZEROS32, merkle_path_indices: INDICES32,
        share_remainder: shareRemainder.toString(),
        merkle_root: merkleRoot.toString(), nullifier: nullifier.toString(),
        new_commitment: newCommitment.toString(),
        bet_amount: betAmount.toString(), price: price.toString(),
        expected_shares: expectedShares.toString(), market_id: "1", outcome_side: "1", position_id: "2",
      };
    }
    case "settlement_credit": {
      const secret = 1n, balance = 500_000_000n, nonce = 5n;
      const payout = 500_000n, shares = 1_000n, credit = payout * shares;
      const oldCommitment = poseidon3([secret, balance, nonce]) as bigint;
      return {
        secret: secret.toString(), balance_before_credit: balance.toString(), nonce: nonce.toString(),
        merkle_path: ZEROS32, merkle_path_indices: INDICES32,
        merkle_root: merkleRootFromLeaf(oldCommitment).toString(),
        nullifier: (poseidon2([secret, nonce]) as bigint).toString(),
        new_commitment: (poseidon3([secret, balance + credit, nonce + 1n]) as bigint).toString(),
        nullifier_of_bet: "42", market_id: "1",
        payout_per_share: payout.toString(), shares_held: shares.toString(), total_credit: credit.toString(),
      };
    }
    case "withdrawal": {
      const secret = 1n, balance = 2_000_000_000n, nonce = 3n;
      const recipient = 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045n;
      const oldCommitment = poseidon3([secret, balance, nonce]) as bigint;
      return {
        secret: secret.toString(), final_balance: balance.toString(), nonce: nonce.toString(),
        merkle_path: ZEROS32, merkle_path_indices: INDICES32,
        recipient_address: recipient.toString(),
        merkle_root: merkleRootFromLeaf(oldCommitment).toString(),
        nullifier: (poseidon2([secret, nonce]) as bigint).toString(),
        withdrawal_amount: "500000000",
        recipient_hash: (poseidon2([recipient, 0n]) as bigint).toString(),
      };
    }
    case "bet_cancel": {
      const secret = 1n, balance = 900_000_000n, nonce = 1n, bet = 100_000_000n;
      const oldCommitment = poseidon3([secret, balance, nonce]) as bigint;
      return {
        secret: secret.toString(), current_balance: balance.toString(), nonce: nonce.toString(),
        merkle_path: ZEROS32, merkle_path_indices: INDICES32,
        merkle_root: merkleRootFromLeaf(oldCommitment).toString(),
        nullifier: (poseidon2([secret, nonce]) as bigint).toString(),
        new_commitment: (poseidon3([secret, balance + bet, nonce + 1n]) as bigint).toString(),
        nullifier_of_bet: "42", bet_amount: bet.toString(),
      };
    }
    case "cancel_credit": {
      const secret = 1n, balance = 900_000_000n, nonce = 2n, bet = 100_000_000n;
      const oldCommitment = poseidon3([secret, balance, nonce]) as bigint;
      return {
        secret: secret.toString(), current_balance: balance.toString(), nonce: nonce.toString(),
        merkle_path: ZEROS32, merkle_path_indices: INDICES32,
        merkle_root: merkleRootFromLeaf(oldCommitment).toString(),
        nullifier: (poseidon2([secret, nonce]) as bigint).toString(),
        new_commitment: (poseidon3([secret, balance + bet, nonce + 1n]) as bigint).toString(),
        nullifier_of_bet: "43", market_id: "99", bet_amount: bet.toString(),
      };
    }
  }
}

function stats(vals: number[]): { avg: number; std: number } {
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - avg) ** 2, 0) / vals.length;
  return { avg, std: Math.sqrt(variance) };
}

(async () => {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("  Polyshield Groth16 Prover Benchmark");
  console.log(`  N=${N} runs per circuit`);
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log(
    `\n  ${"Circuit".padEnd(22)}  ${"avg (ms)".padStart(10)}  ${"± (ms)".padStart(10)}`
  );
  console.log("  " + "─".repeat(48));

  const results: { circuit: string; avg: number; std: number }[] = [];

  for (const circuitId of CIRCUITS) {
    const artifacts = getCircuitArtifacts(circuitId);
    const inputs = buildInputs(circuitId);
    const times: number[] = [];

    for (let i = 0; i < N; i++) {
      const t0 = Date.now();
      await groth16.fullProve(inputs, artifacts.wasmPath, artifacts.zkeyPath);
      times.push(Date.now() - t0);
      process.stdout.write(".");
    }

    const { avg, std } = stats(times);
    results.push({ circuit: circuitId, avg, std });
    console.log(`\r  ${circuitId.padEnd(22)}  ${avg.toFixed(0).padStart(10)}  ${std.toFixed(0).padStart(10)}`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("  RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════════════\n");
  console.log(
    `  ${"Circuit".padEnd(22)}  ${"avg (ms)".padStart(10)}  ${"± (ms)".padStart(10)}`
  );
  console.log("  " + "─".repeat(48));
  for (const r of results) {
    console.log(`  ${r.circuit.padEnd(22)}  ${r.avg.toFixed(0).padStart(10)}  ${r.std.toFixed(0).padStart(10)}`);
  }
  const overallAvg = results.reduce((a, b) => a + b.avg, 0) / results.length;
  console.log(`\n  Average across all circuits: ${overallAvg.toFixed(0)} ms`);
  console.log("\n  Note: UltraPLONK (nargo/bb) avg: ~1300 ms");
  console.log("  Note: Groth16 runs in Node.js (snarkjs); UltraPLONK runs in native Rust (bb).");
  console.log("  For client-side WASM, expect Groth16 to be 3-10x slower than native snarkjs.");
  console.log("═══════════════════════════════════════════════════════════════════════\n");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
