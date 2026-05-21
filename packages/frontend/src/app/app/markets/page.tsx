'use client'
import { useState, useMemo } from 'react'
import Link from 'next/link'
import { Icon, ICONS } from '@/components/ui/Icon'
import { Sparkline } from '@/components/ui/Sparkline'

const MARKETS = [
  { id: 'fed-cut-dec', cat: 'MACRO', name: 'Fed cuts rates in December meeting?', yes: 0.71, delta: 0.046, vol: 24.7e6, liq: 4.2e6, traders: 4210, resolves: 'Dec 17, 2026', trend: [0.55,0.58,0.60,0.62,0.64,0.66,0.68,0.69,0.70,0.70,0.71] },
  { id: 'trump-pardon', cat: 'POLITICS', name: 'Will Trump pardon all Jan 6 defendants by EOY 2026?', yes: 0.62, delta: 0.021, vol: 12.4e6, liq: 2.1e6, traders: 2810, resolves: 'Dec 31, 2026', trend: [0.40,0.45,0.50,0.53,0.55,0.57,0.59,0.60,0.61,0.61,0.62] },
  { id: 'btc-150k', cat: 'CRYPTO', name: 'BTC closes above $150k on Dec 31, 2026?', yes: 0.41, delta: 0.008, vol: 38.2e6, liq: 6.4e6, traders: 5102, resolves: 'Dec 31, 2026', trend: [0.32,0.34,0.36,0.38,0.39,0.40,0.40,0.41,0.41,0.41,0.41] },
  { id: 'openai-ipo', cat: 'TECH', name: 'OpenAI IPO files S-1 before Q4 2026?', yes: 0.28, delta: -0.012, vol: 8.9e6, liq: 1.2e6, traders: 1612, resolves: 'Sep 30, 2026', trend: [0.40,0.38,0.36,0.34,0.32,0.31,0.30,0.29,0.29,0.28,0.28] },
  { id: 'ethbtc-05', cat: 'CRYPTO', name: 'ETH/BTC ratio above 0.05 by Q3 close?', yes: 0.18, delta: -0.003, vol: 4.1e6, liq: 0.6e6, traders: 941, resolves: 'Sep 30, 2026', trend: [0.27,0.25,0.23,0.22,0.21,0.20,0.19,0.19,0.18,0.18,0.18] },
  { id: 'russia-ukraine', cat: 'GEO', name: 'Russia–Ukraine ceasefire signed in 2026?', yes: 0.33, delta: 0.015, vol: 11.0e6, liq: 1.8e6, traders: 2104, resolves: 'Dec 31, 2026', trend: [0.20,0.24,0.27,0.29,0.30,0.31,0.32,0.32,0.33,0.33,0.33] },
  { id: 'us-recession', cat: 'MACRO', name: 'NBER declares US recession in 2026?', yes: 0.22, delta: -0.008, vol: 9.4e6, liq: 1.4e6, traders: 1820, resolves: 'Dec 31, 2026', trend: [0.30,0.28,0.27,0.26,0.25,0.24,0.24,0.23,0.22,0.22,0.22] },
  { id: 'sb60-49ers', cat: 'SPORTS', name: '49ers win Super Bowl LX?', yes: 0.14, delta: 0.004, vol: 6.2e6, liq: 0.9e6, traders: 1480, resolves: 'Feb 8, 2026', trend: [0.10,0.11,0.12,0.12,0.13,0.13,0.13,0.14,0.14,0.14,0.14] },
  { id: 'agi-2026', cat: 'TECH', name: 'Any frontier lab declares AGI in 2026?', yes: 0.09, delta: 0.001, vol: 7.7e6, liq: 0.7e6, traders: 1330, resolves: 'Dec 31, 2026', trend: [0.05,0.06,0.07,0.08,0.08,0.08,0.09,0.09,0.09,0.09,0.09] },
  { id: 'eth-eip', cat: 'CRYPTO', name: 'Ethereum hard fork ships by Sep 2026?', yes: 0.58, delta: 0.012, vol: 3.4e6, liq: 0.5e6, traders: 880, resolves: 'Sep 30, 2026', trend: [0.50,0.52,0.53,0.54,0.55,0.56,0.57,0.57,0.58,0.58,0.58] },
  { id: 'china-tw', cat: 'GEO', name: 'China military exercises around Taiwan in 2026?', yes: 0.84, delta: 0.022, vol: 5.6e6, liq: 0.8e6, traders: 1142, resolves: 'Dec 31, 2026', trend: [0.75,0.77,0.79,0.80,0.81,0.82,0.83,0.83,0.84,0.84,0.84] },
  { id: 'nobel-physics', cat: 'CULTURE', name: 'Nobel Physics 2026 awarded to quantum-computing researcher?', yes: 0.31, delta: 0.006, vol: 1.2e6, liq: 0.2e6, traders: 412, resolves: 'Oct 6, 2026', trend: [0.25,0.26,0.27,0.28,0.28,0.29,0.30,0.30,0.30,0.31,0.31] },
]

const CATEGORIES = ['ALL', 'POLITICS', 'CRYPTO', 'MACRO', 'TECH', 'GEO', 'SPORTS', 'CULTURE']
const SORTS = ['Volume', 'Liquidity', 'Δ24h', 'Resolves soon', 'New']

function fmtVol(v: number) {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v}`
}

function MarketCard({ m }: { m: typeof MARKETS[0] }) {
  const pct = m.yes * 100
  return (
    <Link href={`/app/market/${m.id}`} style={{ textDecoration: 'none' }}>
      <div className="panel" style={{ padding: 0, overflow: 'hidden', cursor: 'pointer', transition: 'border-color .15s' }}>
        <div style={{ padding: '16px 18px 12px' }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <span className="pill pill-soft" style={{ fontSize: 9 }}>{m.cat}</span>
            <span className="small" style={{ fontSize: 11 }}>resolves {m.resolves}</span>
          </div>
          <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.4, minHeight: 40 }}>{m.name}</div>
          <div className="row mt-3" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div>
              <div className="row gap-4">
                <div>
                  <div className="micro" style={{ fontSize: 9 }}>YES</div>
                  <div className="num" style={{ fontSize: 20, color: 'var(--green)' }}>{m.yes.toFixed(2)}</div>
                </div>
                <div>
                  <div className="micro" style={{ fontSize: 9 }}>NO</div>
                  <div className="num" style={{ fontSize: 20, color: 'var(--red)' }}>{(1 - m.yes).toFixed(2)}</div>
                </div>
                <div>
                  <div className="micro" style={{ fontSize: 9 }}>Δ24h</div>
                  <div className="num" style={{ fontSize: 14, color: m.delta >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {m.delta >= 0 ? '+' : '−'}{(Math.abs(m.delta) * 100).toFixed(1)}%
                  </div>
                </div>
              </div>
            </div>
            <Sparkline data={m.trend} width={80} height={28} color={m.delta >= 0 ? 'var(--green)' : 'var(--red)'} />
          </div>
          {/* prob bar */}
          <div style={{ height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 12 }}>
            <div style={{ height: 3, width: `${pct}%`, background: 'var(--green)', borderRadius: 2 }} />
          </div>
        </div>
        <div className="row hairline-t" style={{ padding: '10px 18px', justifyContent: 'space-between' }}>
          <span className="small" style={{ fontSize: 11 }}>{fmtVol(m.vol)} vol · {m.traders.toLocaleString()} traders</span>
          <div className="row gap-2">
            <button className="btn btn-sm" style={{ padding: '4px 10px', fontSize: 11, background: 'oklch(0.78 0.16 152 / 0.08)', borderColor: 'oklch(0.78 0.16 152 / 0.3)', color: 'var(--green)' }}
              onClick={(e) => e.preventDefault()}>YES</button>
            <button className="btn btn-sm" style={{ padding: '4px 10px', fontSize: 11, background: 'oklch(0.70 0.18 25 / 0.08)', borderColor: 'oklch(0.70 0.18 25 / 0.3)', color: 'var(--red)' }}
              onClick={(e) => e.preventDefault()}>NO</button>
          </div>
        </div>
      </div>
    </Link>
  )
}

function MarketListRow({ m }: { m: typeof MARKETS[0] }) {
  return (
    <tr>
      <td style={{ color: 'var(--text)' }}><Link href={`/app/market/${m.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>{m.name}</Link></td>
      <td><span className="pill pill-soft" style={{ fontSize: 9 }}>{m.cat}</span></td>
      <td style={{ textAlign: 'right' }} className="num">{m.yes.toFixed(2)}</td>
      <td style={{ textAlign: 'right', color: m.delta >= 0 ? 'var(--green)' : 'var(--red)' }} className="num">{m.delta >= 0 ? '+' : '−'}{(Math.abs(m.delta) * 100).toFixed(1)}%</td>
      <td style={{ textAlign: 'right' }} className="num">{fmtVol(m.vol)}</td>
      <td style={{ textAlign: 'right' }} className="num">{m.traders.toLocaleString()}</td>
      <td><Sparkline data={m.trend} width={80} height={20} color={m.delta >= 0 ? 'var(--green)' : 'var(--red)'} /></td>
      <td>
        <div className="row gap-1">
          <button className="btn btn-sm" style={{ padding: '4px 8px', fontSize: 10, background: 'oklch(0.78 0.16 152 / 0.08)', borderColor: 'oklch(0.78 0.16 152 / 0.3)', color: 'var(--green)' }}>YES</button>
          <button className="btn btn-sm" style={{ padding: '4px 8px', fontSize: 10, background: 'oklch(0.70 0.18 25 / 0.08)', borderColor: 'oklch(0.70 0.18 25 / 0.3)', color: 'var(--red)' }}>NO</button>
        </div>
      </td>
    </tr>
  )
}

export default function MarketsPage() {
  const [cat, setCat] = useState('ALL')
  const [sort, setSort] = useState('Volume')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    let arr = MARKETS.slice()
    if (cat !== 'ALL') arr = arr.filter((m) => m.cat === cat)
    if (search) arr = arr.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()))
    if (sort === 'Volume') arr.sort((a, b) => b.vol - a.vol)
    else if (sort === 'Liquidity') arr.sort((a, b) => b.liq - a.liq)
    else if (sort === 'Δ24h') arr.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    return arr
  }, [cat, sort, search])

  return (
    <div>
      {/* Top bar */}
      <div className="row hairline-b" style={{ padding: '14px 24px', justifyContent: 'space-between' }}>
        <div className="row gap-4">
          <div className="micro">MARKETS</div>
          <span className="pill pill-soft" style={{ fontSize: 10 }}>{MARKETS.length} markets</span>
        </div>
        <div className="row gap-3">
          <div className="row gap-2 panel" style={{ padding: '6px 10px', borderRadius: 6 }}>
            <Icon d={ICONS.search} size={12} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search markets…"
              style={{ background: 'transparent', border: 'none', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, width: 180 }} />
          </div>
          <div className="row gap-1">
            {(['grid', 'list'] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} className={`btn btn-sm ${view === v ? 'btn-cyan' : 'btn-ghost'}`} style={{ padding: '6px 10px' }}>
                <Icon d={v === 'grid' ? ICONS.dashboard : ICONS.analytics} size={13} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ padding: 24 }}>
        {/* Category tabs */}
        <div className="row gap-2" style={{ marginBottom: 16 }}>
          {CATEGORIES.map((c) => (
            <button key={c} onClick={() => setCat(c)} className={`btn btn-sm ${cat === c ? 'btn-cyan' : ''}`} style={{ fontSize: 11 }}>{c}</button>
          ))}
          <div style={{ flex: 1 }} />
          <select value={sort} onChange={(e) => setSort(e.target.value)}
            style={{ background: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: 6, color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, padding: '6px 10px' }}>
            {SORTS.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>

        {view === 'grid' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {filtered.map((m) => <MarketCard key={m.id} m={m} />)}
          </div>
        ) : (
          <div className="panel" style={{ padding: 0 }}>
            <table className="tbl">
              <thead><tr>
                <th>Market</th><th>Cat</th>
                <th style={{ textAlign: 'right' }}>YES</th>
                <th style={{ textAlign: 'right' }}>Δ24h</th>
                <th style={{ textAlign: 'right' }}>Vol</th>
                <th style={{ textAlign: 'right' }}>Traders</th>
                <th>Trend</th><th></th>
              </tr></thead>
              <tbody>{filtered.map((m) => <MarketListRow key={m.id} m={m} />)}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
