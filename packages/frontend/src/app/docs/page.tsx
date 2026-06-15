'use client'
import { useState } from 'react'

const SECTIONS: Record<string, { title: string; content: string }[]> = {
  'Getting started': [
    {
      title: 'Overview',
      content: `PolyShield is a ZK-based privacy vault for Polymarket, live on Polygon mainnet. Depositors fund a shared vault, then authorize bets via zero-knowledge proofs. All bets appear on-chain as coming from the vault's single Polymarket EOA, so no depositor address ever appears in a Polymarket transaction.

**What PolyShield hides:** which depositor authorized which bet.
**What PolyShield does NOT hide:** that a wallet deposited into the vault — the deposit transaction is public by design.

Every privacy-sensitive operation (note generation, proof generation) happens in your browser. No secret ever leaves your device, and no backend service can link a bet to a depositor.`,
    },
    {
      title: 'Quickstart',
      content: `1. Connect your EVM wallet (Polygon mainnet)
2. Deposit USDC into the vault — your browser generates a spending note locally and submits a mandatory deposit-binding ZK proof that ties the committed balance to the amount you actually transferred
3. The note \`(secret, balance, nonce, owner_address)\` lives only in your browser; the secret is derived from a wallet signature, so there is nothing to back up
4. Browse live Polymarket markets and authorize a bet via a BET_AUTH proof — the proof relay submits it, never your wallet
5. When a market resolves, claim your winnings with a one-click settlement-credit proof — the payout becomes a fresh private note
6. Withdraw to your own address via a withdrawal proof (wallet-to-wallet only)

On a new device, click "Recover notes" — the app rebuilds your note set from the backend index + your wallet signature, with no chain scan.`,
    },
  ],
  'Architecture': [
    {
      title: 'System overview',
      content: `Four layers, each with a distinct trust role:

**On-chain (Polygon):** the Vault (UUPS proxy) plus its CommitmentMerkleTree, NullifierRegistry, and 9 Groth16 verifier adapters. The source of truth; trustless except the owner's upgrade key.

**Frontend (your browser):** holds the wallet-derived secret, generates all proofs (snarkjs WASM). The only party that can link a wallet to a note.

**Proof relay:** submits your proofs to the Vault and pays gas, so your wallet is never \`tx.from\` on a bet. It is ALSO the backend index/cache (serves merkle paths, recovery data, and explorer events). Stateless w.r.t. trust — it cannot forge proofs or de-anonymize.

**Signing layer:** holds the vault EOA key, listens for BetAuthorized events, places CLOB orders, resolves settled markets, and funds collateral just-in-time. Centralized in v1, AWS Nitro TEE in v2.`,
    },
    {
      title: 'Vault contract',
      content: `The Vault.sol contract (Polygon mainnet, UUPS upgradeable behind an ERC-1967 proxy) is the trust anchor. It:
- Maintains an append-only Poseidon Merkle tree (depth 32) of note commitments
- Stores a NullifierRegistry mapping to prevent double-spend (checks-effects-interactions)
- Verifies 9 ZK proof types: DEPOSIT, BET_AUTH, SETTLEMENT_CREDIT, WITHDRAWAL, BET_CANCEL, CANCEL_CREDIT, POSITION_CLOSE, PARTIAL_CREDIT, CONSOLIDATE
- Derives settlement payouts on-chain from the real Gnosis CTF and injects them into proofs (users never supply payout values)
- Enforces a $50,000 per-address cumulative deposit cap in MVP
- Holds a governance-mutable fee config (bet fee, withdrawal fee, relay-gas reimbursement)

The Vault accepts a rolling window of the last 1024 Merkle roots (O(1) membership), so a proof generated a few blocks ago still verifies. To stay under the 24 KB contract-size limit, bulky logic lives in two delegatecall libraries (VaultInputs, VaultLogic).`,
    },
    {
      title: 'Note structure',
      content: `A spending note has four fields:
secret — derived from a wallet signature, never random, never stored
balance — USDC balance in micro-units (6 decimals)
nonce — increments on each spend
owner_address — depositing wallet address cast to a BN254 field

The commitment stored on-chain: \`C = Poseidon4(secret, balance, nonce, owner_address)\`
The nullifier (public, revealed once per spend): \`N = Poseidon2(secret, nonce)\`

The secret is re-derived from your wallet signature on demand. The nullifier does not include balance or owner, so it cannot be correlated to a deposit amount or address.`,
    },
    {
      title: 'ZK circuits',
      content: `Nine Circom circuits, compiled to WASM + Groth16 (snarkjs, BN254). Proofs are generated client-side in the browser and verified on-chain by snarkjs-generated verifier adapters. (Noir \`.nr\` files in the repo are a specification reference only — they are not compiled.)

**DEPOSIT** — Binds the committed balance and owner to the deposited amount and msg.sender. Mandatory: without it a depositor could commit more than they paid.

**BET_AUTH** — Proves the note has enough balance, computes the nullifier, and produces the new note after spending \`bet_amount + fee\` (the fee is Vault-injected).

**SETTLEMENT_CREDIT** — Proves you held a winning position; the Vault injects payout-per-share and shares-held, so you cannot inflate the credit.

**WITHDRAWAL** — Proves knowledge of the note secret and commits to the recipient via \`Poseidon2(address, 0)\`; enforces withdraw-to-self.

**BET_CANCEL / CANCEL_CREDIT** — Refund a failed/cancelled bet, or an N/A market resolution (all CTF payout numerators zero).

**POSITION_CLOSE** — Credit from selling a position before settlement (proceeds from a signed operator attestation).

**PARTIAL_CREDIT** — Refund the unfilled remainder of a partially-filled limit order.

**CONSOLIDATE** — Merge up to 4 same-owner notes into one.`,
    },
    {
      title: 'Signing layer',
      content: `The Signing Layer is a Node.js service holding the vault EOA key. It:
1. Listens for \`BetAuthorized\` events (via a windowed, cursor-persisted log scan) and resolves the real Polymarket tokenId/conditionId from a market registry
2. Funds the Polymarket deposit wallet just-in-time (JIT collateral) right before the order
3. Submits the order to the live CLOB — FAK for market orders, GTC/GTD for resting limit orders
4. Tracks fills over a websocket and signs a single EIP-712 operator attestation per bet (FILLED / FAILED / PARTIAL / SOLD), which the user submits with their credit proof — the operator no longer pushes status on-chain
5. Detects market resolution (a tracked-markets poll + filtered CTF event) and calls \`resolveMarket\`, then best-effort redeems the collateral

A dead-man circuit breaker halts all signing on a Polymarket ban (403 / account-flagged). **v1:** centralized operator. **v2:** AWS Nitro Enclave with remote attestation.`,
    },
    {
      title: 'Proof relay & backend index',
      content: `The Proof Relay is a stateless service with two roles.

**1. Relay** — accepts a proof + public inputs and submits the matching Vault call from its own EOA, paying gas. Your wallet only ever signs \`Vault.deposit()\`. It cannot forge proofs. Endpoints cover every spend path: bet, settlement, withdrawal, bet-cancel, na-cancel, partial-fill, position-close, consolidate, deposit.

**2. Backend index/cache (FC-12)** — mirrors the public on-chain state into SQLite so clients never re-scan the chain:
- \`GET /merkle-path/:commitment\` — the merkle path for a proof, O(32) lookup, zero chain calls (CachedMerkleTree)
- \`GET /recovery-data/:depositor\` — your deposits + all anonymous spend events for note recovery (VaultEventIndex)
- \`GET /events\` — all indexed events for the public explorer

Privacy is preserved: the index stores only public, anonymous data. It cannot link a spend to a wallet (no secret server-side) and cannot forge notes (your client matches events by your own derived nullifier).`,
    },
  ],
  'Security': [
    {
      title: 'Threat model',
      content: `PolyShield protects against a network observer with full on-chain visibility who is trying to link a depositor address to a specific Polymarket bet.

**Mitigated:**
- Observer identifies which wallet placed a CLOB order — all orders come from the vault's single shared EOA
- Observer links a nullifier to a depositor — nullifier = Poseidon2(secret, nonce), not derivable without the secret
- Relay or signing layer learns who authorized a bet — they only see ZK proofs and public inputs; no depositor ID is present
- Forged deposit balance, double-spend, fee under-payment, forged attestation, double/inflated credit, redirected withdrawal — all blocked on-chain regardless of who sends the transaction
- Malicious backend index — serves only public data; worst case is incomplete recovery, never theft or de-anonymization

**Not mitigated (by design):**
- That a wallet used PolyShield (the deposit is public)
- The deposit amount (ERC-20 transfer amount is on-chain)
- Calling a spend function from your OWN wallet self-deanonymizes (the frontend never does this; it is a client discipline)

**Largest trust assumption:** the contracts are instantly upgradeable by the owner key (UUPS, no timelock), so that key must be a multisig/HSM in production. Full detail: \`docs/threat-model.md\`.`,
    },
    {
      title: 'Note backup & recovery',
      content: `Your note secret is derived deterministically from your wallet signature, so there is nothing to back up.

**Recovery:** on a new device or after clearing storage, click "Recover notes". The app fetches your public events from the backend index (\`/recovery-data\`, no chain scan), re-derives your secrets by index, and keeps only the events whose nullifier matches your own — rebuilding your full note set, including credit notes.

**What you must preserve:** your wallet. As long as you control the depositing wallet, your position is recoverable. Lose the wallet and the position is unrecoverable — there is no admin override.

**Withdrawal restriction:** you can only withdraw to the wallet that made the original deposit, enforced inside the withdrawal circuit via the \`owner_address\` field and re-checked by the Vault.`,
    },
    {
      title: 'Fees',
      content: `All fee rates live in one governance-mutable Vault config and accrue in the pool, claimable by the fee recipient. Three fees:

**Bet fee + relay gas** — \`bet_amount * betFeeBps / 10000 + relayGasFeeUSDC\`, computed by the Vault and injected into the BET_AUTH proof. Because the Vault (not the user) supplies the fee, a forged proof with any other fee fails verification. The gas reimbursement is charged in USDC from the note, never as a native transfer (which would re-link wallet to bet).

**Withdrawal fee** — a flat USDC amount skimmed from the payout by \`withdraw()\` directly (no circuit change needed, because the Vault controls the USDC).

Current defaults: bet fee 0.2%, withdrawal fee $0.10, min bet $1, min withdrawal $1.`,
    },
  ],
}

const NAV = Object.keys(SECTIONS)

export default function DocsPage() {
  const [section, setSection] = useState(NAV[0])
  const [page, setPage] = useState(SECTIONS[NAV[0]][0].title)

  const currentSection = SECTIONS[section]
  const currentPage = currentSection.find((p) => p.title === page) ?? currentSection[0]

  function formatContent(text: string) {
    return text.split('\n').map((line, i) => {
      if (line.startsWith('**') && line.endsWith('**')) {
        return <div key={i} style={{ fontWeight: 600, marginTop: 12, marginBottom: 4 }}>{line.slice(2, -2)}</div>
      }
      if (line.startsWith('**')) {
        const parts = line.split('**')
        return <p key={i} style={{ margin: '4px 0', fontSize: 13 }}>{parts.map((p, j) => j % 2 === 1 ? <strong key={j}>{p}</strong> : p)}</p>
      }
      if (line.startsWith('```')) return null
      if (line.startsWith('- ') || line.match(/^\d+\./)) {
        return <div key={i} className="row gap-2" style={{ margin: '3px 0', paddingLeft: 8 }}>
          <span style={{ color: 'var(--cyan)', fontSize: 12 }}>·</span>
          <span style={{ fontSize: 13 }}>{line.replace(/^[-\d.]+\s/, '')}</span>
        </div>
      }
      if (line.startsWith('`') && line.endsWith('`') && !line.includes('\n')) {
        return <code key={i} className="mono" style={{ fontSize: 12, background: 'var(--bg-1)', padding: '1px 6px', borderRadius: 4 }}>{line.slice(1, -1)}</code>
      }
      if (!line.trim()) return <div key={i} style={{ height: 8 }} />
      return <p key={i} style={{ margin: '4px 0', fontSize: 13, lineHeight: 1.6 }}>{line}</p>
    })
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '0 24px 80px', display: 'grid', gridTemplateColumns: '200px 1fr', gap: 40, paddingTop: 40 }}>
      {/* Sidebar */}
      <div>
        <div className="micro" style={{ marginBottom: 12 }}>DOCS</div>
        {NAV.map((sec) => (
          <div key={sec} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>{sec}</div>
            {/* FINDING: A11Y-004 — real <button> instead of a clickable <div>, so
                it is keyboard-focusable and Enter/Space activate it. Styled flat
                to preserve the original look. */}
            {SECTIONS[sec].map(({ title }) => (
              <button key={title} type="button" onClick={() => { setSection(sec); setPage(title) }}
                style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer', padding: '6px 10px', borderRadius: 5, fontSize: 13, fontFamily: 'inherit', color: page === title && section === sec ? 'var(--cyan)' : 'var(--text-2)', background: page === title && section === sec ? 'oklch(0.82 0.13 210 / 0.08)' : 'transparent' }}>
                {title}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Content */}
      <div>
        <div className="micro" style={{ color: 'var(--text-2)', marginBottom: 8 }}>{section.toUpperCase()}</div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, marginBottom: 20 }}>{currentPage.title}</h1>
        <div className="panel" style={{ padding: 24 }}>
          {formatContent(currentPage.content)}
        </div>
      </div>
    </div>
  )
}
