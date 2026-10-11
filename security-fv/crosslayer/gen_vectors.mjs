// Poseidon / Merkle test vectors from circomlibjs (the reference the circuits are checked against in witness/differential.py).
// usage: node crosslayer/gen_vectors.mjs <out.json>
import fs from "fs";
import { buildPoseidon } from "circomlibjs";
const poseidon = await buildPoseidon();
const H = (...xs) => poseidon.F.toObject(poseidon(xs.map(BigInt)));
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
let s = 0x2545f4914f6cdd1dn;
const rnd = () => { s ^= s << 13n; s &= (1n << 64n) - 1n; s ^= s >> 7n; s ^= s << 17n; s &= (1n << 64n) - 1n; return s; };
const field = () => ((rnd() << 192n) | (rnd() << 128n) | (rnd() << 64n) | rnd()) % R;
const hex = (x) => "0x" + x.toString(16).padStart(64, "0");

const pairs = [[0n, 0n], [1n, 2n], [R - 1n, R - 1n], [0n, R - 1n], [R - 1n, 0n], [123456789n, 0n]];
for (let i = 0; i < 24; i++) pairs.push([field(), field()]);
const hash2 = pairs.map(([a, b]) => ({ a: hex(a), b: hex(b), out: hex(H(a, b)) }));

// recipient hash vectors: H2(address, 0) exactly as RecipientHash() / Vault.withdraw
const addrs = [0xb68cE80bB9ad1Dbbd0E8c6C9eFB982763b765F48n, 1n, (1n << 160n) - 1n, rnd() << 96n | rnd() >> 32n];
const recipient = addrs.map((a) => ({ addr: hex(a), out: hex(H(a, 0n)) }));

// Merkle tree identical to CommitmentMerkleTree.sol (depth 32, zero leaf 0)
const DEPTH = 32;
const zeros = [0n];
for (let i = 1; i <= DEPTH; i++) zeros.push(H(zeros[i - 1], zeros[i - 1]));
const nodes = new Map();
const get = (l, i) => nodes.get(`${l}:${i}`) ?? zeros[l];
const leaves = [], roots = [];
for (let k = 0; k < 20; k++) {
  const leaf = field(); leaves.push(leaf);
  nodes.set(`0:${k}`, leaf);
  let i = k;
  for (let l = 0; l < DEPTH; l++) { const L = get(l, i & ~1), Rr = get(l, i | 1); i >>= 1; nodes.set(`${l + 1}:${i}`, H(L, Rr)); }
  roots.push(get(DEPTH, 0));
}
const paths = leaves.map((_, k) => { const sib = [], bits = []; let i = k; for (let l = 0; l < DEPTH; l++) { sib.push(hex(get(l, i ^ 1))); bits.push(i & 1); i >>= 1; } return { sib, bits }; });
fs.writeFileSync(process.argv[2], JSON.stringify({
  hash2, recipient, zeros: zeros.slice(0, DEPTH).map(hex), leaves: leaves.map(hex), roots: roots.map(hex), paths,
}, null, 1));
console.log("vectors:", hash2.length, "hash2,", recipient.length, "recipient,", leaves.length, "leaves");
