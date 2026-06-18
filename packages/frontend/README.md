# packages/frontend

The Polyshield dApp — [Next.js](https://nextjs.org/) (App Router) + [Wagmi](https://wagmi.sh/) /
ConnectKit. This is where **all** ZK proofs are generated (client-side WASM) and where the only
user-signed on-chain transaction (`deposit()`) originates.

> **Privacy invariant:** the note secret and the wallet↔bet link live only in the browser. Never
> send proof witness data (secret, balance, nonce, owner_address) to any API. Never generate proofs
> server-side. Never call a state-mutating Vault function (`authorizeBet`, `creditSettlement`, …)
> from the user's connected wallet — that re-links the depositor on-chain (threat T19). The only tx
> the user's wallet ever sends is `Vault.deposit()`. See [`../../CLAUDE.md`](../../CLAUDE.md).

---

## Layout

```
src/
  app/                 Next.js App Router
    page.tsx           Landing
    app/               The dApp: deposit · bet · market(s) · portfolio · settle · withdraw ·
                       vault · proofs · settings · privacy  (markets use live Gamma data via the
                       proof-relay catalog, FC-15)
    explorer/          On-chain activity explorer — served at its own subdomain in production
                       (explorer.<domain>; middleware rewrites the subdomain root → /explorer)
    how/  docs/  roadmap/
    api/               Server-side proxy routes (relay/*, signing/*, markets/*, market-name/*) —
                       inject the operator bearer token; the user wallet is never tx.from
  components/          UI
  lib/
    notes.ts           Note primitives: Poseidon4 commitment, Poseidon2 nullifier, secret derivation
    secretSession.ts   FC-13 V2 master-seed derivation (one signature/session; in-memory only)
    cacheStore.ts      Encrypted IndexedDB note cache (AES-GCM, non-extractable key)
    useNotesHydration.ts  Hydrates the in-memory working set on app start
    prover.ts          snarkjs Groth16 proof generation (driven by workers/prover.worker.ts)
    consolidate.ts  finalizePartial.ts  pricing.ts  orderType.ts   spend-flow helpers
    api.ts             Calls the server-side proxy routes
    config.ts  wagmi.ts  rpc.ts  vaultAbi.ts  polymarket.ts  marketsData.ts
  workers/             Web Worker that runs the WASM prover off the main thread
  middleware.ts        Same-origin guard on /api
```

ZK assets are served from `public/circuits/*.wasm` and `public/zkeys/*.zkey` (gitignored — large
binaries; generate with `pnpm circuits:all` from the repo root, which copies them here).

---

## Run

```bash
# From the repo root, with the backend stack already running (pnpm dev:mock):
pnpm dev:frontend            # → http://localhost:3000

# Or directly:
cd packages/frontend
pnpm dev                     # Next.js dev server (webpack — NOT --turbopack, see below)
pnpm build                   # production build + type check
pnpm lint
pnpm test                    # vitest
```

> **Do not use `next dev --turbopack`** — it deadlocks on the prover module's Web Worker. Stay on
> webpack. The slow first compile is expected, not a bug.

---

## Note management & recovery

- **P3+ (current):** secrets are wallet-derived. New deposits use FC-13 **V2** — one master-seed
  signature per session derives every note secret locally (`getNoteSecret(..., 2)`), held in memory
  only, never persisted. Legacy **V1** (one signature per index) is still honored for pre-FC-13
  notes. Both message strings are **frozen protocol constants** — never change them.
- The note cache (balances/commitments/linkage, **never the secret**) is persisted **encrypted in
  IndexedDB**. Note-reading screens are gated on hydration.
- Recovery: `recoverNotes(wallet)` — one master-seed signature maps each `Deposited` commitment to
  its index and replays on-chain events (served by the proof-relay `/recovery-data` index, so the
  browser never re-scans the chain).
- Users never back up a secret in P3+ — their wallet is their backup. Never use
  `crypto.getRandomValues()` for note secrets.

---

## Proof generation

Proofs run entirely in the browser via WASM (snarkjs Groth16). Expect **30 s – 2 min** per proof
depending on device; show the progress indicator and prevent navigation during proving. On failure,
surface a clear "try on a more powerful device" message.
