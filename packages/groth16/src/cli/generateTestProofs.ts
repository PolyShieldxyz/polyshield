/**
 * Generates Groth16 test proofs for all 5 Polyshield circuits.
 * Proof bytes are ABI-encoded (256 bytes) for direct use in the Solidity gas benchmark.
 * Output: packages/groth16/bench_out/{circuit}.proof.hex and {circuit}.pubsignals.json
 *
 * Witness strategy: secret=1, nonce varies per circuit, all-zero Merkle path with
 * all-zero indices. Poseidon values are computed using poseidon-lite (BN254-compatible
 * with circomlib).
 */

import fs from "fs";
import path from "path";
import { ethers } from "ethers";
// @ts-ignore — snarkjs has no bundled TS declarations
import { groth16 } from "snarkjs";
// @ts-ignore — poseidon-lite has no TS declarations
import { poseidon2, poseidon3 } from "poseidon-lite";

import { PACKAGE_ROOT } from "../constants";
import { getCircuitArtifacts } from "../artifacts";

const BENCH_OUT = path.join(PACKAGE_ROOT, "bench_out");
fs.mkdirSync(BENCH_OUT, { recursive: true });

// 32-element zero array for Merkle path
const ZEROS32 = Array(32).fill("0");
const INDICES32 = Array(32).fill("0");

// Compute the Merkle root when the leaf is at the leftmost position
// and all siblings are 0. Each level: hash = poseidon2(current, 0).
function merkleRootFromLeaf(leaf: bigint): bigint {
  let h = leaf;
  for (let i = 0; i < 32; i++) {
    h = poseidon2([h, 0n]) as bigint;
  }
  return h;
}

// ── Witness builders ─────────────────────────────────────────────────────────

function betAuthWitness() {
  const secret = 1n;
  const balance = 1_000_000_000n; // 1000 USDC
  const nonce = 0n;
  const betAmount = 100_000_000n;  // 100 USDC
  const price = 65_000_000n;       // 0.65
  // expected_shares = floor(betAmount * 1e8 / price)
  const SCALE = 100_000_000n;
  const expectedShares = (betAmount * SCALE) / price; // 153_846_153
  const shareRemainder = (betAmount * SCALE) - expectedShares * price;
  const marketId = 1n;
  const outcomeSide = 1n;
  const positionId = 2n;

  const oldCommitment = poseidon3([secret, balance, nonce]) as bigint;
  const merkleRoot = merkleRootFromLeaf(oldCommitment);
  const nullifier = poseidon2([secret, nonce]) as bigint;
  const newBalance = balance - betAmount;
  const newNonce = nonce + 1n;
  const newCommitment = poseidon3([secret, newBalance, newNonce]) as bigint;

  return {
    inputs: {
      secret: secret.toString(),
      current_balance: balance.toString(),
      nonce: nonce.toString(),
      merkle_path: ZEROS32,
      merkle_path_indices: INDICES32,
      share_remainder: shareRemainder.toString(),
      merkle_root: merkleRoot.toString(),
      nullifier: nullifier.toString(),
      new_commitment: newCommitment.toString(),
      bet_amount: betAmount.toString(),
      price: price.toString(),
      expected_shares: expectedShares.toString(),
      market_id: marketId.toString(),
      outcome_side: outcomeSide.toString(),
      position_id: positionId.toString(),
    },
    publicSignals: [merkleRoot, nullifier, newCommitment, betAmount, price, expectedShares, marketId, outcomeSide, positionId],
  };
}

function settlementCreditWitness() {
  const secret = 1n;
  const balanceBefore = 500_000_000n;
  const nonce = 5n;
  const payoutPerShare = 500_000n;
  const sharesHeld = 1_000n;
  const totalCredit = sharesHeld * payoutPerShare; // 500_000_000
  const nullifierOfBet = 42n;
  const marketId = 1n;

  const oldCommitment = poseidon3([secret, balanceBefore, nonce]) as bigint;
  const merkleRoot = merkleRootFromLeaf(oldCommitment);
  const nullifier = poseidon2([secret, nonce]) as bigint;
  const newBalance = balanceBefore + totalCredit;
  const newNonce = nonce + 1n;
  const newCommitment = poseidon3([secret, newBalance, newNonce]) as bigint;

  return {
    inputs: {
      secret: secret.toString(),
      balance_before_credit: balanceBefore.toString(),
      nonce: nonce.toString(),
      merkle_path: ZEROS32,
      merkle_path_indices: INDICES32,
      merkle_root: merkleRoot.toString(),
      nullifier: nullifier.toString(),
      new_commitment: newCommitment.toString(),
      nullifier_of_bet: nullifierOfBet.toString(),
      market_id: marketId.toString(),
      payout_per_share: payoutPerShare.toString(),
      shares_held: sharesHeld.toString(),
      total_credit: totalCredit.toString(),
    },
    publicSignals: [merkleRoot, nullifier, newCommitment, nullifierOfBet, marketId, payoutPerShare, sharesHeld, totalCredit],
  };
}

function withdrawalWitness() {
  const secret = 1n;
  const finalBalance = 2_000_000_000n;
  const nonce = 3n;
  const withdrawalAmount = 500_000_000n;
  const recipientAddress = 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045n;

  const oldCommitment = poseidon3([secret, finalBalance, nonce]) as bigint;
  const merkleRoot = merkleRootFromLeaf(oldCommitment);
  const nullifier = poseidon2([secret, nonce]) as bigint;
  const recipientHash = poseidon2([recipientAddress, 0n]) as bigint;

  return {
    inputs: {
      secret: secret.toString(),
      final_balance: finalBalance.toString(),
      nonce: nonce.toString(),
      merkle_path: ZEROS32,
      merkle_path_indices: INDICES32,
      recipient_address: recipientAddress.toString(),
      merkle_root: merkleRoot.toString(),
      nullifier: nullifier.toString(),
      withdrawal_amount: withdrawalAmount.toString(),
      recipient_hash: recipientHash.toString(),
    },
    publicSignals: [merkleRoot, nullifier, withdrawalAmount, recipientHash],
  };
}

function betCancelWitness() {
  const secret = 1n;
  const currentBalance = 900_000_000n; // post-bet balance
  const nonce = 1n;                    // post-bet nonce
  const betAmount = 100_000_000n;
  const nullifierOfBet = 42n;

  const oldCommitment = poseidon3([secret, currentBalance, nonce]) as bigint;
  const merkleRoot = merkleRootFromLeaf(oldCommitment);
  const nullifier = poseidon2([secret, nonce]) as bigint;
  const restoredBalance = currentBalance + betAmount;
  const newNonce = nonce + 1n;
  const newCommitment = poseidon3([secret, restoredBalance, newNonce]) as bigint;

  return {
    inputs: {
      secret: secret.toString(),
      current_balance: currentBalance.toString(),
      nonce: nonce.toString(),
      merkle_path: ZEROS32,
      merkle_path_indices: INDICES32,
      merkle_root: merkleRoot.toString(),
      nullifier: nullifier.toString(),
      new_commitment: newCommitment.toString(),
      nullifier_of_bet: nullifierOfBet.toString(),
      bet_amount: betAmount.toString(),
    },
    publicSignals: [merkleRoot, nullifier, newCommitment, nullifierOfBet, betAmount],
  };
}

function cancelCreditWitness() {
  const secret = 1n;
  const currentBalance = 900_000_000n;
  const nonce = 2n;
  const betAmount = 100_000_000n;
  const nullifierOfBet = 43n;
  const marketId = 99n;

  const oldCommitment = poseidon3([secret, currentBalance, nonce]) as bigint;
  const merkleRoot = merkleRootFromLeaf(oldCommitment);
  const nullifier = poseidon2([secret, nonce]) as bigint;
  const restoredBalance = currentBalance + betAmount;
  const newNonce = nonce + 1n;
  const newCommitment = poseidon3([secret, restoredBalance, newNonce]) as bigint;

  return {
    inputs: {
      secret: secret.toString(),
      current_balance: currentBalance.toString(),
      nonce: nonce.toString(),
      merkle_path: ZEROS32,
      merkle_path_indices: INDICES32,
      merkle_root: merkleRoot.toString(),
      nullifier: nullifier.toString(),
      new_commitment: newCommitment.toString(),
      nullifier_of_bet: nullifierOfBet.toString(),
      market_id: marketId.toString(),
      bet_amount: betAmount.toString(),
    },
    publicSignals: [merkleRoot, nullifier, newCommitment, nullifierOfBet, marketId, betAmount],
  };
}

// ── Proof serialization ───────────────────────────────────────────────────────

// ABI-encode a Groth16 proof as 256 bytes: [pi_a (64B)][pi_b (128B)][pi_c (64B)]
// pi_b inner pairs are SWAPPED relative to the snarkjs JSON format — the snarkjs
// Solidity verifier expects [b[0][1], b[0][0]] not [b[0][0], b[0][1]].
function serializeProof(proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }): string {
  const a: [bigint, bigint] = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])];
  const b: [[bigint, bigint], [bigint, bigint]] = [
    [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])], // swapped
    [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])], // swapped
  ];
  const c: [bigint, bigint] = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])];

  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"],
    [a, b, c]
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

const WITNESSES: Record<string, () => { inputs: Record<string, string | string[]>; publicSignals: bigint[] }> = {
  bet_auth: betAuthWitness,
  settlement_credit: settlementCreditWitness,
  withdrawal: withdrawalWitness,
  bet_cancel: betCancelWitness,
  cancel_credit: cancelCreditWitness,
};

(async () => {
  for (const [circuitId, buildWitness] of Object.entries(WITNESSES)) {
    process.stdout.write(`  ${circuitId} ... `);
    const artifacts = getCircuitArtifacts(circuitId as any);
    const { inputs, publicSignals } = buildWitness();

    const { proof, publicSignals: snarkjsSignals } = await groth16.fullProve(
      inputs,
      artifacts.wasmPath,
      artifacts.zkeyPath
    );

    // Verify the snarkjs-computed public signals match our pre-computed ones.
    // The order in publicSignals matches the circuit's public declaration order.
    for (let i = 0; i < publicSignals.length; i++) {
      if (BigInt(snarkjsSignals[i]) !== publicSignals[i]) {
        throw new Error(
          `${circuitId}: public signal mismatch at index ${i}: ` +
          `expected ${publicSignals[i]}, got ${snarkjsSignals[i]}`
        );
      }
    }

    const proofHex = serializeProof(proof as any);
    // Write raw bytes so Foundry can load with vm.readFileBinary
    const proofBytes = Buffer.from(proofHex.slice(2), "hex");
    fs.writeFileSync(path.join(BENCH_OUT, `${circuitId}.proof`), proofBytes);

    // Write public signals as a JSON array of 0x-padded hex strings
    const pubSignalsHex = snarkjsSignals.map((s: string) =>
      "0x" + BigInt(s).toString(16).padStart(64, "0")
    );
    fs.writeFileSync(
      path.join(BENCH_OUT, `${circuitId}.pubsignals.json`),
      JSON.stringify(pubSignalsHex, null, 2)
    );

    console.log(`ok  (${snarkjsSignals.length} pub signals)`);
  }

  console.log(`\n  Proofs saved to bench_out/`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
