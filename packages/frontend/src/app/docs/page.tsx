'use client'
import { useState } from 'react'

const SECTIONS: Record<string, { title: string; content: string }[]> = {
  'Getting started': [
    {
      title: 'Overview',
      content: `Polyshield is a ZK-based privacy vault for Polymarket. Depositors fund a shared vault, then authorize bets via ZK proofs. All bets appear on-chain as coming from the vault's single Polymarket EOA. No depositor address ever appears in a Polymarket transaction.

**What Polyshield hides:** which depositor authorized which bet.
**What Polyshield does NOT hide:** that a wallet deposited into the vault (the deposit transaction is public).`,
    },
    {
      title: 'Quickstart',
      content: `1. Connect your EVM wallet (Polygon mainnet)
2. Deposit USDC into the vault — the Vault contract records a Poseidon commitment
3. Your browser generates a spending note \`(secret, balance, nonce)\` locally
4. **Save your note** — Polyshield cannot recover it. Use the encrypted backup.
5. Browse markets and authorize bets via ZK proof
6. Collect winnings via settlement credit proofs
7. Withdraw to any address via the withdrawal relay`,
    },
  ],
  'Architecture': [
    {
      title: 'Vault contract',
      content: `The Vault.sol contract (Polygon) is the trust anchor. It:
- Maintains an append-only Poseidon Merkle tree (depth 32) of note commitments
- Stores a NullifierRegistry mapping to prevent double-spend
- Verifies 5 types of ZK proofs: BET_AUTH, SETTLE_CRED, WITHDRAW, BET_CANCEL, CANCEL_CRED
- Enforces a $50,000 per-address cumulative deposit cap in MVP

The Vault accepts the last 30 Merkle roots (not just the current one) to allow for proof generation latency.`,
    },
    {
      title: 'Note structure',
      content: `A spending note has three fields:
\`\`\`
secret: Field    // 256-bit entropy from crypto.getRandomValues()
balance: u64     // USDC balance in micro-units (6 decimals)
nonce: u64       // Increments on each spend
\`\`\`

The commitment stored on-chain: \`C = poseidon3(secret, balance, nonce)\`
The nullifier (public, computed once per spend): \`N = poseidon2(secret, nonce)\`

The secret never leaves the browser.`,
    },
    {
      title: 'ZK circuits',
      content: `Five Noir circuits implement the proof system:

**BET_AUTH** — Proves note has sufficient balance for the bet, computes nullifier, produces new note commitment after spend.

**SETTLE_CRED** — Proves you held a winning position; produces a new note with the payout added to balance.

**WITHDRAW** — Proves knowledge of note secrets; commits to recipient address via poseidon2(address, 0).

**BET_CANCEL** — Cancels a failed FOK bet and restores the spent note balance.

**CANCEL_CRED** — Handles N/A market resolutions (all-zero CTF payout numerators).

Circuits use Noir's \`poseidon2\` and \`poseidon3\` from the stdlib (BN254 field, same constants as @zk-kit/poseidon-solidity).`,
    },
    {
      title: 'Signing layer',
      content: `The Signing Layer is a Node.js service that:
1. Listens for \`BetAuthorized\` events from the Vault (after 1 block confirmation)
2. Reads bet parameters from the event (market_id, position_id, expected_shares, price)
3. Submits a Fill-Or-Kill order to Polymarket's CLOB API using the vault EOA
4. On FOK failure: calls \`Vault.reportFOKFailure()\` to enable cancellation credit

**v1:** Centralized operator. **v2 (planned):** AWS Nitro Enclave with remote attestation.`,
    },
    {
      title: 'Proof relay',
      content: `The Proof Relay is a stateless Express service with 5 POST endpoints:
- \`POST /relay/bet\` → \`Vault.authorizeBet()\`
- \`POST /relay/settlement\` → \`Vault.creditSettlement()\`
- \`POST /relay/withdrawal\` → \`Vault.withdraw()\`
- \`POST /relay/bet-cancel\` → \`Vault.betCancellationCredit()\`
- \`POST /relay/na-cancel\` → \`Vault.naCancellationCredit()\`

The relay's own EOA pays gas. Your wallet only ever signs \`Vault.deposit()\`. Source IP is never logged.`,
    },
  ],
  'Security': [
    {
      title: 'Threat model',
      content: `Polyshield protects against a network observer with full on-chain visibility who is trying to link a depositor address to a specific Polymarket bet.

**Mitigated threats:**
- Observer identifies which wallet placed a CLOB order (vault EOA is shared across all depositors)
- Observer links a nullifier to a depositor address (nullifier = poseidon(secret, nonce); not derivable without secret)
- Relay operator learns which depositor authorized which bet (relay only sees ZK proof public inputs; no depositor ID is present)

**Not mitigated:**
- That a wallet used Polyshield (deposit is public)
- Deposit amount (ERC-20 transfer amount is on-chain)

Full threat model: \`docs/threat-model.md\` in the repository.`,
    },
    {
      title: 'Note backup',
      content: `Your note is the only credential that lets you spend from your vault position. If you lose it, your funds are unrecoverable.

**Backup options:**
1. Download the encrypted backup file (note encrypted with your wallet's public key)
2. Write the hex-encoded secret to paper and store offline
3. Use a hardware wallet that supports EIP-1024 encryption

Polyshield stores nothing server-side. There is no account recovery.`,
    },
  ],
  'API reference': [
    {
      title: 'Indexer REST API',
      content: `The Polymarket Indexer exposes settlement data for proof generation.

\`GET /settlement/:market_id\`
Returns:
\`\`\`json
{
  "conditionId": "0x...",
  "positionId": "0x...",
  "payout_per_share": 1000000,
  "block_number": 21448072,
  "outcome": 1
}
\`\`\`

\`GET /health\` → 200 OK`,
    },
    {
      title: 'Proof relay API',
      content: `All relay endpoints accept a JSON body with \`proof\` (hex-encoded bytes) and \`inputs\` (proof-type-specific public inputs). Returns \`{ txHash: "0x..." }\` on success.

\`POST /relay/bet\` — \`{ proof, inputs: BetAuthInputs }\`
\`POST /relay/settlement\` — \`{ proof, inputs: SettlementInputs }\`
\`POST /relay/withdrawal\` — \`{ proof, inputs: WithdrawalInputs, recipientAddress }\`
\`POST /relay/bet-cancel\` — \`{ proof, inputs: BetCancelInputs }\`
\`POST /relay/na-cancel\` — \`{ proof, inputs: NACancelInputs }\``,
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
            {SECTIONS[sec].map(({ title }) => (
              <div key={title} onClick={() => { setSection(sec); setPage(title) }}
                style={{ padding: '6px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 13, color: page === title && section === sec ? 'var(--cyan)' : 'var(--text-2)', background: page === title && section === sec ? 'oklch(0.82 0.13 210 / 0.08)' : 'transparent' }}>
                {title}
              </div>
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
