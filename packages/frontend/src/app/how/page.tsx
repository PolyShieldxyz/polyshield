import type { Metadata } from 'next'
import Link from 'next/link'

// SEO: unique, keyword-led metadata for the /how route + self-canonical.
export const metadata: Metadata = {
  title: 'How It Works — Private Polymarket trading with ZK proofs',
  description:
    'How PolyShield makes Polymarket trading private: deposit USDC, prove bets in your browser with zero-knowledge proofs, and trade from a shared anonymity set. Plus answers to common questions.',
  alternates: { canonical: '/how' },
}

// SEO/AEO: FAQ content. Each answer is a single plain string so the visible copy
// and the FAQPage JSON-LD below stay byte-identical (a Google rich-result
// requirement). Claim-safe: PolyShield protects which depositor authorized which
// bet — not that a wallet used the vault (deposits are public by design).
type QA = { q: string; a: string }
const FAQS: QA[] = [
  {
    q: 'What is PolyShield?',
    a: 'PolyShield is a non-custodial, zero-knowledge privacy vault for Polymarket. Many users deposit USDC into one shared vault that holds a single Polymarket account. Every bet is placed from that one shared account, so on-chain observers cannot tell which depositor authorized which trade. It is live on Polygon mainnet in an open beta.',
  },
  {
    q: 'What does PolyShield hide, and what stays public?',
    a: 'Hidden: which depositor authorized which bet, and your running position — this is enforced by cryptography, not a promise. Public: that some wallet deposited into the vault and how much, because a deposit is an ordinary on-chain USDC transfer. PolyShield hides your trading activity, not the fact that you deposited.',
  },
  {
    q: 'Is PolyShield a mixer?',
    a: 'No. A mixer breaks the link between a sender and an arbitrary recipient. PolyShield is withdraw-to-self only: your funds can only return to the same wallet that deposited them, enforced inside the zero-knowledge circuit and re-checked on-chain. It hides which bets are yours, not where your money goes.',
  },
  {
    q: 'Is PolyShield non-custodial? Can it take my funds?',
    a: 'PolyShield is non-custodial and cannot move your balance to anyone but you — withdraw-to-self is enforced by the circuit and the contract. The main trust assumption is the contract upgrade key, which can replace contract logic; in production that key is held by a multisig or HSM. PolyShield is experimental beta software handling real funds, so only deposit what you can afford to risk.',
  },
  {
    q: 'Do I need KYC to use PolyShield?',
    a: 'No. PolyShield is a permissionless smart-contract protocol — you connect a self-custodial EVM wallet on Polygon and deposit USDC. There is no account, no email, and no identity verification.',
  },
  {
    q: 'How do I get my money out? Can I withdraw to any wallet?',
    a: 'You can only withdraw to the same wallet that made the deposit. This is enforced cryptographically: the recipient is bound inside the withdrawal proof and independently re-checked by the vault. There is no way to redirect a withdrawal to a third-party address.',
  },
  {
    q: 'Is there a deposit limit?',
    a: 'Yes. During the beta there is a $50,000 USDC maximum cumulative deposit per address, enforced on-chain. Minimum bet and withdrawal amounts are $1.',
  },
  {
    q: 'How long does it take to place a private bet?',
    a: 'Each action generates a zero-knowledge proof locally in your browser using WebAssembly, which typically takes 30 seconds to about 2 minutes depending on your device. Keep the tab open while it runs — proving is CPU-bound and happens entirely on your device; no secret is ever sent to a server.',
  },
  {
    q: 'What are the fees?',
    a: 'PolyShield charges a 0.3% fee on each bet plus a small flat relay reimbursement (about $0.15 in USDC), and a flat $1 fee (in USDC) on each withdrawal. Fees accumulate in the vault. The relay reimbursement covers Polygon network costs — it is taken in USDC from your note, so PolyShield never asks your wallet to pay gas for a bet directly; the relay submits it.',
  },
  {
    q: 'Does the operator or relay see my bets?',
    a: 'No. The relay and signing layer only ever see zero-knowledge proofs and public inputs, which contain no depositor identity. The one opt-in exception is auto-settlement, where you may hand the operator an encrypted blob so it can settle a single bet for you — that links you to that one bet at the operator level and nothing more.',
  },
  {
    q: 'What happens if I lose my device or clear my browser?',
    a: 'Your notes are recoverable from your wallet alone. Note secrets are derived deterministically from wallet signatures, so signing once on a new device reconstructs every note. The only unrecoverable loss is losing the depositing wallet itself — there is no admin override or server-side recovery.',
  },
  {
    q: 'What network and token does PolyShield use?',
    a: 'PolyShield runs on Polygon mainnet, the same chain as Polymarket, and accepts and pays out in USDC only. All conversion between USDC and Polymarket collateral is handled internally by the vault.',
  },
]

/* ── Palette — references the globals.css :root tokens directly (SVG fill/stroke
   resolve CSS custom properties), so the diagrams never drift from the design
   system. --blue has no token (a one-off wallet accent), so it stays a literal. */
const C = {
  node: 'var(--bg-1)',
  line: 'var(--line-strong)',
  lineSoft: 'var(--line)',
  text: 'var(--text)',
  text2: 'var(--text-2)',
  cyan: 'var(--accent)',
  violet: 'var(--brand)',
  green: 'var(--green)',
  red: 'var(--red)',
  amber: 'var(--amber)',
  blue: 'oklch(0.74 0.13 250)',
}

/* ── Hero: full privacy-architecture diagram ─────────────────────────────── */
function ArchitectureDiagram() {
  const Node = ({ x, y, w, h, accent, title, sub }: { x: number; y: number; w: number; h: number; accent: string; title: string; sub?: string }) => (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={11} fill={C.node} stroke={accent} strokeWidth={1.3} />
      <rect x={x} y={y} width={4} height={h} rx={2} fill={accent} opacity={0.9} />
      <text x={x + 16} y={y + (sub ? 26 : h / 2 + 4)} fill={C.text} fontSize={14} fontWeight={600} fontFamily="inherit">{title}</text>
      {sub && <text x={x + 16} y={y + 44} fill={C.text2} fontSize={11} fontFamily="inherit">{sub}</text>}
    </g>
  )
  const Label = ({ x, y, t, fill = C.text2, anchor = 'middle' as const }: { x: number; y: number; t: string; fill?: string; anchor?: 'middle' | 'start' | 'end' }) => (
    <text x={x} y={y} fill={fill} fontSize={10.5} fontFamily="var(--mono, monospace)" textAnchor={anchor}>{t}</text>
  )

  return (
    <div style={{ overflowX: 'auto', maxWidth: '100%', border: '1px solid var(--line)', borderRadius: 12, background: 'linear-gradient(180deg, var(--bg-1), var(--bg))', padding: 8 }}>
      <svg viewBox="0 0 920 430" width="100%" style={{ minWidth: 760, display: 'block' }} role="img" aria-label="PolyShield privacy architecture">
        <defs>
          <marker id="arw" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto">
            <path d="M0,0 L6.5,3 L0,6 Z" fill="rgba(255,255,255,0.45)" />
          </marker>
          <marker id="arwG" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto">
            <path d="M0,0 L6.5,3 L0,6 Z" fill={C.green} />
          </marker>
        </defs>

        {/* privacy boundary */}
        <line x1={252} y1={20} x2={252} y2={406} stroke="rgba(255,255,255,0.16)" strokeWidth={1} strokeDasharray="3 5" />
        <text x={244} y={398} fill={C.text2} fontSize={10} textAnchor="end" fontFamily="var(--mono, monospace)">your identity</text>
        <text x={260} y={398} fill={C.cyan} fontSize={10} textAnchor="start" fontFamily="var(--mono, monospace)">shared anonymity set →</text>

        {/* connectors (drawn first, under nodes' labels) */}
        {/* deposit: wallet → vault (public, crosses boundary) */}
        <path d="M192,74 C 360,74 380,150 500,150" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={1.4} markerEnd="url(#arw)" />
        <Label x={360} y={96} t="deposit() — your only tx" />
        {/* prover → relay */}
        <line x1={192} y1={219} x2={284} y2={219} stroke="rgba(255,255,255,0.3)" strokeWidth={1.4} markerEnd="url(#arw)" />
        <Label x={238} y={210} t="ZK proof" />
        {/* relay → vault */}
        <line x1={436} y1={219} x2={500} y2={210} stroke="rgba(255,255,255,0.3)" strokeWidth={1.4} markerEnd="url(#arw)" />
        <Label x={468} y={236} t="relay tx" />
        {/* vault → signer */}
        <path d="M696,150 C 720,120 720,96 740,80" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={1.4} markerEnd="url(#arw)" />
        <Label x={744} y={132} t="BetAuthorized" anchor="start" />
        {/* signer → polymarket */}
        <line x1={822} y1={106} x2={822} y2={298} stroke="rgba(255,255,255,0.3)" strokeWidth={1.4} markerEnd="url(#arw)" />
        <Label x={832} y={210} t="order" anchor="start" />
        <Label x={832} y={224} t="FAK/GTC/GTD" anchor="start" />
        {/* polymarket → vault (resolve) */}
        <path d="M740,326 C 716,300 716,290 698,278" fill="none" stroke={C.green} strokeWidth={1.4} markerEnd="url(#arwG)" opacity={0.8} />
        <Label x={742} y={300} t="resolveMarket" fill={C.green} anchor="start" />

        {/* nodes */}
        <Node x={24} y={42} w={168} h={64} accent={C.blue} title="Your Wallet" sub="signs deposit() only" />
        <Node x={24} y={188} w={168} h={64} accent={C.cyan} title="Browser Prover" sub="secret never leaves" />
        <Node x={286} y={188} w={150} h={64} accent={C.violet} title="Proof Relay" sub="pays gas · tx.from" />
        <Node x={740} y={42} w={164} h={64} accent={C.amber} title="Signing Layer" sub="vault EOA key" />
        <Node x={740} y={300} w={164} h={64} accent={C.red} title="Polymarket" sub="CLOB · CTF · relayer" />

        {/* vault hub */}
        <rect x={500} y={96} width={196} height={210} rx={12} fill={C.node} stroke={C.green} strokeWidth={1.5} />
        <rect x={500} y={96} width={196} height={4} rx={2} fill={C.green} />
        <text x={516} y={124} fill={C.text} fontSize={15} fontWeight={700} fontFamily="inherit">VAULT</text>
        <text x={680} y={124} fill={C.green} fontSize={10} textAnchor="end" fontFamily="var(--mono, monospace)">UUPS · Polygon</text>
        {[
          'Merkle tree · 1024 roots',
          'Nullifier registry',
          '9 Groth16 verifiers',
          'betRecords · pendingCredit',
          'fees · USDC custody',
        ].map((t, i) => (
          <g key={t}>
            <circle cx={518} cy={150 + i * 26 - 4} r={2.2} fill={C.green} />
            <text x={530} y={150 + i * 26} fill={C.text2} fontSize={11.5} fontFamily="inherit">{t}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

/* ── Compact per-step flow graphic ───────────────────────────────────────── */
type Chip = { t: string; sub?: string; dim?: boolean }
function StepFlow({ chips, accent }: { chips: Chip[]; accent: string }) {
  const W = 150, GAP = 30, H = 96
  const total = chips.length * W + (chips.length - 1) * GAP
  return (
    <svg viewBox={`0 0 ${total} ${H}`} width="100%" style={{ maxWidth: total, display: 'block' }} role="img">
      <defs>
        <marker id={`a-${accent.replace(/[^a-z]/gi, '')}`} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="rgba(255,255,255,0.4)" />
        </marker>
      </defs>
      {chips.map((c, i) => {
        const x = i * (W + GAP)
        return (
          <g key={i} opacity={c.dim ? 0.4 : 1}>
            <rect x={x} y={H / 2 - 26} width={W} height={52} rx={9} fill={C.node} stroke={c.dim ? C.lineSoft : accent} strokeWidth={1.2} strokeDasharray={c.dim ? '3 4' : undefined} />
            <text x={x + W / 2} y={c.sub ? H / 2 - 4 : H / 2 + 4} textAnchor="middle" fill={C.text} fontSize={12.5} fontWeight={600} fontFamily="inherit">{c.t}</text>
            {c.sub && <text x={x + W / 2} y={H / 2 + 13} textAnchor="middle" fill={C.text2} fontSize={10} fontFamily="var(--mono, monospace)">{c.sub}</text>}
            {i < chips.length - 1 && (
              <line x1={x + W + 4} y1={H / 2} x2={x + W + GAP - 4} y2={H / 2} stroke="rgba(255,255,255,0.3)" strokeWidth={1.3} markerEnd={`url(#a-${accent.replace(/[^a-z]/gi, '')})`} />
            )}
          </g>
        )
      })}
    </svg>
  )
}

const STEPS = [
  {
    n: '01',
    accent: C.blue,
    title: 'Deposit USDC into the shared vault',
    body: "You transfer USDC to the Vault and your browser generates a spending note (secret, balance, nonce, owner_address). A mandatory deposit-binding ZK proof ties the committed balance to the exact amount you transferred — so no one can commit more than they paid. The secret is derived from a wallet signature; there is nothing to back up. Your deposit amount is public; the note contents are not.",
    code: 'C = Poseidon4(secret, balance, nonce, owner_address)',
    chips: [{ t: 'USDC', sub: 'transferFrom' }, { t: 'Deposit proof', sub: 'binds balance' }, { t: 'New tree leaf', sub: 'commitment' }] as Chip[],
  },
  {
    n: '02',
    accent: C.cyan,
    title: 'Choose a position & prove it',
    body: 'Browse live Polymarket markets and pick a side. Your browser generates a BET_AUTH proof showing your note has enough balance, the nullifier belongs to your note, and the new note after spending is well-formed. The Vault injects the fee, so the spend is exactly bet_amount + fee. No secret ever leaves your device.',
    code: 'nullifier = Poseidon2(secret, nonce)',
    chips: [{ t: 'Your note', sub: 'balance' }, { t: 'BET_AUTH', sub: 'WASM proof' }, { t: 'New note', sub: '− bet − fee' }] as Chip[],
  },
  {
    n: '03',
    accent: C.violet,
    title: 'The relay submits the authorization',
    body: 'Your ZK proof goes to the Proof Relay — not your wallet. The relay calls Vault.authorizeBet() from its own EOA and pays the gas, so your wallet address never appears in any bet-related transaction. This is what keeps the deposit unlinkable from the bet.',
    code: 'Vault.authorizeBet(proof, publicInputs)   // tx.from = relay',
    chips: [{ t: 'Your wallet', sub: 'idle', dim: true }, { t: 'Proof Relay', sub: 'pays gas' }, { t: 'Vault', sub: 'verifies' }] as Chip[],
  },
  {
    n: '04',
    accent: C.amber,
    title: 'The vault EOA places the order',
    body: "The Signing Layer sees the BetAuthorized event and places the order on Polymarket's CLOB from the vault's single shared EOA — a fill-and-kill (FAK) order for market bets, or a resting GTC/GTD order for limit bets. Every depositor's bets come from that one address, so no CLOB observer can tell which depositor authorized which bet. Collateral is funded just-in-time.",
    code: 'POST /order { tokenId, price, size, type: "FAK" | "GTC" | "GTD" }',
    chips: [{ t: 'Many notes', sub: 'A · B · C' }, { t: 'One vault EOA', sub: 'shared' }, { t: 'Polymarket', sub: 'CLOB' }] as Chip[],
  },
  {
    n: '05',
    accent: C.green,
    title: 'Settle winnings into a fresh note',
    body: 'When the market resolves, the Vault derives the payout on-chain from the real Gnosis CTF. You generate a SETTLEMENT_CREDIT proof locally and the payout is added to a fresh private note — the Vault injects the payout, so you cannot inflate the credit. One click; no payout witness required.',
    code: 'new_commitment = Poseidon4(secret, balance + credit, nonce+1, owner)',
    chips: [{ t: 'Market resolved', sub: 'CTF payout' }, { t: 'SETTLE proof', sub: '+ credit' }, { t: 'New note', sub: 'private' }] as Chip[],
  },
  {
    n: '06',
    accent: C.cyan,
    title: 'Withdraw to your own address',
    body: 'The WITHDRAWAL proof proves you know a note secret and commits to a recipient via its Poseidon hash. You can only withdraw to the wallet that made the original deposit — enforced inside the circuit via owner_address and re-checked by the Vault. The relay submits it, so no identifying data appears on-chain.',
    code: 'recipient_hash = Poseidon2(recipient_address, 0)',
    chips: [{ t: 'Your note', sub: 'WITHDRAWAL' }, { t: 'owner check', sub: 'self only' }, { t: 'Your wallet', sub: 'USDC' }] as Chip[],
  },
]

const THREATS = [
  { threat: 'Observer sees which EOA placed the Polymarket order', mitigated: true, how: 'All orders from the vault\'s single shared EOA; the depositor never appears' },
  { threat: 'On-chain observer links a nullifier to a depositor address', mitigated: true, how: 'Nullifier = Poseidon2(secret, nonce); not derivable without the secret' },
  { threat: 'Relay or signing layer learns who authorized which bet', mitigated: true, how: 'They see only the ZK proof; public inputs contain no depositor ID' },
  { threat: 'Backend index de-anonymizes or forges notes', mitigated: true, how: 'Serves only public data; client matches by its own nullifier — worst case is incomplete recovery' },
  { threat: 'Forged deposit balance, double-spend, or inflated credit', mitigated: true, how: 'Blocked on-chain by the circuits + Vault-injected values, regardless of who sends the tx' },
  { threat: 'Calling a spend function from your OWN wallet', mitigated: false, how: 'Self-deanonymizes — the frontend never does this; it is a client discipline (threat T19)' },
  { threat: 'That a wallet used PolyShield at all', mitigated: false, how: 'Vault.deposit() is a public ERC-20 transfer — only post-deposit activity is private' },
  { threat: 'Owner can upgrade the contracts instantly (UUPS)', mitigated: false, how: 'Largest trust assumption — the owner key must be a multisig/HSM in production' },
]

export default function HowItWorksPage() {
  return (
    <div style={{ maxWidth: 940, margin: '0 auto', padding: '48px 24px 80px' }}>
      <div className="micro" style={{ color: 'var(--cyan)' }}>HOW IT WORKS</div>
      <h1 className="h2 mt-3" style={{ margin: 0 }}>Private prediction markets, step by step.</h1>
      <p className="body mt-4" style={{ maxWidth: 640 }}>
        PolyShield uses zero-knowledge proofs to hide which depositor placed which bet. The vault is a single Polymarket
        account shared by everyone in the pool — so on-chain, every bet looks the same. Here is the full flow.
      </p>

      {/* Hero architecture diagram */}
      <div style={{ marginTop: 40 }}>
        <ArchitectureDiagram />
        <p className="small mt-3" style={{ fontSize: 12, color: 'var(--text-2)', maxWidth: 720, marginTop: 12 }}>
          Your wallet only ever signs <code className="mono" style={{ color: 'var(--text-1)' }}>deposit()</code> (public by design). Every bet, settlement, and withdrawal is
          generated as a proof in your browser and submitted by the <span style={{ color: 'var(--violet)' }}>relay</span>, never your wallet — so nothing on-chain links you to a bet.
          Inside the <span style={{ color: 'var(--green)' }}>vault</span>, all depositors share one Polymarket identity.
        </p>
      </div>

      {/* Steps */}
      <div className="col gap-8" style={{ marginTop: 56, display: 'flex', flexDirection: 'column', gap: 40 }}>
        {STEPS.map(({ n, accent, title, body, code, chips }) => (
          <div key={n} style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 20 }}>
            <div className="num" style={{ fontSize: 34, color: accent, lineHeight: 1, paddingTop: 2, fontVariantNumeric: 'tabular-nums' }}>{n}</div>
            <div>
              <h3 style={{ margin: 0, fontSize: 17 }}>{title}</h3>
              <div className="panel mt-3" style={{ marginTop: 14, padding: 16, background: 'var(--bg-1)' }}>
                <StepFlow chips={chips} accent={accent} />
              </div>
              <p className="body mt-3" style={{ fontSize: 14, marginTop: 14 }}>{body}</p>
              <pre className="mono mt-3" style={{ margin: 0, marginTop: 12, fontSize: 11, color: accent, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 14px', overflowX: 'auto' }}>{code}</pre>
            </div>
          </div>
        ))}
      </div>

      {/* Threat model */}
      <div style={{ marginTop: 64 }}>
        <div className="micro">THREAT MODEL SUMMARY</div>
        <p className="small mt-2" style={{ fontSize: 12, color: 'var(--text-2)', maxWidth: 640, marginTop: 8 }}>
          What an observer with full on-chain visibility can and cannot learn. The contracts protect funds on every path;
          only the client protects privacy.
        </p>
        <div className="panel mt-4" style={{ padding: 0, marginTop: 16 }}>
          <table className="tbl">
            <thead>
              <tr><th>Threat</th><th>Mitigated?</th><th>How</th></tr>
            </thead>
            <tbody>
              {THREATS.map(({ threat, mitigated, how }) => (
                <tr key={threat}>
                  <td style={{ fontSize: 13 }}>{threat}</td>
                  <td>
                    <span style={{ fontSize: 11, color: mitigated ? 'var(--green)' : 'var(--amber)', fontFamily: 'var(--mono)' }}>
                      {mitigated ? '✓ YES' : '⚠ NO'}
                    </span>
                  </td>
                  <td className="small" style={{ fontSize: 12 }}>{how}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* FAQ — answers the high-intent questions surfaced in the SEO audit. */}
      <div id="faq" style={{ marginTop: 72 }}>
        <div className="micro">FREQUENTLY ASKED QUESTIONS</div>
        <h2 className="h3 mt-2" style={{ margin: 0, marginTop: 8 }}>Common questions about private trading.</h2>
        <div className="panel mt-4" style={{ marginTop: 20, padding: 0 }}>
          {FAQS.map(({ q, a }, i) => (
            <details
              key={q}
              style={{
                borderTop: i === 0 ? 'none' : '1px solid var(--line)',
                padding: '4px 20px',
              }}
            >
              <summary
                style={{
                  cursor: 'pointer',
                  listStyle: 'none',
                  padding: '16px 0',
                  fontSize: 15,
                  fontWeight: 600,
                  color: 'var(--text-1)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 16,
                }}
              >
                {q}
                <span aria-hidden className="mono disclosure" style={{ color: 'var(--text-2)', fontSize: 13 }} />
              </summary>
              <p className="body" style={{ fontSize: 14, margin: 0, padding: '0 0 18px', maxWidth: 760, color: 'var(--text-2)' }}>
                {a}
              </p>
            </details>
          ))}
        </div>
      </div>

      {/* SEO/AEO: FAQPage structured data — mirrors the visible Q&A verbatim. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: FAQS.map(({ q, a }) => ({
              '@type': 'Question',
              name: q,
              acceptedAnswer: { '@type': 'Answer', text: a },
            })),
          }),
        }}
      />

      <div style={{ marginTop: 48, display: 'flex', gap: 16 }}>
        <Link href="/app/deposit" className="btn btn-primary" style={{ textDecoration: 'none' }}>Start depositing</Link>
        <Link href="/docs" className="btn" style={{ textDecoration: 'none' }}>Read the docs</Link>
      </div>
    </div>
  )
}
