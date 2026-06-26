// Regenerate the RealVerifier.t.sol fixtures (test/fixtures/<name>.json) for ALL EIGHT
// active circuits: deposit, bet_auth, settlement_credit, withdrawal, bet_cancel,
// cancel_credit, position_close, partial_credit.
//
// Every fixture MUST be regenerated whenever setup runs (a fresh trusted setup changes
// every circuit's verifying key). Each fixture is
//   { proof: <abi-encoded, G2-swapped bytes>, signals: [decimal strings] }
// where `signals` is snarkjs's publicSignals in the circuit's `public [...]` order.
//
// Witnesses are self-consistent and satisfy the post-fix constraints:
//   - bet_auth:          expected_shares*price + share_remainder == bet_amount*1e8; price>0.
//   - settlement_credit: bet_nonce < nonce (SEC-001) => nonce>=1.
//   - bet_cancel/cancel_credit: nonce>=1 (SEC-002); nullifier_of_bet = P2(secret, nonce-1).
//   - position_close:    nonce=1, bet_nonce=0  => SEC-001 betNonce<nonce (0<1) holds.
//   - partial_credit:    nonce=1               => SEC-002 0<nonce holds; bet_nonce = nonce-1 = 0.
import * as snarkjs from "snarkjs";
import fs from "fs";
import path from "path";
import { poseidon2, poseidon4 } from "poseidon-lite";
import { encodeProof, SnarkjsProof } from "../lib/proofEncoding";
import { ARTIFACTS, SETUP, FIXTURES_DEST } from "../lib/paths";

const DEPTH = 32;
// uint256(uint160(address)) for a fixed test owner (Anvil ALICE).
const OWNER = BigInt("0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65");

// Zero-subtree hashes: z[0] = 0 (the zero leaf, matching CommitmentMerkleTree.sol),
// z[k] = Poseidon2(z[k-1], z[k-1]).
function zeroSubtree(): bigint[] {
  const z: bigint[] = [0n];
  for (let i = 1; i <= DEPTH; i++) z[i] = poseidon2([z[i - 1], z[i - 1]]);
  return z;
}

// Membership for a leaf placed at index 0 (all path bits = 0 => leaf is the left child
// at every level; sibling[i] is the zero-subtree root at that height). Matches
// PoseidonMerklePath: hash(left,right) with left=current, right=sibling when pathIndex=0.
function merkleForIndex0(leaf: bigint): {
  siblings: string[];
  pathIndices: string[];
  root: string;
} {
  const z = zeroSubtree();
  const siblings: string[] = [];
  const pathIndices: string[] = [];
  let node = leaf;
  for (let i = 0; i < DEPTH; i++) {
    siblings.push(z[i].toString());
    pathIndices.push("0");
    node = poseidon2([node, z[i]]);
  }
  return { siblings, pathIndices, root: node.toString() };
}

// Membership for SEVERAL leaves placed at contiguous indices 0..leaves.length-1 in an
// otherwise-zero append-only tree (matches CommitmentMerkleTree.sol). Returns the shared
// root plus, per leaf, its (siblings, pathIndices). Needed for consolidate, which proves
// >= 2 distinct active leaves against ONE root in a single proof.
function merkleForLeaves(leaves: bigint[]): {
  root: string;
  paths: { siblings: string[]; pathIndices: string[] }[];
} {
  const z = zeroSubtree();
  const levels: bigint[][] = [leaves.slice()];
  for (let i = 0; i < DEPTH; i++) {
    const cur = levels[i];
    const next: bigint[] = [];
    for (let k = 0; k < cur.length; k += 2) {
      const left = cur[k];
      const right = k + 1 < cur.length ? cur[k + 1] : z[i];
      next.push(poseidon2([left, right]));
    }
    levels[i + 1] = next;
  }
  const top = levels[DEPTH][0];
  const root = (top !== undefined ? top : z[DEPTH]).toString();
  const paths = leaves.map((_unused, idx) => {
    const siblings: string[] = [];
    const pathIndices: string[] = [];
    for (let i = 0; i < DEPTH; i++) {
      const nodeIdx = idx >> i;
      const sibIdx = nodeIdx ^ 1;
      const sib = levels[i][sibIdx];
      siblings.push((sib !== undefined ? sib : z[i]).toString());
      pathIndices.push((nodeIdx & 1) === 1 ? "1" : "0");
    }
    return { siblings, pathIndices };
  });
  return { root, paths };
}

const ZERO_PATH_32 = Array<string>(DEPTH).fill("0");

async function prove(id: string, input: Record<string, unknown>) {
  const wasm = path.join(ARTIFACTS, id, `${id}_js`, `${id}.wasm`);
  const zkey = path.join(SETUP, `${id}.zkey`);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  return { proof: encodeProof(proof as SnarkjsProof), signals: publicSignals };
}

function depositFixture() {
  const secret = 12345678901234567890n;
  const amount = 1_000_000n; // $1 (6dp)
  const commitment = poseidon4([secret, amount, 0n, OWNER]);
  return prove("deposit", {
    secret: secret.toString(),
    commitment: commitment.toString(),
    amount: amount.toString(),
    owner_address: OWNER.toString(),
  });
}

function positionCloseFixture() {
  const secret = 111n;
  const balance = 500_000n;
  const nonce = 1n;
  const betNonce = 0n; // < nonce (SEC-001)
  const sellProceeds = 250_000n;
  const leaf = poseidon4([secret, balance, nonce, OWNER]);
  const { siblings, pathIndices, root } = merkleForIndex0(leaf);
  return prove("position_close", {
    secret: secret.toString(),
    balance_before_credit: balance.toString(),
    nonce: nonce.toString(),
    bet_nonce: betNonce.toString(),
    merkle_path: siblings,
    merkle_path_indices: pathIndices,
    owner_address: OWNER.toString(),
    merkle_root: root,
    nullifier: poseidon2([secret, nonce]).toString(),
    new_commitment: poseidon4([secret, balance + sellProceeds, nonce + 1n, OWNER]).toString(),
    nullifier_of_bet: poseidon2([secret, betNonce]).toString(),
    sell_proceeds: sellProceeds.toString(),
  });
}

function partialCreditFixture() {
  const secret = 222n;
  const balance = 400_000n;
  const nonce = 1n; // 0 < nonce (SEC-002); bet_nonce = nonce - 1 = 0
  const refund = 150_000n;
  const leaf = poseidon4([secret, balance, nonce, OWNER]);
  const { siblings, pathIndices, root } = merkleForIndex0(leaf);
  return prove("partial_credit", {
    secret: secret.toString(),
    current_balance: balance.toString(),
    nonce: nonce.toString(),
    merkle_path: siblings,
    merkle_path_indices: pathIndices,
    owner_address: OWNER.toString(),
    bet_nonce: (nonce - 1n).toString(), // decoupled reclaim: bet_nonce < nonce
    merkle_root: root,
    nullifier: poseidon2([secret, nonce]).toString(),
    new_commitment: poseidon4([secret, balance + refund, nonce + 1n, OWNER]).toString(),
    nullifier_of_bet: poseidon2([secret, nonce - 1n]).toString(),
    refund_amount: refund.toString(),
  });
}

function betAuthFixture() {
  const secret = 777n;
  const currentBalance = 5_000_000n;
  const nonce = 1n;
  // expected_shares*price + share_remainder == bet_amount*1e8 ; share_remainder < price ; price > 0.
  const betAmount = 1_000_000n; // $1 (6dp)
  const price = 50_000_000n; // 0.5 in 1e8 scale
  const expectedShares = (betAmount * 100_000_000n) / price; // = 2_000_000
  const shareRemainder = betAmount * 100_000_000n - expectedShares * price; // = 0
  // FEE: Vault-injected fee = bet_amount * betFeeBps/10000 + relayGasFeeUSDC.
  // With betFeeBps = 5 (0.05%) and relayGasFeeUSDC = 0: fee = floor(1_000_000*5/10000) = 500.
  const fee = 500n;
  const newBalance = currentBalance - betAmount - fee;
  const leaf = poseidon4([secret, currentBalance, nonce, OWNER]);
  const { siblings, pathIndices, root } = merkleForIndex0(leaf);
  return prove("bet_auth", {
    secret: secret.toString(),
    current_balance: currentBalance.toString(),
    nonce: nonce.toString(),
    merkle_path: siblings,
    merkle_path_indices: pathIndices,
    share_remainder: shareRemainder.toString(),
    owner_address: OWNER.toString(),
    merkle_root: root,
    nullifier: poseidon2([secret, nonce]).toString(),
    new_commitment: poseidon4([secret, newBalance, nonce + 1n, OWNER]).toString(),
    bet_amount: betAmount.toString(),
    price: price.toString(),
    expected_shares: expectedShares.toString(),
    market_id: "123",
    outcome_side: "0",
    position_id: "456",
    fee: fee.toString(),
  });
}

function settlementCreditFixture() {
  const secret = 333n;
  const balance = 500_000n;
  const nonce = 2n;
  const betNonce = 0n; // < nonce (SEC-001)
  const totalCredit = 300_000n;
  const leaf = poseidon4([secret, balance, nonce, OWNER]);
  const { siblings, pathIndices, root } = merkleForIndex0(leaf);
  return prove("settlement_credit", {
    secret: secret.toString(),
    balance_before_credit: balance.toString(),
    nonce: nonce.toString(),
    bet_nonce: betNonce.toString(),
    merkle_path: siblings,
    merkle_path_indices: pathIndices,
    owner_address: OWNER.toString(),
    merkle_root: root,
    nullifier: poseidon2([secret, nonce]).toString(),
    new_commitment: poseidon4([secret, balance + totalCredit, nonce + 1n, OWNER]).toString(),
    nullifier_of_bet: poseidon2([secret, betNonce]).toString(),
    market_id: "123",
    total_credit: totalCredit.toString(),
  });
}

function withdrawalFixture() {
  const secret = 444n;
  const finalBalance = 1_000_000n;
  const nonce = 1n;
  const withdrawalAmount = 400_000n; // partial (< balance) => new_commitment != 0
  const remaining = finalBalance - withdrawalAmount;
  const leaf = poseidon4([secret, finalBalance, nonce, OWNER]);
  const { siblings, pathIndices, root } = merkleForIndex0(leaf);
  return prove("withdrawal", {
    secret: secret.toString(),
    final_balance: finalBalance.toString(),
    nonce: nonce.toString(),
    merkle_path: siblings,
    merkle_path_indices: pathIndices,
    owner_address: OWNER.toString(),
    recipient_address: OWNER.toString(), // W-to-W: recipient must equal owner
    merkle_root: root,
    nullifier: poseidon2([secret, nonce]).toString(),
    withdrawal_amount: withdrawalAmount.toString(),
    recipient_hash: poseidon2([OWNER, 0n]).toString(), // RecipientHash(owner)
    new_commitment: poseidon4([secret, remaining, nonce + 1n, OWNER]).toString(),
  });
}

function betCancelFixture() {
  const secret = 555n;
  const balance = 300_000n;
  const nonce = 1n; // >=1 (SEC-002); bet_nonce = nonce-1 = 0
  const betAmount = 200_000n;
  const restored = balance + betAmount;
  const leaf = poseidon4([secret, balance, nonce, OWNER]);
  const { siblings, pathIndices, root } = merkleForIndex0(leaf);
  return prove("bet_cancel", {
    secret: secret.toString(),
    current_balance: balance.toString(),
    nonce: nonce.toString(),
    merkle_path: siblings,
    merkle_path_indices: pathIndices,
    owner_address: OWNER.toString(),
    bet_nonce: (nonce - 1n).toString(), // decoupled reclaim: bet_nonce < nonce
    merkle_root: root,
    nullifier: poseidon2([secret, nonce]).toString(),
    new_commitment: poseidon4([secret, restored, nonce + 1n, OWNER]).toString(),
    nullifier_of_bet: poseidon2([secret, nonce - 1n]).toString(),
    bet_amount: betAmount.toString(),
  });
}

function cancelCreditFixture() {
  const secret = 666n;
  const balance = 300_000n;
  const nonce = 1n; // >=1 (SEC-002); bet_nonce = nonce-1 = 0
  const betAmount = 100_000n;
  const restored = balance + betAmount;
  const leaf = poseidon4([secret, balance, nonce, OWNER]);
  const { siblings, pathIndices, root } = merkleForIndex0(leaf);
  return prove("cancel_credit", {
    secret: secret.toString(),
    current_balance: balance.toString(),
    nonce: nonce.toString(),
    merkle_path: siblings,
    merkle_path_indices: pathIndices,
    owner_address: OWNER.toString(),
    bet_nonce: (nonce - 1n).toString(), // decoupled reclaim: bet_nonce < nonce
    merkle_root: root,
    nullifier: poseidon2([secret, nonce]).toString(),
    new_commitment: poseidon4([secret, restored, nonce + 1n, OWNER]).toString(),
    nullifier_of_bet: poseidon2([secret, nonce - 1n]).toString(),
    market_id: "123",
    bet_amount: betAmount.toString(),
  });
}

// Consolidate two active notes (indices 0 and 1) + two inactive (padded) slots into one
// merged note continuing slot 0's lineage. Public signals order:
// [merkle_root, nullifier[0..3], new_commitment] = 6.
function consolidateFixture() {
  const secret0 = 701n;
  const balance0 = 600_000n;
  const nonce0 = 1n;
  const secret1 = 702n;
  const balance1 = 400_000n;
  const nonce1 = 3n;
  const sum = balance0 + balance1; // 1_000_000
  const leaf0 = poseidon4([secret0, balance0, nonce0, OWNER]);
  const leaf1 = poseidon4([secret1, balance1, nonce1, OWNER]);
  const { root, paths } = merkleForLeaves([leaf0, leaf1]);
  return prove("consolidate", {
    secret: [secret0.toString(), secret1.toString(), "0", "0"],
    balance: [balance0.toString(), balance1.toString(), "0", "0"],
    nonce: [nonce0.toString(), nonce1.toString(), "0", "0"],
    merkle_path: [paths[0].siblings, paths[1].siblings, ZERO_PATH_32, ZERO_PATH_32],
    merkle_path_indices: [paths[0].pathIndices, paths[1].pathIndices, ZERO_PATH_32, ZERO_PATH_32],
    is_active: ["1", "1", "0", "0"],
    owner_address: OWNER.toString(),
    merkle_root: root,
    nullifier: [
      poseidon2([secret0, nonce0]).toString(),
      poseidon2([secret1, nonce1]).toString(),
      "0",
      "0",
    ],
    new_commitment: poseidon4([secret0, sum, nonce0 + 1n, OWNER]).toString(),
  });
}

async function main(): Promise<void> {
  fs.mkdirSync(FIXTURES_DEST, { recursive: true });
  const fixtures: Record<string, () => Promise<{ proof: string; signals: string[] }>> = {
    deposit_proof: depositFixture,
    bet_auth_proof: betAuthFixture,
    settlement_credit_proof: settlementCreditFixture,
    withdrawal_proof: withdrawalFixture,
    bet_cancel_proof: betCancelFixture,
    cancel_credit_proof: cancelCreditFixture,
    position_close_proof: positionCloseFixture,
    partial_credit_proof: partialCreditFixture,
    consolidate_proof: consolidateFixture,
  };
  // ONLY_CIRCUIT=<id> regenerates only that circuit's fixture (avoids re-randomizing the
  // other committed proofs, whose zkeys were not re-keyed). Default: all fixtures.
  const only = process.env.ONLY_CIRCUIT;
  for (const [name, fn] of Object.entries(fixtures)) {
    if (only && name !== `${only}_proof`) continue;
    console.log(`[fixtures] ${name}`);
    const out = await fn();
    fs.writeFileSync(path.join(FIXTURES_DEST, `${name}.json`), JSON.stringify(out, null, 2));
  }
  console.log("[fixtures] done");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
