'use client'
// Pure presentational components (SVG / inline-styled markup). Rendered from the
// client docs page and from the blog's client-rendered MDX subtree (MDX compiles to
// React 18's react/jsx-runtime, which only works in the client runtime — so the blog
// post body is a client component, SSR'd into the HTML for SEO).
import type { CSSProperties, ReactNode } from 'react'

/* DocKit — reusable building blocks for the documentation pages.
   Two families:
     1. Prose primitives (P, Lead, H3, Bullets, Steps, Callout, Term, Code, Pre)
     2. Concept diagrams — hand-built, theme-aware SVGs that explain a PolyShield
        idea with a relatable picture. Colors read from the P5 tokens
        (--accent gold = "your value / your path", --brand indigo = "structure /
        cryptography"), so the art tracks the rest of the app automatically. */

const GOLD = 'var(--accent)'
const INDIGO = 'var(--brand)'
const GREEN = 'var(--green)'
const AMBER = 'var(--amber)'
const INK1 = 'var(--text-1)'
const INK2 = 'var(--text-2)'
const INK3 = 'var(--text-3)'
const SURFACE = 'var(--surface)'

/* ────────────────────────────── prose primitives ────────────────────────── */

export function Lead({ children }: { children: ReactNode }) {
  return <p style={{ margin: '0 0 18px', fontSize: 'var(--fs-read-lead)', lineHeight: 1.65, color: INK1 }}>{children}</p>
}

export function P({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <p style={{ margin: '12px 0', fontSize: 'var(--fs-read)', lineHeight: 'var(--lh-read)', color: INK1, ...style }}>{children}</p>
}

export function H3({ children }: { children: ReactNode }) {
  return (
    <h3 className="editorial-head" style={{ fontSize: 'var(--fs-read-h3)', fontWeight: 600, margin: '30px 0 6px', letterSpacing: '-0.01em' }}>
      {children}
    </h3>
  )
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="mono" style={{ fontSize: 12.5, background: 'var(--bg-1)', padding: '1px 6px', borderRadius: 4, color: INK1, border: '1px solid var(--line)' }}>
      {children}
    </code>
  )
}

export function Pre({ children }: { children: ReactNode }) {
  return (
    <pre className="mono" style={{ fontSize: 12.5, lineHeight: 1.7, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 'var(--r-2)', padding: '12px 14px', margin: '14px 0', overflowX: 'auto', color: INK1 }}>
      {children}
    </pre>
  )
}

export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul style={{ margin: '10px 0', paddingLeft: 0, listStyle: 'none' }}>
      {items.map((it, i) => (
        <li key={i} className="row gap-3" style={{ alignItems: 'flex-start', margin: '7px 0' }}>
          <span aria-hidden style={{ color: GOLD, fontSize: 14, lineHeight: '24px', flexShrink: 0 }}>·</span>
          <span style={{ fontSize: 'var(--fs-read)', lineHeight: 1.65, color: INK1 }}>{it}</span>
        </li>
      ))}
    </ul>
  )
}

export function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol style={{ margin: '14px 0', paddingLeft: 0, listStyle: 'none', counterReset: 'doc-step' }}>
      {items.map((it, i) => (
        <li key={i} className="row gap-3" style={{ alignItems: 'flex-start', margin: '12px 0' }}>
          <span
            className="mono"
            aria-hidden
            style={{
              flexShrink: 0, width: 24, height: 24, borderRadius: '50%',
              border: '1px solid var(--accent-line)', color: GOLD,
              fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--accent-soft)',
            }}
          >
            {i + 1}
          </span>
          <span style={{ fontSize: 'var(--fs-read)', lineHeight: 1.7, color: INK1, paddingTop: 1 }}>{it}</span>
        </li>
      ))}
    </ol>
  )
}

const TONES: Record<string, { c: string; soft: string; line: string }> = {
  info: { c: INDIGO, soft: 'var(--brand-soft)', line: 'var(--brand-line)' },
  gold: { c: GOLD, soft: 'var(--accent-soft)', line: 'var(--accent-line)' },
  warn: { c: AMBER, soft: 'oklch(0.80 0.14 55 / 0.10)', line: 'oklch(0.80 0.14 55 / 0.40)' },
}

export function Callout({ title, tone = 'info', children }: { title?: string; tone?: 'info' | 'gold' | 'warn'; children: ReactNode }) {
  const t = TONES[tone]
  return (
    <div style={{ margin: '16px 0', borderRadius: 'var(--r-2)', border: `1px solid ${t.line}`, background: t.soft, padding: '12px 16px' }}>
      {title && <div className="micro" style={{ color: t.c, marginBottom: 6 }}>{title}</div>}
      <div style={{ fontSize: 15.5, lineHeight: 1.65, color: INK1 }}>{children}</div>
    </div>
  )
}

export function Term({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl style={{ margin: '14px 0', display: 'grid', gridTemplateColumns: 'minmax(120px, max-content) 1fr', gap: '10px 18px' }}>
      {rows.map(([t, d], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt className="mono" style={{ fontSize: 12.5, color: GOLD, paddingTop: 1 }}>{t}</dt>
          <dd style={{ margin: 0, fontSize: 15.5, lineHeight: 1.6, color: INK1 }}>{d}</dd>
        </div>
      ))}
    </dl>
  )
}

/* ────────────────────────────── diagram helpers ─────────────────────────── */

function Figure({ caption, h = 300, children }: { caption: ReactNode; h?: number; children: ReactNode }) {
  return (
    <figure style={{ margin: '24px 0' }}>
      <div className="panel" style={{ padding: '22px 18px', background: 'var(--bg-1)', overflow: 'hidden' }}>
        <svg viewBox={`0 0 640 ${h}`} width="100%" role="img" style={{ display: 'block', fontFamily: 'var(--mono)' }}>
          {children}
        </svg>
      </div>
      <figcaption className="small" style={{ marginTop: 10, color: INK2, lineHeight: 1.6 }}>{caption}</figcaption>
    </figure>
  )
}

function Arrow({ x1, y1, x2, y2, color = INK3, dash = false }: { x1: number; y1: number; x2: number; y2: number; color?: string; dash?: boolean }) {
  const a = Math.atan2(y2 - y1, x2 - x1)
  const s = 6
  const lx = x2 - s * Math.cos(a - 0.45)
  const ly = y2 - s * Math.sin(a - 0.45)
  const rx = x2 - s * Math.cos(a + 0.45)
  const ry = y2 - s * Math.sin(a + 0.45)
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={1.6} strokeDasharray={dash ? '4 4' : undefined} />
      <polygon points={`${x2},${y2} ${lx},${ly} ${rx},${ry}`} fill={color} />
    </g>
  )
}

function Box({ x, y, w, h, label, sub, color = INDIGO, fill = SURFACE }: { x: number; y: number; w: number; h: number; label: string; sub?: string; color?: string; fill?: string }) {
  const cx = x + w / 2
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={9} fill={fill} stroke={color} strokeWidth={1.5} />
      <text x={cx} y={sub ? y + h / 2 - 5 : y + h / 2} textAnchor="middle" dominantBaseline="central" fill={INK1} fontSize={12.5} fontWeight={500}>{label}</text>
      {sub && <text x={cx} y={y + h / 2 + 11} textAnchor="middle" dominantBaseline="central" fill={INK3} fontSize={9.5}>{sub}</text>}
    </g>
  )
}

function T({ x, y, children, color = INK3, size = 10, anchor = 'start', weight = 400 }: { x: number; y: number; children: string; color?: string; size?: number; anchor?: 'start' | 'middle' | 'end'; weight?: number }) {
  return <text x={x} y={y} textAnchor={anchor} fill={color} fontSize={size} fontWeight={weight}>{children}</text>
}

/* ────────────────────────────── concept diagrams ───────────────────────── */

/* The core idea: many depositors funnel through one shared identity. */
export function PrivacyDiagram() {
  return (
    <Figure h={300} caption="Three people deposit from three wallets. Every bet they authorize is placed by the vault's single Polymarket account, so an on-chain observer sees one trader — never which depositor is behind a given bet.">
      <Box x={16} y={36} w={104} h={42} label="Wallet A" color={GREEN} />
      <Box x={16} y={129} w={104} h={42} label="Wallet B" color={INDIGO} />
      <Box x={16} y={222} w={104} h={42} label="Wallet C" color={AMBER} />
      <T x={16} y={24} color={INK3}>depositors</T>

      <Arrow x1={120} y1={57} x2={214} y2={140} color={INK3} />
      <Arrow x1={120} y1={150} x2={214} y2={150} color={INK3} />
      <Arrow x1={120} y1={243} x2={214} y2={162} color={INK3} />
      <T x={150} y={108} color={INK3}>deposit USDC</T>

      <Box x={214} y={104} w={128} h={92} label="PolyShield" sub="shared vault" color={GOLD} fill="var(--surface-1)" />

      <Arrow x1={342} y1={140} x2={420} y2={112} color={GOLD} />
      <Box x={420} y={90} w={120} h={46} label="Vault EOA" sub="one signing key" color={GOLD} />
      <Arrow x1={480} y1={136} x2={480} y2={184} color={INK3} />
      <Box x={420} y={184} w={120} h={46} label="Polymarket" sub="public order book" color={INDIGO} />
      <T x={356} y={80} color={GOLD} size={10}>all bets, one identity</T>

      {/* observer */}
      <ellipse cx={595} cy={207} rx={17} ry={10} fill="none" stroke={INK2} strokeWidth={1.3} />
      <circle cx={595} cy={207} r={4} fill={INK2} />
      <Arrow x1={578} y1={207} x2={544} y2={207} color={INK2} dash />
      <T x={595} y={235} color={INK2} anchor="middle">observer</T>
      <T x={595} y={248} color={INK3} anchor="middle">sees only the EOA</T>
    </Figure>
  )
}

/* Deposit → bet → position → settle → withdraw as a pipeline. */
export function LifecycleDiagram() {
  const stages: [string, string, string][] = [
    ['1 · Deposit', 'USDC in', GOLD],
    ['2 · Bet', 'ZK proof', INDIGO],
    ['3 · Position', 'on Polymarket', INDIGO],
    ['4 · Settle', 'claim payout', GOLD],
    ['5 · Withdraw', 'USDC out', GOLD],
  ]
  const w = 104, gap = 20, y = 48, h = 56
  return (
    <Figure h={150} caption="The full round trip. Money enters once, moves between private notes as you bet and settle, and only ever leaves to the same wallet that deposited it.">
      {stages.map(([label, sub, color], i) => {
        const x = 16 + i * (w + gap)
        return (
          <g key={i}>
            <Box x={x} y={y} w={w} h={h} label={label} sub={sub} color={color} />
            {i < stages.length - 1 && <Arrow x1={x + w} y1={y + h / 2} x2={x + w + gap} y2={y + h / 2} color={INK3} />}
          </g>
        )
      })}
    </Figure>
  )
}

/* A note as a sealed envelope: 4 fields inside; the hash (commitment) is public,
   the nullifier is a separate one-time stamp. */
export function NoteDiagram() {
  return (
    <Figure h={300} caption="A note is private data you hold. Only its commitment (a hash) is ever stored on-chain — like depositing a sealed envelope whose contents nobody can read. The nullifier is a separate one-time stamp derived from the secret.">
      {/* envelope */}
      <rect x={18} y={56} width={210} height={188} rx={10} fill="var(--surface-1)" stroke={GOLD} strokeWidth={1.5} />
      <T x={123} y={82} color={GOLD} size={10} anchor="middle" weight={600}>SPENDING NOTE</T>
      <line x1={40} y1={94} x2={206} y2={94} stroke="var(--line)" strokeWidth={1} />
      {[
        ['secret', 'random, wallet-derived'],
        ['balance', 'USDC, 6 decimals'],
        ['nonce', 'increments per spend'],
        ['owner_address', 'your wallet'],
      ].map(([k, v], i) => (
        <g key={i}>
          <circle cx={48} cy={120 + i * 30} r={2.4} fill={GOLD} />
          <T x={60} y={124 + i * 30} color={INK1} size={12}>{k}</T>
          <T x={206} y={124 + i * 30} color={INK3} size={9} anchor="end">{v}</T>
        </g>
      ))}
      <T x={123} y={236} color={INK3} size={9} anchor="middle">lives only in your browser</T>

      {/* commitment path */}
      <Arrow x1={228} y1={108} x2={300} y2={108} color={INK3} />
      <Box x={300} y={86} w={120} h={44} label="Poseidon4()" sub="hash" color={INDIGO} />
      <Arrow x1={420} y1={108} x2={486} y2={108} color={INK3} />
      <Box x={486} y={86} w={138} h={44} label="commitment" sub="stored on the tree" color={INDIGO} />

      {/* nullifier path */}
      <Arrow x1={228} y1={196} x2={300} y2={196} color={GOLD} />
      <Box x={300} y={174} w={120} h={44} label="Poseidon2()" sub="secret + nonce" color={GOLD} />
      <Arrow x1={420} y1={196} x2={486} y2={196} color={GOLD} />
      <Box x={486} y={174} w={138} h={44} label="nullifier" sub="revealed once, on spend" color={GOLD} />
    </Figure>
  )
}

/* Merkle tree: your leaf + the gold inclusion path to the root. */
export function MerkleDiagram() {
  const root: [number, number] = [320, 48]
  const m1: [number, number] = [180, 134]
  const m2: [number, number] = [460, 134]
  const leaves: [number, number][] = [[110, 224], [250, 224], [390, 224], [530, 224]]
  const youIdx = 1
  const node = (p: [number, number], onPath: boolean, label?: string, sub?: string) => (
    <g>
      <circle cx={p[0]} cy={p[1]} r={17} fill={SURFACE} stroke={onPath ? GOLD : INDIGO} strokeWidth={onPath ? 2 : 1.4} />
      {label && <T x={p[0]} y={p[1] - 26} color={onPath ? GOLD : INK2} size={10} anchor="middle" weight={600}>{label}</T>}
      {sub && <T x={p[0]} y={p[1] + 38} color={INK3} size={9} anchor="middle">{sub}</T>}
    </g>
  )
  const edge = (a: [number, number], b: [number, number], gold: boolean) => (
    <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={gold ? GOLD : INDIGO} strokeWidth={gold ? 2.2 : 1.3} />
  )
  return (
    <Figure h={290} caption="Every note commitment is a leaf in one append-only tree. Your inclusion proof is the gold path of hashes from your leaf up to the root — it proves your note is in the set without revealing which leaf it is.">
      {/* edges (draw indigo first, gold path over) */}
      {edge(leaves[0], m1, false)}
      {edge(leaves[1], m1, true)}
      {edge(leaves[2], m2, false)}
      {edge(leaves[3], m2, false)}
      {edge(m1, root, true)}
      {edge(m2, root, false)}
      {/* nodes */}
      {node(root, true, 'root', 'on-chain')}
      {node(m1, true)}
      {node(m2, false, undefined, 'sibling')}
      {leaves.map((l, i) =>
        <g key={i}>{node(l, i === youIdx, i === youIdx ? 'your note' : undefined, i === 0 ? 'sibling' : undefined)}</g>,
      )}
    </Figure>
  )
}

/* Zero-knowledge: prover keeps the secret behind a curtain, hands over a proof,
   verifier returns valid. */
export function ZkProofDiagram() {
  return (
    <Figure h={250} caption="A zero-knowledge proof is like proving you're over 21 without showing your birthday. You convince the Vault your note is valid and well-funded — the secret stays in your browser and never crosses the line.">
      <Box x={28} y={70} w={170} h={110} label="" color={GOLD} fill="var(--surface-1)" />
      <T x={113} y={96} color={GOLD} size={11} anchor="middle" weight={600}>YOU · prover</T>
      <rect x={56} y={112} width={114} height={44} rx={7} fill="var(--bg-1)" stroke={INK3} strokeWidth={1.2} strokeDasharray="3 3" />
      <T x={113} y={130} color={INK1} size={11} anchor="middle">secret</T>
      <T x={113} y={146} color={INK3} size={9} anchor="middle">never leaves</T>

      {/* zk boundary curtain */}
      <line x1={320} y1={36} x2={320} y2={214} stroke={INK2} strokeWidth={1.3} strokeDasharray="5 5" />
      <T x={320} y={28} color={INK2} size={9} anchor="middle">zero-knowledge boundary</T>
      {/* secret blocked at boundary */}
      <line x1={170} y1={134} x2={300} y2={134} stroke={INK3} strokeWidth={1.2} strokeDasharray="3 3" />
      <circle cx={310} cy={134} r={7} fill="none" stroke={AMBER} strokeWidth={1.4} />
      <line x1={305} y1={129} x2={315} y2={139} stroke={AMBER} strokeWidth={1.4} />

      {/* proof crosses */}
      <Arrow x1={198} y1={96} x2={442} y2={96} color={GOLD} />
      <T x={320} y={86} color={GOLD} size={10} anchor="middle">proof</T>

      <Box x={442} y={70} w={170} h={110} label="" color={INDIGO} fill="var(--surface-1)" />
      <T x={527} y={96} color={INDIGO} size={11} anchor="middle" weight={600}>VAULT · verifier</T>
      <circle cx={500} cy={140} r={13} fill="none" stroke={GREEN} strokeWidth={1.6} />
      <path d="M493 140 L498 146 L508 132" fill="none" stroke={GREEN} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      <T x={527} y={166} color={INK2} size={9} anchor="middle">valid — secret unknown</T>
    </Figure>
  )
}

/* The four layers and their trust roles. */
export function ArchitectureDiagram() {
  const bands: [string, string, string, string][] = [
    ['Your browser', 'wallet · secret · proof generation', 'only party that can link you', GOLD],
    ['Proof relay + index', 'submits proofs · pays gas · serves merkle / recovery data', 'cannot forge or de-anonymize', INDIGO],
    ['Signing layer', 'holds vault EOA · places CLOB orders · resolves markets', 'centralized v1 → TEE v2', INDIGO],
    ['On-chain (Polygon)', 'Vault · Merkle tree · nullifiers · 9 verifiers', 'source of truth', GOLD],
  ]
  const x = 24, w = 592, h = 50, gap = 12
  return (
    <Figure h={4 * h + 3 * gap + 24} caption="Four layers, each with a distinct trust role. Privacy holds even if the relay and signing layer are fully compromised — they never see a secret, and the on-chain rules block theft regardless of who submits a transaction.">
      {bands.map(([title, role, trust, color], i) => {
        const y = 12 + i * (h + gap)
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h} rx={9} fill={SURFACE} stroke="var(--line-strong)" strokeWidth={1} />
            <rect x={x} y={y} width={4} height={h} rx={2} fill={color} />
            <T x={x + 18} y={y + 21} color={INK1} size={12.5} weight={600}>{title}</T>
            <T x={x + 18} y={y + 37} color={INK3} size={10}>{role}</T>
            <T x={x + w - 16} y={y + h / 2 + 3} color={color} size={10} anchor="end">{trust}</T>
          </g>
        )
      })}
    </Figure>
  )
}

/* Beginner primer: what a prediction market share is. */
export function PredictionMarketDiagram() {
  return (
    <Figure h={236} caption="A prediction market turns a question into shares. The price of a YES share is the market's estimate of the odds. Each share pays out $1 if its outcome is right and $0 if it's wrong — so buying YES at 63¢ and being right returns 37¢ of profit.">
      <T x={70} y={28} color={INK3} size={10}>PREDICTION MARKET</T>
      <rect x={70} y={36} width={500} height={44} rx={9} fill="var(--surface-1)" stroke={INDIGO} strokeWidth={1.5} />
      <text x={320} y={58} textAnchor="middle" dominantBaseline="central" fill={INK1} fontSize={13} fontWeight={500}>&quot;Will event X happen by Friday?&quot;</text>

      <rect x={110} y={106} width={190} height={78} rx={9} fill={SURFACE} stroke={GREEN} strokeWidth={1.6} />
      <text x={205} y={134} textAnchor="middle" fill={GREEN} fontSize={18} fontWeight={600}>YES</text>
      <T x={205} y={158} color={INK1} size={12} anchor="middle">63¢ per share</T>
      <T x={205} y={174} color={INK3} size={9.5} anchor="middle">= 63% implied odds</T>

      <rect x={340} y={106} width={190} height={78} rx={9} fill={SURFACE} stroke="var(--red)" strokeWidth={1.6} />
      <text x={435} y={134} textAnchor="middle" fill="var(--red)" fontSize={18} fontWeight={600}>NO</text>
      <T x={435} y={158} color={INK1} size={12} anchor="middle">37¢ per share</T>
      <T x={435} y={174} color={INK3} size={9.5} anchor="middle">= 37% implied odds</T>

      <T x={320} y={214} color={INK2} size={10.5} anchor="middle">each winning share settles to $1.00 · each losing share to $0.00</T>
    </Figure>
  )
}

/* Beginner contrast: account/balance model vs note/UTXO (cash) model. */
export function AccountVsNotesDiagram() {
  const chip = (x: number, y: number, label: string, color: string, sub?: string) => (
    <g>
      <rect x={x} y={y} width={78} height={40} rx={7} fill={SURFACE} stroke={color} strokeWidth={1.4} />
      <text x={x + 39} y={sub ? y + 16 : y + 21} textAnchor="middle" dominantBaseline="central" fill={INK1} fontSize={12.5} fontWeight={600}>{label}</text>
      {sub && <text x={x + 39} y={y + 30} textAnchor="middle" fill={INK3} fontSize={8.5}>{sub}</text>}
    </g>
  )
  return (
    <Figure h={244} caption="An account keeps one running balance and edits it in place — a single record that's easy to track over time. PolyShield holds your money as notes, like cash: spending destroys the note you used and mints a fresh change note, so there's no persistent trail to follow.">
      <line x1={320} y1={22} x2={320} y2={224} stroke="var(--line-strong)" strokeWidth={1} strokeDasharray="4 5" />

      {/* left: account model */}
      <T x={30} y={28} color={INK2} size={10.5} weight={600}>ACCOUNT MODEL</T>
      <T x={30} y={43} color={INK3} size={9.5}>a bank account · your MetaMask</T>
      <Box x={36} y={62} w={210} h={44} label="Balance: $100" color={INDIGO} />
      <Arrow x1={141} y1={106} x2={141} y2={148} color={INK3} />
      <T x={152} y={132} color={INK3} size={9.5}>spend $30</T>
      <Box x={36} y={148} w={210} h={44} label="Balance: $70" color={INDIGO} />
      <T x={36} y={218} color={INK3} size={9.5}>one number, edited in place</T>

      {/* right: note / UTXO model */}
      <T x={352} y={28} color={GOLD} size={10.5} weight={600}>NOTE MODEL</T>
      <T x={352} y={43} color={INK3} size={9.5}>like cash · &quot;UTXO&quot;</T>
      {chip(360, 60, '$40', GREEN)}
      {chip(450, 60, '$60', GREEN)}
      <T x={544} y={84} color={INK3} size={10}>= $100</T>
      <Arrow x1={470} y1={104} x2={470} y2={146} color={INK3} />
      <T x={481} y={130} color={INK3} size={9.5}>spend $30</T>
      {chip(360, 150, '$40', GREEN, 'kept')}
      {chip(450, 150, '$30', GOLD, 'change')}
      <T x={544} y={172} color={INK3} size={10}>= $70</T>
      <T x={352} y={218} color={INK3} size={9.5}>old note destroyed · change note minted</T>
    </Figure>
  )
}

/* Spending = nullify the old note, mint a fresh note for the change. */
export function SpendDiagram() {
  return (
    <Figure h={250} caption="Spending never edits a note — it destroys the old one (publishing its nullifier so it can never be reused) and creates a brand-new note for the change. Like tearing up a $100 check and writing a fresh one for the leftover balance.">
      <Box x={20} y={88} w={150} h={74} label="old note" sub="balance $100" color={INDIGO} fill="var(--surface-1)" />
      <line x1={28} y1={156} x2={162} y2={94} stroke={AMBER} strokeWidth={1.6} />
      <T x={95} y={182} color={AMBER} size={9} anchor="middle">nullifier published — voided</T>

      <Arrow x1={170} y1={120} x2={236} y2={120} color={INK3} />
      <Box x={236} y={94} w={128} h={52} label="BET_AUTH" sub="zk proof" color={GOLD} />

      <Arrow x1={364} y1={108} x2={430} y2={66} color={GOLD} />
      <Box x={430} y={40} w={186} h={50} label="bet → Polymarket" sub="via the vault EOA" color={INDIGO} />

      <Arrow x1={364} y1={132} x2={430} y2={168} color={INK3} />
      <Box x={430} y={150} w={186} h={56} label="new note (change)" sub="$100 − bet − fee" color={INDIGO} fill="var(--surface-1)" />
    </Figure>
  )
}
