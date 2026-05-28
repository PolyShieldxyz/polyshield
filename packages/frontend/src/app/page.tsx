'use client'
import { useState, useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { SiteFooter } from '@/components/ui/SiteFooter'
import { SectionHead } from '@/components/ui/SectionHead'
import { Icon, ICONS } from '@/components/ui/Icon'
import { AnimatedNumber } from '@/components/ui/AnimatedNumber'
import { Sparkline } from '@/components/ui/Sparkline'
import { Hash } from '@/components/ui/Hash'

/* ---------- Hero visual: animated cryptographic graph ---------- */
function HeroVisual() {
  const w = 640, h = 520
  const nodes = useMemo(() => {
    const arr: { x: number; y: number; kind: string; ring?: number }[] = []
    const rings = [{ r: 60, n: 5 }, { r: 130, n: 9 }, { r: 200, n: 14 }]
    arr.push({ x: w / 2, y: h / 2, kind: 'vault' })
    rings.forEach(({ r, n }, ri) => {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + ri * 0.2
        arr.push({ x: w / 2 + Math.cos(a) * r, y: h / 2 + Math.sin(a) * r, kind: ri === 2 ? 'depositor' : 'note', ring: ri })
      }
    })
    return arr
  }, [])

  const lines = useMemo(() => {
    const out: [number, number][] = []
    nodes.forEach((n, i) => {
      if (n.kind === 'vault') return
      let best = -1, bd = Infinity
      nodes.forEach((m, j) => {
        if (i === j) return
        if ((m.ring ?? -1) < (n.ring ?? 0) || (m.kind === 'vault' && n.ring === 0)) {
          const d = Math.hypot(m.x - n.x, m.y - n.y)
          if (d < bd) { bd = d; best = j }
        }
      })
      if (best >= 0) out.push([i, best])
    })
    return out
  }, [nodes])

  const [pulse, setPulse] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setPulse((p) => (p + 1) % nodes.length), 280)
    return () => clearInterval(id)
  }, [nodes.length])

  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: w, aspectRatio: `${w} / ${h}`, margin: '0 auto' }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="100%">
        <defs>
          <radialGradient id="vaultg" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="oklch(0.82 0.13 210)" stopOpacity="0.55" />
            <stop offset="0.6" stopColor="oklch(0.82 0.13 210)" stopOpacity="0.08" />
            <stop offset="1" stopColor="oklch(0.82 0.13 210)" stopOpacity="0" />
          </radialGradient>
        </defs>
        {[60, 130, 200, 260].map((r) => (
          <circle key={r} cx={w / 2} cy={h / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeDasharray="2 4" />
        ))}
        <circle cx={w / 2} cy={h / 2} r="180" fill="url(#vaultg)" />
        {lines.map(([a, b], i) => {
          const na = nodes[a], nb = nodes[b]
          const active = a === pulse || b === pulse
          return <line key={i} x1={na.x} y1={na.y} x2={nb.x} y2={nb.y} stroke={active ? 'oklch(0.82 0.13 210)' : 'rgba(255,255,255,0.07)'} strokeWidth={active ? 1 : 0.6} />
        })}
        {nodes.map((n, i) => {
          if (n.kind === 'vault') {
            return (
              <g key={i}>
                <rect x={n.x - 22} y={n.y - 22} width="44" height="44" rx="8" fill="rgba(255,255,255,0.06)" stroke="oklch(0.82 0.13 210)" strokeWidth="1" />
                <rect x={n.x - 14} y={n.y - 14} width="28" height="28" rx="4" fill="none" stroke="oklch(0.82 0.13 210)" strokeWidth="0.8" opacity="0.6" />
                <circle cx={n.x} cy={n.y} r="3" fill="oklch(0.85 0.13 210)" />
              </g>
            )
          }
          const active = i === pulse
          const r = n.kind === 'depositor' ? 4 : 2.5
          return (
            <g key={i}>
              {active && <circle cx={n.x} cy={n.y} r={r + 6} fill="oklch(0.82 0.13 210 / 0.18)" />}
              <circle cx={n.x} cy={n.y} r={r} fill={active ? 'oklch(0.85 0.13 210)' : n.kind === 'depositor' ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.25)'} />
            </g>
          )
        })}
        <text x={w / 2} y={h / 2 + 60} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="rgba(255,255,255,0.5)" letterSpacing="2">VAULT · SHARED EOA</text>
        <text x={w / 2 - 235} y={h / 2 - 235} fontFamily="JetBrains Mono" fontSize="9" fill="rgba(255,255,255,0.35)" letterSpacing="1">DEPOSITORS · PRIVATE BETA</text>
        <text x={w - 12} y={h - 12} textAnchor="end" fontFamily="JetBrains Mono" fontSize="9" fill="rgba(255,255,255,0.25)" letterSpacing="1">PROOF RELAY · LIVE</text>
      </svg>
    </div>
  )
}

/* ---------- Live vault tape ---------- */
function HeroTape() {
  const rows = [
    ['VAULT TX', '0xVAULT…EOA', 'YES · MARKET-A', '500 USDC', 'FILLED'],
    ['PROOF', '0xe92b…1147', 'BET-AUTH-V2', '45s', 'VERIFIED'],
    ['VAULT TX', '0xVAULT…EOA', 'NO · MARKET-B', '1,000 USDC', 'FILLED'],
    ['SETTLE', '0x1c83…aa07', 'SETTLEMENT-V1', '+2,000', 'CREDIT'],
    ['VAULT TX', '0xVAULT…EOA', 'YES · MARKET-C', '500 USDC', 'FILLED'],
  ]
  return (
    <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="row hairline-b" style={{ padding: '10px 16px', justifyContent: 'space-between' }}>
        <div className="micro">Simulated vault tape</div>
        <div className="micro" style={{ color: 'var(--text-2)' }}>● SIMULATED</div>
      </div>
      <table className="tbl">
        <thead><tr><th>Kind</th><th>Vault</th><th>Subject</th><th>Size</th><th>State</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>{r[0]}</td>
              <td><Hash value={r[1]} /></td>
              <td style={{ color: 'var(--text)' }}>{r[2]}</td>
              <td className="num">{r[3]}</td>
              <td>
                <span className={`pill ${r[4] === 'VERIFIED' || r[4] === 'FILLED' || r[4] === 'CREDIT' ? 'pill-cyan' : 'pill-amber'}`} style={{ fontSize: 10 }}>
                  {r[4]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ---------- Feature sections ---------- */
const FEATURES = [
  {
    num: 'F.01', title: 'Private trading.',
    body: 'Every bet you authorize exits the vault as if it came from a shared pool of traders. No wallet-level attribution. Observers see the vault trade — they cannot identify you.',
    diagram: (
      <svg viewBox="0 0 320 160" width="100%">
        <defs>
          <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" fill="oklch(0.82 0.13 210 / 0.7)" />
          </marker>
        </defs>
        {[40, 80, 120].map((y, i) => (
          <g key={y}>
            <rect x="10" y={y - 14} width="80" height="28" rx="4" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.14)" />
            <text x="50" y={y - 2} textAnchor="middle" fontFamily="Inter" fontSize="10" fill="#B7C0CC">Depositor {i + 1}</text>
            <text x="50" y={y + 10} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="rgba(255,255,255,0.4)">0x{(i + 1).toString().padStart(4, '0')}…</text>
            <line x1="90" y1={y} x2="140" y2="80" stroke="oklch(0.82 0.13 210 / 0.35)" strokeDasharray="3 3" markerEnd="url(#arr)" />
          </g>
        ))}
        <rect x="140" y="58" width="80" height="44" rx="6" fill="rgba(255,255,255,0.04)" stroke="oklch(0.82 0.13 210)" />
        <text x="180" y="78" textAnchor="middle" fontFamily="Inter" fontSize="11" fill="#E6EAF0">Vault</text>
        <text x="180" y="94" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="oklch(0.82 0.13 210)">0x7a4f</text>
        <line x1="220" y1="80" x2="270" y2="80" stroke="oklch(0.82 0.13 210)" markerEnd="url(#arr)" />
        <rect x="270" y="58" width="44" height="44" rx="6" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.18)" />
        <text x="292" y="82" textAnchor="middle" fontFamily="Inter" fontSize="10" fill="#B7C0CC">PM</text>
        <text x="180" y="148" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="rgba(255,255,255,0.35)">which depositor? unknowable.</text>
      </svg>
    ),
  },
  {
    num: 'F.02', title: 'Zero-knowledge proofs.',
    body: 'Bet authorization, settlement, and withdrawal are each gated by a ZK circuit. Your browser proves you are authorized — without revealing your note, balance, or identity.',
    diagram: (
      <svg viewBox="0 0 320 160" width="100%">
        <rect x="10" y="60" width="80" height="40" rx="4" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.14)" />
        <text x="50" y="78" textAnchor="middle" fontFamily="Inter" fontSize="10" fill="#B7C0CC">Browser</text>
        <text x="50" y="92" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="oklch(0.82 0.13 210)">prove(π)</text>
        <line x1="90" y1="80" x2="130" y2="80" stroke="oklch(0.82 0.13 210 / 0.5)" strokeDasharray="3 3" />
        <text x="110" y="72" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="rgba(255,255,255,0.4)">384B</text>
        <rect x="130" y="60" width="80" height="40" rx="4" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.14)" />
        <text x="170" y="78" textAnchor="middle" fontFamily="Inter" fontSize="10" fill="#B7C0CC">Relay</text>
        <text x="170" y="92" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="rgba(255,255,255,0.4)">3-hop</text>
        <line x1="210" y1="80" x2="250" y2="80" stroke="oklch(0.82 0.13 210 / 0.5)" strokeDasharray="3 3" />
        <rect x="250" y="60" width="60" height="40" rx="4" fill="rgba(255,255,255,0.04)" stroke="oklch(0.78 0.16 152)" />
        <text x="280" y="78" textAnchor="middle" fontFamily="Inter" fontSize="10" fill="#E6EAF0">Vault</text>
        <text x="280" y="92" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="oklch(0.78 0.16 152)">✓</text>
        {['commitment', 'nullifier', 'merkle path'].map((t, i) => (
          <text key={t} x="50" y={130 + i * 12} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="rgba(255,255,255,0.3)">{t}</text>
        ))}
      </svg>
    ),
  },
  {
    num: 'F.03', title: 'Strategy-safe execution.',
    body: 'FOK orders, randomized relay delay, and decoy traffic eliminate timing correlation attacks. Your conviction stays yours — not alpha for copy traders and bots.',
    diagram: (
      <svg viewBox="0 0 320 160" width="100%">
        <text x="10" y="24" fontFamily="JetBrains Mono" fontSize="9" fill="var(--red)" opacity="0.7">EXPOSED (today)</text>
        <rect x="10" y="34" width="140" height="30" rx="4" fill="oklch(0.70 0.18 25 / 0.06)" stroke="oklch(0.70 0.18 25 / 0.3)" />
        <text x="80" y="53" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="oklch(0.70 0.18 25)">wallet → polymarket fill</text>
        <text x="10" y="94" fontFamily="JetBrains Mono" fontSize="9" fill="var(--green)" opacity="0.7">SHIELDED (polyshield)</text>
        <rect x="10" y="104" width="140" height="30" rx="4" fill="oklch(0.78 0.16 152 / 0.06)" stroke="oklch(0.78 0.16 152 / 0.3)" />
        <text x="80" y="123" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="oklch(0.78 0.16 152)">vault → polymarket fill</text>
        <text x="170" y="50" fontFamily="JetBrains Mono" fontSize="8" fill="rgba(255,255,255,0.3)">observed by anyone →</text>
        <text x="170" y="62" fontFamily="JetBrains Mono" fontSize="8" fill="oklch(0.70 0.18 25)">copy bots, chain analysts</text>
        <text x="170" y="120" fontFamily="JetBrains Mono" fontSize="8" fill="rgba(255,255,255,0.3)">observed by anyone →</text>
        <text x="170" y="132" fontFamily="JetBrains Mono" fontSize="8" fill="oklch(0.78 0.16 152)">vault traded · no attribution</text>
      </svg>
    ),
  },
  {
    num: 'F.04', title: 'Shared anonymity set.',
    body: 'Every depositor in the vault shares one Polymarket EOA. Every trade you authorize is cryptographically indistinguishable from every other depositor\'s trade. The anonymity set grows with every new depositor.',
    diagram: (
      <svg viewBox="0 0 320 160" width="100%">
        <circle cx="160" cy="80" r="65" fill="oklch(0.82 0.13 210 / 0.04)" stroke="oklch(0.82 0.13 210 / 0.25)" strokeDasharray="3 4" />
        <circle cx="160" cy="80" r="40" fill="oklch(0.82 0.13 210 / 0.04)" stroke="oklch(0.82 0.13 210 / 0.25)" strokeDasharray="3 4" />
        {Array.from({ length: 36 }, (_, i) => {
          const a = (i / 36) * Math.PI * 2
          const r = 28 + (i % 3) * 18
          const you = i === 11
          return <circle key={i} cx={160 + Math.cos(a) * r} cy={80 + Math.sin(a) * r} r={you ? 4 : 2.5} fill={you ? 'oklch(0.85 0.13 210)' : 'rgba(255,255,255,0.4)'} />
        })}
        <text x="160" y="154" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="rgba(255,255,255,0.4)">depositors · you indistinguishable</text>
      </svg>
    ),
  },
  {
    num: 'F.05', title: 'Non-custodial.',
    body: 'Your note is generated locally. Your secret never leaves your browser. The vault holds USDC — not your identity. Withdraw any time back to your own address with a ZK proof. Your depositing wallet is cryptographically bound inside the note commitment.',
    diagram: (
      <svg viewBox="0 0 320 160" width="100%">
        <rect x="10" y="50" width="90" height="60" rx="6" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.14)" />
        <text x="55" y="74" textAnchor="middle" fontFamily="Inter" fontSize="10" fill="#E6EAF0">Your browser</text>
        <text x="55" y="90" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="oklch(0.82 0.13 210)">secret = rand()</text>
        <text x="55" y="102" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="rgba(255,255,255,0.35)">never sent</text>
        <line x1="100" y1="80" x2="130" y2="80" stroke="var(--line-strong)" strokeDasharray="3 3" />
        <text x="115" y="72" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="oklch(0.78 0.16 152)">C = H(s,v)</text>
        <rect x="130" y="50" width="90" height="60" rx="6" fill="rgba(255,255,255,0.04)" stroke="oklch(0.82 0.13 210)" />
        <text x="175" y="74" textAnchor="middle" fontFamily="Inter" fontSize="10" fill="#E6EAF0">Vault contract</text>
        <text x="175" y="90" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="rgba(255,255,255,0.5)">commitment tree</text>
        <text x="175" y="102" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="oklch(0.78 0.16 152)">USDC</text>
        <text x="240" y="55" fontFamily="JetBrains Mono" fontSize="8" fill="rgba(255,255,255,0.3)">withdraw to</text>
        <text x="240" y="67" fontFamily="JetBrains Mono" fontSize="8" fill="rgba(255,255,255,0.3)">your own</text>
        <text x="240" y="79" fontFamily="JetBrains Mono" fontSize="8" fill="rgba(255,255,255,0.3)">address.</text>
      </svg>
    ),
  },
]

/* ---------- Architecture section ---------- */
const ARCH_NODES = [
  { id: 'wallet', label: 'User Wallet', x: 80, y: 80, color: 'rgba(255,255,255,0.6)', role: 'Signs deposit transactions. Never touches bet authorization on-chain.' },
  { id: 'browser', label: 'Browser WASM', x: 80, y: 200, color: 'var(--cyan)', role: 'Generates ZK proofs client-side. Secret never leaves the browser.' },
  { id: 'relay', label: 'Proof Relay', x: 240, y: 200, color: 'var(--violet)', role: '3-hop onion relay. Forwards encrypted proofs with randomized jitter.' },
  { id: 'vault', label: 'Vault Contract', x: 400, y: 140, color: 'var(--cyan)', role: 'Verifies ZK proofs, maintains commitment Merkle tree, holds USDC.' },
  { id: 'tree', label: 'Merkle Tree', x: 560, y: 80, color: 'rgba(255,255,255,0.5)', role: 'Poseidon depth-32 append-only commitment accumulator.' },
  { id: 'nullifier', label: 'Nullifier Registry', x: 560, y: 200, color: 'rgba(255,255,255,0.5)', role: 'Tracks spent nullifiers to prevent double-spend.' },
  { id: 'signer', label: 'Signing Layer', x: 400, y: 280, color: 'var(--amber)', role: 'Centralized signing operator (v1). Listens for BetAuthorized events and submits FOK orders to Polymarket CLOB. TEE-attested enclave is planned for v2.' },
  { id: 'pm', label: 'Polymarket', x: 560, y: 340, color: 'rgba(255,255,255,0.4)', role: 'CTF exchange. Executes fills. Sees vault trades, not depositor identity.' },
]
const ARCH_EDGES = [
  ['wallet', 'vault'], ['browser', 'relay'], ['relay', 'vault'],
  ['vault', 'tree'], ['vault', 'nullifier'], ['vault', 'signer'], ['signer', 'pm'],
]

function ArchitectureDiagram() {
  const [hover, setHover] = useState<string | null>(null)
  const hoverNode = ARCH_NODES.find((n) => n.id === hover)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 24 }}>
      <div className="panel-strong" style={{ padding: 24 }}>
        <svg viewBox="0 0 680 420" width="100%" style={{ display: 'block' }}>
          <defs>
            <marker id="arche" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="rgba(255,255,255,0.2)" />
            </marker>
          </defs>
          {ARCH_EDGES.map(([from, to], i) => {
            const a = ARCH_NODES.find((n) => n.id === from)!
            const b = ARCH_NODES.find((n) => n.id === to)!
            const active = hover === from || hover === to
            return (
              <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={active ? 'oklch(0.82 0.13 210 / 0.6)' : 'rgba(255,255,255,0.1)'}
                strokeWidth={active ? 1.5 : 1} markerEnd="url(#arche)" />
            )
          })}
          {ARCH_NODES.map((n) => {
            const active = hover === n.id
            return (
              <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} style={{ cursor: 'pointer' }}>
                {active && <circle cx={n.x} cy={n.y} r="22" fill="oklch(0.82 0.13 210 / 0.12)" />}
                <circle cx={n.x} cy={n.y} r="14" fill="rgba(255,255,255,0.04)" stroke={active ? n.color : 'rgba(255,255,255,0.15)'} strokeWidth={active ? 1.5 : 1} />
                <circle cx={n.x} cy={n.y} r="4" fill={n.color} opacity={active ? 1 : 0.6} />
                <text x={n.x} y={n.y + 28} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill={active ? 'var(--text)' : 'rgba(255,255,255,0.45)'} letterSpacing="0.5">{n.label}</text>
              </g>
            )
          })}
        </svg>
      </div>
      <div className="panel" style={{ padding: 20 }}>
        <div className="micro">NODE ROLE</div>
        {hoverNode ? (
          <div className="mt-3">
            <div className="h4" style={{ fontSize: 15, color: hoverNode.color }}>{hoverNode.label}</div>
            <p className="body mt-2" style={{ fontSize: 13 }}>{hoverNode.role}</p>
          </div>
        ) : (
          <div className="small mt-3" style={{ color: 'var(--text-3)' }}>Hover a node to see its role in the protocol.</div>
        )}
        <div className="hairline-t mt-6" style={{ paddingTop: 12 }}>
          <div className="micro">LEGEND</div>
          <div className="col mt-3 gap-2">
            {[['var(--cyan)', 'On-chain (Polygon)'], ['var(--violet)', 'Relay network'], ['var(--amber)', 'Signing layer (v1 centralized)'], ['rgba(255,255,255,0.5)', 'User / Polymarket']].map(([c, l]) => (
              <div key={l} className="row gap-2">
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: c, flexShrink: 0 }} />
                <span className="small" style={{ fontSize: 12 }}>{l}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------- Security section ---------- */
const SECURITY = [
  { icon: ICONS.proof, title: 'Soundness via ZK', body: 'Every state transition is gated by a circuit constraint. Invalid proofs are rejected on-chain. No admin backdoor.' },
  { icon: ICONS.privacy, title: 'Open-source contracts', body: 'Smart contracts are open-source and MIT licensed. Independent audits are planned before mainnet deployment.' },
  { icon: ICONS.lock, title: 'No custody of secrets', body: 'Your note preimage never leaves your browser. The vault holds USDC, not your identity material.' },
  { icon: ICONS.proof, title: 'Browser-side proving', body: 'Proof generation runs entirely in your browser via WASM. Expect 30 seconds to 2 minutes depending on device and circuit.' },
  { icon: ICONS.vault, title: 'Private note ownership', body: 'A note is only spendable by whoever knows the secret. Lose the note, lose access — no recovery.' },
  { icon: ICONS.settle, title: 'Nullifier protection', body: 'Every spent note produces a public nullifier. On-chain deduplication prevents double-spend without revealing which note was spent.' },
]

/* ---------- Final CTA ---------- */
function FinalCTA() {
  const seated = 0, total = 200
  const pct = (seated / total) * 100
  return (
    <div className="panel" style={{ padding: 48, textAlign: 'center' }}>
      <div className="pill pill-cyan" style={{ margin: '0 auto', display: 'inline-flex' }}>
        <span className="dot"></span>
        {seated} / {total} SEATS CLAIMED
      </div>
      <h2 className="h2 mt-6" style={{ margin: 0 }}>Apply for testnet access.</h2>
      <p className="body mt-4" style={{ maxWidth: 480, margin: '16px auto 0' }}>
        We're onboarding a limited cohort to validate the full ZK proof flow on Polygon Amoy. Testnet USDC provided — no real funds required.
      </p>
      <div style={{ maxWidth: 320, margin: '32px auto 0' }}>
        <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
          <div style={{ height: 4, width: `${pct}%`, background: 'var(--cyan)', borderRadius: 2 }} />
        </div>
        <div className="row mt-2" style={{ justifyContent: 'space-between', fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-3)' }}>
          <span>{seated} joined</span><span>{total - seated} remaining</span>
        </div>
      </div>
      <div className="row gap-3 mt-8" style={{ justifyContent: 'center' }}>
        <Link href="/testnet" className="btn btn-primary" style={{ padding: '14px 32px', fontSize: 15 }}>
          Join testnet <Icon d={ICONS.arrow} size={14} />
        </Link>
        <Link href="/how" className="btn" style={{ padding: '14px 24px', fontSize: 15 }}>How it works</Link>
        <Link href="/docs" className="btn btn-ghost" style={{ padding: '14px 24px', fontSize: 15 }}>Read the docs</Link>
      </div>
    </div>
  )
}

export default function LandingPage() {
  return (
    <div className="page dot-grid">
      {/* Hero */}
      <section style={{ paddingTop: 64, paddingBottom: 80 }}>
        <div className="container">
          <div style={{ display: 'grid', gridTemplateColumns: '1.05fr 0.95fr', gap: 56, alignItems: 'center' }}>
            <div>
              <div className="pill pill-cyan" style={{ fontSize: 11 }}>
                <span className="dot" />&nbsp;POLYGON AMOY TESTNET · PRIVATE BETA
              </div>
              <h1 className="h1 mt-6">
                Trade prediction<br />markets<span className="text-cyan">,</span> privately.
              </h1>
              <p className="body mt-6" style={{ maxWidth: 520, fontSize: 17 }}>
                Polyshield is a zero-knowledge vault layer for Polymarket. Deposit USDC,
                place trades from a shared anonymity set, and settle privately —
                with cryptographic guarantees, not promises.
              </p>
              <div className="row gap-3 mt-8">
                <Link href="/testnet" className="btn btn-primary">Join testnet <Icon d={ICONS.arrow} size={12} /></Link>
                <Link href="/docs" className="btn">Read the docs</Link>
                <Link href="/how" className="btn btn-ghost">How it works →</Link>
              </div>
              <div className="row gap-6 mt-12">
                {[
                  ['Vault volume', '—', 'testnet only'],
                  ['Active testers', '< 200', 'private beta'],
                  ['Avg proof time', '30s – 2min', 'browser WASM'],
                  ['Proof types', '5', 'circuits live'],
                ].map(([l, v, s]) => (
                  <div key={l as string}>
                    <div className="micro">{l}</div>
                    <div className="num" style={{ fontSize: 20, marginTop: 4 }}>{v}</div>
                    <div className="small" style={{ fontSize: 11 }}>{s}</div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <HeroVisual />
              <div className="mt-4">
                <HeroTape />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section style={{ paddingBottom: 80 }}>
        <div className="container">
          <SectionHead kicker="PROTOCOL" title="Five privacy primitives, one vault." sub="Each feature enforces one property of the privacy invariant. Together they are composable and independently auditable." />
          <div className="col gap-6 mt-12">
            {FEATURES.map((f, i) => (
              <div key={f.num} className="panel" style={{ padding: 40 }}>
                <div style={{ display: 'grid', gridTemplateColumns: i % 2 === 0 ? '1fr 1.2fr' : '1.2fr 1fr', gap: 48, alignItems: 'center' }}>
                  <div style={{ order: i % 2 === 0 ? 0 : 1 }}>
                    <div className="micro" style={{ color: 'var(--cyan)' }}>{f.num}</div>
                    <h2 className="h3 mt-3" style={{ margin: 0 }}>{f.title}</h2>
                    <p className="body mt-4" style={{ maxWidth: 460 }}>{f.body}</p>
                  </div>
                  <div className="panel-strong" style={{ padding: 24, order: i % 2 === 0 ? 1 : 0 }}>{f.diagram}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Architecture */}
      <section style={{ paddingBottom: 80 }}>
        <div className="container">
          <SectionHead kicker="ARCHITECTURE" title="Eight components. One privacy invariant." sub="Hover any node to see its role. Every component can be audited in isolation." />
          <div className="mt-10">
            <ArchitectureDiagram />
          </div>
        </div>
      </section>

      {/* Security */}
      <section style={{ paddingBottom: 80 }}>
        <div className="container">
          <SectionHead kicker="SECURITY" title="What the protocol promises." />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginTop: 40 }}>
            {SECURITY.map((s) => (
              <div key={s.title} className="panel" style={{ padding: 24 }}>
                <Icon d={s.icon} size={18} className="text-cyan" />
                <div className="h4 mt-3" style={{ fontSize: 16 }}>{s.title}</div>
                <p className="body mt-2" style={{ fontSize: 13 }}>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section style={{ paddingBottom: 80 }}>
        <div className="container">
          <FinalCTA />
        </div>
      </section>

      <SiteFooter />
    </div>
  )
}
