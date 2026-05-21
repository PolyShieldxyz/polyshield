'use client'
import { useState, useMemo } from 'react'
import Link from 'next/link'
import { Icon, ICONS } from '@/components/ui/Icon'
import { Stat } from '@/components/ui/Stat'
import { Sparkline } from '@/components/ui/Sparkline'

function ProbabilityChart() {
  const w = 600, h = 240
  const data = useMemo(() => {
    const pts: number[] = []
    let p = 0.55
    for (let i = 0; i < 80; i++) {
      p += (Math.sin(i * 0.4) + (Math.random() - 0.5)) * 0.012
      p = Math.max(0.45, Math.min(0.78, p))
      pts.push(p)
    }
    return pts
  }, [])
  const xs = (i: number) => 40 + (i / (data.length - 1)) * (w - 60)
  const ys = (v: number) => h - 20 - (v - 0.4) / 0.4 * (h - 50)
  const line = data.map((v, i) => `${xs(i)},${ys(v)}`).join(' ')
  const area = `M${xs(0)},${h - 20} L${line.split(' ').join(' L')} L${xs(data.length - 1)},${h - 20} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="240">
      {[0.4, 0.5, 0.6, 0.7, 0.8].map((v) => (
        <g key={v}>
          <line x1="40" y1={ys(v)} x2={w - 20} y2={ys(v)} stroke="rgba(255,255,255,0.05)" />
          <text x="32" y={ys(v) + 3} textAnchor="end" fontFamily="JetBrains Mono" fontSize="9" fill="rgba(255,255,255,0.4)">{v.toFixed(2)}</text>
        </g>
      ))}
      <polyline points={line} fill="none" stroke="oklch(0.82 0.13 210)" strokeWidth="1.5" />
      <path d={area} fill="oklch(0.82 0.13 210 / 0.08)" />
      <circle cx={xs(data.length - 1)} cy={ys(data[data.length - 1])} r="4" fill="oklch(0.82 0.13 210)" />
      {['12h', '8h', '4h', 'now'].map((l, i) => (
        <text key={l} x={40 + (i / 3) * (w - 60)} y={h - 4} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="rgba(255,255,255,0.35)">{l}</text>
      ))}
    </svg>
  )
}

const ACTIVITY = [
  { t: '14:02:18', k: 'BET-AUTH', m: 'FED-CUT-DEC', a: '$4,250', s: 'VERIFIED', c: 'cyan' },
  { t: '14:01:51', k: 'VAULT-FILL', m: 'TRUMP-2024', a: '$12,400', s: 'FILLED', c: 'green' },
  { t: '13:59:04', k: 'DEPOSIT', m: 'note 0x91…', a: '$25,000', s: 'CONFIRMED', c: 'cyan' },
  { t: '13:57:22', k: 'SETTLE', m: 'GPT5-RELEASE', a: '+$18,720', s: 'CREDIT', c: 'green' },
  { t: '13:55:10', k: 'BET-AUTH', m: 'OPENAI-IPO', a: '$850', s: 'VERIFIED', c: 'cyan' },
  { t: '13:54:08', k: 'WITHDRAW', m: 'note 0x4b…', a: '$8,000', s: 'RELAY', c: 'amber' },
]

export default function PortfolioPage() {
  const [selected, setSelected] = useState(3)
  const markets = [
    { cat: 'MACRO', name: 'Fed cuts rates in December meeting?', yes: 0.71, delta: '+ 4.6', vol: '24.7M', trend: [0.62, 0.64, 0.66, 0.68, 0.69, 0.70, 0.71] },
    { cat: 'POLITICS', name: 'Will Trump pardon all Jan 6 defendants?', yes: 0.62, delta: '+ 2.1', vol: '12.4M', trend: [0.55, 0.57, 0.59, 0.60, 0.61, 0.62, 0.62] },
    { cat: 'CRYPTO', name: 'BTC closes above $150k on Dec 31, 2026?', yes: 0.41, delta: '+ 0.8', vol: '38.2M', trend: [0.35, 0.37, 0.38, 0.40, 0.40, 0.41, 0.41] },
  ]

  return (
    <div>
      {/* Top bar */}
      <div className="row hairline-b" style={{ padding: '14px 24px', justifyContent: 'space-between' }}>
        <div className="row gap-4">
          <div className="micro">PORTFOLIO</div>
          <div className="row gap-2 mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>
            <span>BLOCK</span><span style={{ color: 'var(--text-1)' }}>21,448,072</span>
            <span style={{ marginLeft: 12 }}>RELAY</span><span style={{ color: 'var(--green)' }}>● ONLINE</span>
          </div>
        </div>
        <div className="row gap-3">
          <Link href="/app/bet" className="btn btn-sm btn-cyan" style={{ textDecoration: 'none' }}>
            <Icon d={ICONS.plus} size={12} /> New private bet
          </Link>
        </div>
      </div>

      {/* Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, padding: 24 }}>
        <Stat label="Vault balance" value={482140} prefix="$" sub="+ 12,400 last 24h" accent="var(--green)" sparkline={[430, 432, 440, 438, 460, 472, 475, 482, 482.1]} />
        <Stat label="Unrealized PnL" value={38420} prefix="+ $" sub="+ 8.7% on capital" accent="var(--green)" sparkline={[10, 15, 22, 20, 28, 32, 35, 38, 38.4]} />
        <Stat label="Privacy score" value={94.2} decimals={1} sub="k-anon 1,842" accent="var(--cyan)" sparkline={[80, 82, 85, 88, 90, 91, 93, 94, 94.2]} />
        <Stat label="Pending proofs" value={2} sub="~ 142ms eta" accent="var(--amber)" sparkline={[1, 0, 2, 3, 1, 2, 4, 2, 2]} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 12, padding: '0 24px 24px' }}>
        <div className="col gap-3">
          {/* Chart panel */}
          <div className="panel">
            <div className="row hairline-b" style={{ padding: '12px 16px', justifyContent: 'space-between' }}>
              <div className="row gap-3">
                <span className="pill pill-soft" style={{ fontSize: 10 }}>MACRO</span>
                <span style={{ fontSize: 14 }}>Fed cuts rates in December meeting?</span>
              </div>
              <div className="row gap-3">
                <div className="num" style={{ fontSize: 24, color: 'var(--cyan)' }}>0.71</div>
                <span className="pill pill-green" style={{ fontSize: 10 }}>YES</span>
              </div>
            </div>
            <ProbabilityChart />
          </div>

          {/* Market table */}
          <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="row hairline-b" style={{ padding: '12px 16px', justifyContent: 'space-between' }}>
              <div className="micro">OPEN POSITIONS</div>
              <Link href="/app/markets" className="btn btn-sm btn-ghost" style={{ textDecoration: 'none' }}>All markets →</Link>
            </div>
            <table className="tbl">
              <thead><tr>
                <th>Market</th><th>Cat</th><th style={{ textAlign: 'right' }}>YES</th><th style={{ textAlign: 'right' }}>Δ 24h</th><th style={{ textAlign: 'right' }}>Vol</th><th>Trend</th>
              </tr></thead>
              <tbody>
                {markets.map((m, i) => (
                  <tr key={i} onClick={() => setSelected(i)} style={{ cursor: 'pointer', background: selected === i ? 'rgba(255,255,255,0.025)' : 'transparent' }}>
                    <td style={{ color: 'var(--text)' }}>{m.name}</td>
                    <td><span className="pill pill-soft" style={{ fontSize: 9 }}>{m.cat}</span></td>
                    <td style={{ textAlign: 'right' }} className="num">{m.yes.toFixed(2)}</td>
                    <td style={{ textAlign: 'right', color: m.delta.startsWith('+') ? 'var(--green)' : 'var(--red)' }} className="num">{m.delta}</td>
                    <td style={{ textAlign: 'right' }} className="num">{m.vol}</td>
                    <td><Sparkline data={m.trend} width={80} height={20} color={m.delta.startsWith('+') ? 'var(--green)' : 'var(--red)'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Activity feed */}
          <div className="panel" style={{ padding: 0 }}>
            <div className="row hairline-b" style={{ padding: '12px 16px', justifyContent: 'space-between' }}>
              <div className="micro">VAULT ACTIVITY</div>
              <Link href="/app/proofs" className="btn btn-sm btn-ghost" style={{ textDecoration: 'none' }}>All proofs →</Link>
            </div>
            <table className="tbl">
              <thead><tr><th>Time</th><th>Kind</th><th>Subject</th><th style={{ textAlign: 'right' }}>Amount</th><th>State</th></tr></thead>
              <tbody>
                {ACTIVITY.map((r, i) => (
                  <tr key={i}>
                    <td className="mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>{r.t}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{r.k}</td>
                    <td>{r.m}</td>
                    <td style={{ textAlign: 'right' }} className="num">{r.a}</td>
                    <td><span className={`pill pill-${r.c}`} style={{ fontSize: 10 }}>{r.s}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right column: order ticket */}
        <div className="col gap-3">
          <div className="panel" style={{ padding: 0 }}>
            <div className="row hairline-b" style={{ padding: '12px 16px', justifyContent: 'space-between' }}>
              <div className="micro">PLACE PRIVATE BET</div>
              <span className="pill pill-cyan" style={{ fontSize: 10 }}><span className="dot" />&nbsp;ZK-AUTH</span>
            </div>
            <div style={{ padding: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {['YES', 'NO'].map((s) => (
                  <Link key={s} href="/app/bet" className="btn" style={{ justifyContent: 'center', padding: '14px 0', textDecoration: 'none',
                    background: s === 'YES' ? 'oklch(0.78 0.16 152 / 0.12)' : 'transparent',
                    borderColor: s === 'YES' ? 'oklch(0.78 0.16 152 / 0.6)' : 'var(--line-strong)',
                    color: s === 'YES' ? 'var(--green)' : 'var(--text-1)', fontSize: 13, fontWeight: 500 }}>
                    {s} · {s === 'YES' ? '0.71' : '0.29'}
                  </Link>
                ))}
              </div>
              <div className="row hairline-b" style={{ padding: '12px 0', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                <div>
                  <div className="micro">AMOUNT (USDC)</div>
                  <div className="small" style={{ fontSize: 11, marginTop: 4 }}>vault available: $482,140</div>
                </div>
                <div className="num" style={{ fontSize: 16 }}>$1,000</div>
              </div>
              <div className="hairline-t mt-3" style={{ paddingTop: 12 }}>
                {[['Proof generation', '~142ms local', 'var(--cyan)'], ['Relay route', '3 hops · randomized', 'var(--text-1)'], ['Privacy budget', 'k-anon 1,842 · safe', 'var(--green)']].map(([l, v, c]) => (
                  <div key={l as string} className="row mt-1" style={{ justifyContent: 'space-between' }}>
                    <span className="small">{l}</span>
                    <span className="mono" style={{ fontSize: 12, color: c as string }}>{v}</span>
                  </div>
                ))}
              </div>
              <Link href="/app/bet" className="btn btn-primary mt-4" style={{ width: '100%', justifyContent: 'center', padding: '14px 0', fontSize: 14, textDecoration: 'none' }}>
                Generate ZK proof & authorize
              </Link>
            </div>
          </div>

          {/* Privacy posture */}
          <div className="panel" style={{ padding: 20 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="micro">PRIVACY POSTURE</div>
              <Link href="/app/privacy" className="btn btn-sm btn-ghost" style={{ textDecoration: 'none', fontSize: 11 }}>Full breakdown →</Link>
            </div>
            <div className="row mt-3" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <div className="num" style={{ fontSize: 32, color: 'var(--cyan)' }}>94.2</div>
              <Sparkline data={[80, 82, 85, 88, 90, 91, 93, 94, 94.2]} width={100} height={32} />
            </div>
            <div className="small mt-1">k-anonymity score · 1,842 in set</div>
            <div className="col mt-3 gap-2">
              {[['Anon set', '1,842', 'var(--cyan)'], ['Timing entropy', '7.4 bits', 'var(--text-1)'], ['Decoy density', '12.3%', 'var(--text-1)']].map(([l, v, c]) => (
                <div key={l as string} className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="small" style={{ fontSize: 12 }}>{l}</span>
                  <span className="mono" style={{ fontSize: 12, color: c as string }}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
