// Generate valid circuit inputs (real Poseidon via circomlibjs) for every PolyShield circuit,
// including boundary cases. Output: <outdir>/<circuit>__<k>.json   usage: node gen_inputs.mjs <outdir> [casesPerCircuit]
import fs from "fs";
import path from "path";
import { buildPoseidon } from "circomlibjs";

const outDir = process.argv[2];
const N = Number(process.argv[3] || 12);
fs.mkdirSync(outDir, { recursive: true });
const poseidon = await buildPoseidon();
const F = poseidon.F;
const H = (...xs) => F.toObject(poseidon(xs.map((x) => BigInt(x))));
const U64 = (1n << 64n) - 1n;
const DEPTH = 32;

// deterministic PRNG (xorshift) so runs are reproducible
let s = 0x9e3779b97f4a7c15n;
const rnd = () => { s ^= s << 13n; s &= U64; s ^= s >> 7n; s ^= s << 17n; s &= U64; return s; };
const rndBelow = (m) => rnd() % m;
const rndField = () => ((rnd() << 192n) | (rnd() << 128n) | (rnd() << 64n) | rnd()) % 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// sparse Merkle tree matching CommitmentMerkleTree.sol (zero leaf = 0, zeros[i+1] = H2(zeros[i], zeros[i]))
const zeros = [0n];
for (let i = 1; i <= DEPTH; i++) zeros.push(H(zeros[i - 1], zeros[i - 1]));
class Tree {
  constructor() { this.nodes = new Map(); this.n = 0; }
  get(l, i) { return this.nodes.get(`${l}:${i}`) ?? zeros[l]; }
  insert(leaf) {
    let idx = this.n++;
    this.nodes.set(`0:${idx}`, leaf);
    let i = idx;
    for (let l = 0; l < DEPTH; l++) {
      const left = this.get(l, i & ~1), right = this.get(l, i | 1);
      i >>= 1;
      this.nodes.set(`${l + 1}:${i}`, H(left, right));
    }
    return idx;
  }
  root() { return this.get(DEPTH, 0); }
  path(idx) {
    const sib = [], bits = [];
    let i = idx;
    for (let l = 0; l < DEPTH; l++) { sib.push(this.get(l, i ^ 1)); bits.push(i & 1); i >>= 1; }
    return { sib, bits };
  }
}

const commit = (sec, bal, non, own) => H(sec, bal, non, own);
const nullifier = (sec, non) => H(sec, non);
const str = (x) => (Array.isArray(x) ? x.map(str) : x.toString());

function noteInTree(tree, sec, bal, non, own, decoys = 3) {
  for (let k = 0; k < Number(rndBelow(BigInt(decoys + 1))); k++) tree.insert(rndField());
  const idx = tree.insert(commit(sec, bal, non, own));
  for (let k = 0; k < Number(rndBelow(3n)); k++) tree.insert(rndField());
  return idx;
}
function spendPart(tree, sec, bal, non, own) {
  const idx = noteInTree(tree, sec, bal, non, own);
  const { sib, bits } = tree.path(idx);
  return { merkle_path: sib, merkle_path_indices: bits, merkle_root: tree.root() };
}
const pick = (arr) => arr[Number(rndBelow(BigInt(arr.length)))];
const addr = () => rnd() << 96n | rnd() >> 32n;       // 160-bit-ish address as field element

const cases = {
  deposit(k) {
    const secret = rndField(), owner = addr();
    const amount = k === 0 ? 0n : k === 1 ? U64 : rndBelow(50_000_000_000n);
    return { secret, commitment: commit(secret, amount, 0n, owner), amount, owner_address: owner };
  },
  bet_auth(k) {
    const secret = rndField(), owner = addr(), tree = new Tree();
    const fee = k === 0 ? 0n : rndBelow(1_000_000n);
    let bet = 1_000_000n + rndBelow(40_000_000n);
    let cb = bet + fee + (k === 1 ? 0n : rndBelow(100_000_000n));                       // k=1: spend whole balance
    let price = pick([1n, 3n, 7n, 25_000_000n, 50_000_000n, 99_999_999n, 100_000_000n, 150_000_000n]);
    if (k === 2) { bet = 1n; cb = 1n + fee; price = 100_000_000n; }
    if (k === 3) { bet = 3n; price = 7n; cb = 3n + fee; }                                // remainder != 0
    const nonce = k === 4 ? 0n : k === 5 ? U64 - 2n : rndBelow(1000n);
    const scaled = bet * 100_000_000n;
    const expected_shares = scaled / price, share_remainder = scaled % price;
    if (expected_shares > U64) return null;
    const sp = spendPart(tree, secret, cb, nonce, owner);
    return { secret, current_balance: cb, nonce, ...sp, share_remainder, owner_address: owner,
      nullifier: nullifier(secret, nonce), new_commitment: commit(secret, cb - bet - fee, nonce + 1n, owner),
      bet_amount: bet, price, expected_shares, market_id: rndField(), outcome_side: k === 6 ? 255n : rndBelow(2n),
      position_id: rndField(), fee };
  },
  withdrawal(k) {
    const secret = rndField(), owner = addr(), tree = new Tree();
    const fb = k === 0 ? 0n : rndBelow(50_000_000_000n) + 1n;
    const wa = k === 0 ? 0n : k === 1 ? fb : k === 2 ? 0n : rndBelow(fb + 1n);          // full / zero / partial
    const nonce = k === 3 ? U64 - 2n : rndBelow(500n);
    const sp = spendPart(tree, secret, fb, nonce, owner);
    return { secret, final_balance: fb, nonce, merkle_path: sp.merkle_path, merkle_path_indices: sp.merkle_path_indices,
      owner_address: owner, recipient_address: owner, merkle_root: sp.merkle_root, nullifier: nullifier(secret, nonce),
      withdrawal_amount: wa, recipient_hash: H(owner, 0n),
      new_commitment: wa < fb ? commit(secret, fb - wa, nonce + 1n, owner) : 0n };
  },
};

function credit(extraName, withMarket, balName) {
  return (k) => {
    const secret = rndField(), owner = addr(), tree = new Tree();
    const bal = k === 0 ? 0n : rndBelow(50_000_000_000n);
    const amt = k === 1 ? 0n : k === 2 ? U64 - bal : rndBelow(10_000_000_000n);
    const nonce = 1n + rndBelow(k === 3 ? U64 - 3n : 500n);
    const bet_nonce = k === 4 ? 0n : rndBelow(nonce);
    const sp = spendPart(tree, secret, bal, nonce, owner);
    const o = { secret, [balName]: bal, nonce, bet_nonce, ...sp, owner_address: owner,
      nullifier: nullifier(secret, nonce), new_commitment: commit(secret, bal + amt, nonce + 1n, owner),
      nullifier_of_bet: nullifier(secret, bet_nonce), [extraName]: amt };
    if (withMarket) o.market_id = rndField();
    return o;
  };
}
cases.settlement_credit = credit("total_credit", true, "balance_before_credit");
cases.bet_cancel = credit("bet_amount", false, "current_balance");
cases.cancel_credit = credit("bet_amount", true, "current_balance");
cases.position_close = credit("sell_proceeds", false, "balance_before_credit");
cases.partial_credit = credit("refund_amount", false, "current_balance");

// circuits as DEPLOYED (commit e66b43c): bet bound by nullifier_of_bet = H2(secret, nonce-1), no private bet_nonce
function creditLive(extraName, withMarket, balName) {
  return (k) => {
    const secret = rndField(), owner = addr(), tree = new Tree();
    const bal = k === 0 ? 0n : rndBelow(50_000_000_000n);
    const amt = k === 1 ? 0n : k === 2 ? U64 - bal : rndBelow(10_000_000_000n);
    const nonce = 1n + rndBelow(k === 3 ? U64 - 3n : 500n);
    const sp = spendPart(tree, secret, bal, nonce, owner);
    const o = { secret, [balName]: bal, nonce, ...sp, owner_address: owner,
      nullifier: nullifier(secret, nonce), new_commitment: commit(secret, bal + amt, nonce + 1n, owner),
      nullifier_of_bet: nullifier(secret, nonce - 1n), [extraName]: amt };
    if (withMarket) o.market_id = rndField();
    return o;
  };
}
cases.bet_cancel_live = creditLive("bet_amount", false, "current_balance");
cases.cancel_credit_live = creditLive("bet_amount", true, "current_balance");
cases.partial_credit_live = creditLive("refund_amount", false, "current_balance");

cases.consolidate = (k) => {
  const K = 4, owner = addr(), tree = new Tree();
  const act = k === 0 ? [1, 0, 0, 0] : k === 1 ? [1, 1, 1, 1] : [1, ...[1, 2, 3].map(() => Number(rndBelow(2n)))];
  const secret = [], balance = [], nonce = [], idx = [];
  for (let j = 0; j < K; j++) {
    secret.push(rndField());
    balance.push(k === 2 ? U64 / 4n : rndBelow(10_000_000_000n));
    nonce.push(rndBelow(100n));
    idx.push(act[j] ? noteInTree(tree, secret[j], balance[j], nonce[j], owner, 1) : -1);
  }
  const root = tree.root();
  const mp = [], mpi = [], nul = [];
  let sum = 0n;
  for (let j = 0; j < K; j++) {
    if (act[j]) { const p = tree.path(idx[j]); mp.push(p.sib); mpi.push(p.bits); nul.push(nullifier(secret[j], nonce[j])); sum += balance[j]; }
    else { mp.push(Array(DEPTH).fill(0n)); mpi.push(Array(DEPTH).fill(0n)); nul.push(0n); }
  }
  return { secret, balance, nonce, merkle_path: mp, merkle_path_indices: mpi, is_active: act, owner_address: owner,
    merkle_root: root, nullifier: nul, new_commitment: commit(secret[0], sum, nonce[0] + 1n, owner) };
};

let total = 0;
for (const [name, fn] of Object.entries(cases)) {
  let made = 0;
  for (let k = 0; made < N && k < N * 4; k++) {
    const c = fn(k);
    if (!c) continue;
    fs.writeFileSync(path.join(outDir, `${name}__${made}.json`), JSON.stringify(Object.fromEntries(Object.entries(c).map(([a, b]) => [a, str(b)]))));
    made++; total++;
  }
}
console.log(`wrote ${total} cases to ${outDir}`);
