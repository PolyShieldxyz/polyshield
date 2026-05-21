'use client'
import { useState, useMemo } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Icon, ICONS } from '@/components/ui/Icon'
import { Sparkline } from '@/components/ui/Sparkline'

const MARKETS = [
  { id: 'fed-cut-dec', cat: 'MACRO', name: 'Fed cuts rates in December meeting?', yes: 0.71, delta: 0.046, vol: 24.7e6, liq: 4.2e6, traders: 4210, resolves: 'Dec 17, 2026', trend: [0.55,0.58,0.60,0.62,0.64,0.66,0.68,0.69,0.70,0.70,0.71], desc: 'Will the FOMC cut the federal funds target rate by at least 25bps at the December 17, 2026 meeting?', sources: ['FOMC press release', 'CME FedWatch', 'NY Fed implementation note'] },
  { id: 'trump-pardon', cat: 'POLITICS', name: 'Will Trump pardon all Jan 6 defendants by EOY 2026?', yes: 0.62, delta: 0.021, vol: 12.4e6, liq: 2.1e6, traders: 2810, resolves: 'Dec 31, 2026', trend: [0.40,0.45,0.50,0.53,0.55,0.57,0.59,0.60,0.61,0.61,0.62], desc: 'Resolves YES if every defendant convicted in connection with January 6, 2021 events receives a federal pardon by Dec 31, 2026.', sources: ['DOJ filings', 'White House press releases'] },
  { id: 'btc-150k', cat: 'CRYPTO', name: 'BTC closes above $150k on Dec 31, 2026?', yes: 0.41, delta: 0.008, vol: 38.2e6, liq: 6.4e6, traders: 5102, resolves: 'Dec 31, 2026', trend: [0.32,0.34,0.36,0.38,0.39,0.40,0.40,0.41,0.41,0.41,0.41], desc: 'Resolves YES if the Coinbase BTC/USD daily close on Dec 31, 2026 is ≥ $150,000.', sources: ['Coinbase API', 'Kraken API · tiebreaker'] },
]

function fmtVol(v: number) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v}`
}

function FullChart({ trend }: { trend: number[] }) {
  const w = 680, h = 280
  const data = useMemo(() => {
    const pts: number[] = []
    let p = trend[0]
    for (let i = 0; i < 120; i++) {
      p += (Math.sin(i * 0.3) + (Math.random() - 0.5)) * 0.008
      p = Math.max(0.05, Math.min(0.98, p))
      pts.push(p)
    }
    trend.forEach((v) => pts.push(v))
    return pts
  }, [])
  const xs = (i: number) => 48 + (i / (data.length - 1)) * (w - 72)
  const ys = (v: number) => h - 28 - v * (h - 56)
  const line = data.map((v, i) => `${xs(i)},${ys(v)}`).join(' ')
  const area = `M${xs(0)},${h - 28} L${line.split(' ').join(' L')} L${xs(data.length - 1)},${h - 28} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="280">
      {[0.2, 0.4, 0.6, 0.8].map((v) => (
        <g key={v}>
          <line x1="48" y1={ys(v)} x2={w - 24} y2={ys(v)} stroke="rgba(255,255,255,0.05)" />
          <text x="40" y={ys(v) + 3} textAnchor="end" fontFamily="JetBrains Mono" fontSize="9" fill="rgba(255,255,255,0.4)">{v.toFixed(2)}</text>
        </g>
      ))}
      <path d={area} fill="oklch(0.82 0.13 210 / 0.07)" />
      <polyline points={line} fill="none" stroke="oklch(0.82 0.13 210)" strokeWidth="1.5" />
      <circle cx={xs(data.length - 1)} cy={ys(data[data.length - 1])} r="4" fill="oklch(0.82 0.13 210)" />
      {['3mo', '2mo', '1mo', '2wk', 'now'].map((l, i) => (
        <text key={l} x={48 + (i / 4) * (w - 72)} y={h - 8} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="rgba(255,255,255,0.35)">{l}</text>
      ))}
    </svg>
  )
}

const ORDER_ASKS = [[0.73, 4200, 4200], [0.72, 3100, 7300], [0.715, 1800, 9100], [0.71, 6400, 15500]]
const ORDER_BIDS = [[0.705, 5200, 5200], [0.70, 8300, 13500], [0.695, 2100, 15600], [0.69, 4400, 20000]]

function OrderBook() {
  const Row = ({ side, p, q, cum }: { side: string; p: number; q: number; cum: number }) => (
    <div className="row" style={{ position: 'relative', padding: '5px 12px', fontSize: 12, fontFamily: 'var(--mono)' }}>
      <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: `${(cum / 20000) * 100}%`, background: side === 'ask' ? 'oklch(0.70 0.18 25 / 0.06)' : 'oklch(0.78 0.16 152 / 0.06)' }} />
      <div style={{ position: 'relative', width: 60, color: side === 'ask' ? 'var(--red)' : 'var(--green)' }}>{p.toFixed(3)}</div>
      <div style={{ position: 'relative', flex: 1, textAlign: 'right' }}>{q.toLocaleString()}</div>
      <div style={{ position: 'relative', width: 70, textAlign: 'right', color: 'var(--text-2)' }}>{cum.toLocaleString()}</div>
    </div>
  )
  return (
    <div>
      <div className="row" style={{ padding: '8px 12px', fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--mono)', letterSpacing: '0.06em' }}>
        <div style={{ width: 60 }}>PRICE</div>
        <div style={{ flex: 1, textAlign: 'right' }}>SIZE</div>
        <div style={{ width: 70, textAlign: 'right' }}>CUMUL</div>
      </div>
      {ORDER_ASKS.map((a, i) => <Row key={`a${i}`} side="ask" p={a[0]} q={a[1]} cum={a[2]} />)}
      <div className="row hairline-t hairline-b" style={{ padding: '6px 12px', justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: 12 }}>
        <span style={{ color: 'var(--cyan)' }}>0.7075</span>
        <span style={{ color: 'var(--text-2)' }}>spread 0.005</span>
      </div>
      {ORDER_BIDS.map((b, i) => <Row key={`b${i}`} side="bid" p={b[0]} q={b[1]} cum={b[2]} />)}
    </div>
  )
}

const FILLS = [
  { time: '14:02:08', side: 'YES', price: 0.71, size: 4250, vault: true },
  { time: '14:01:33', side: 'NO', price: 0.29, size: 800, vault: false },
  { time: '14:00:55', side: 'YES', price: 0.709, size: 12400, vault: true },
  { time: '13:59:41', side: 'YES', price: 0.708, size: 2100, vault: false },
  { time: '13:58:20', side: 'NO', price: 0.292, size: 5500, vault: false },
]

export default function MarketDetailPage() {
  const params = useParams()
  const id = params.id as string
  const m = MARKETS.find((x) => x.id === id) || MARKETS[0]
  const [tab, setTab] = useState('book')
  const [side, setSide] = useState<'YES' | 'NO'>('YES')
  const [amount, setAmount] = useState(1000)
  const price = side === 'YES' ? m.yes : 1 - m.yes
  const shares = Math.floor(amount / price)

  return (
    <div>
      {/* Top bar */}
      <div className="row hairline-b" style={{ padding: '12px 24px', justifyContent: 'space-between' }}>
        <div className="row gap-3">
          <Link href="/app/markets" className="btn btn-sm btn-ghost" style={{ textDecoration: 'none' }}>← Markets</Link>
          <span style={{ color: 'var(--line-strong)' }}>·</span>
          <span className="pill pill-soft" style={{ fontSize: 9 }}>{m.cat}</span>
          <span style={{ fontSize: 13, color: 'var(--text-1)' }}>{m.name}</span>
        </div>
        <div className="row gap-3">
          <span className="small" style={{ fontSize: 12 }}>Resolves {m.resolves}</span>
          <span className={`pill ${m.delta >= 0 ? 'pill-green' : 'pill-red'}`} style={{ fontSize: 10 }}>
            {m.delta >= 0 ? '+' : '−'}{(Math.abs(m.delta) * 100).toFixed(1)}% 24h
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 0 }}>
        {/* Left: chart + tabs */}
        <div className="hairline-r" style={{ padding: 24 }}>
          {/* Headline */}
          <div className="row gap-6 mb-4" style={{ marginBottom: 16 }}>
            <div>
              <div className="micro">YES probability</div>
              <div className="num" style={{ fontSize: 48, lineHeight: 1 }}>{m.yes.toFixed(2)}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 12 }}>
                <div style={{ height: 4, width: `${m.yes * 100}%`, background: 'var(--green)', borderRadius: 2 }} />
              </div>
              <div className="row mt-2" style={{ justifyContent: 'space-between', fontSize: 12, fontFamily: 'var(--mono)' }}>
                <span style={{ color: 'var(--green)' }}>YES {m.yes.toFixed(2)}</span>
                <span style={{ color: 'var(--red)' }}>NO {(1 - m.yes).toFixed(2)}</span>
              </div>
            </div>
            <div className="col gap-1">
              {[['Vol', fmtVol(m.vol)], ['Liq', fmtVol(m.liq)], ['Traders', m.traders.toLocaleString()]].map(([l, v]) => (
                <div key={l as string} className="row gap-3" style={{ justifyContent: 'space-between' }}>
                  <span className="micro" style={{ fontSize: 9 }}>{l}</span>
                  <span className="num" style={{ fontSize: 13 }}>{v}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Timeframe */}
          <div className="row gap-2" style={{ marginBottom: 8 }}>
            {['1H', '6H', '1D', '1W', '1M', 'ALL'].map((t) => (
              <button key={t} className={`btn btn-sm ${t === '1M' ? 'btn-cyan' : 'btn-ghost'}`} style={{ padding: '4px 8px', fontSize: 11 }}>{t}</button>
            ))}
          </div>

          {/* Chart */}
          <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
            <FullChart trend={m.trend} />
          </div>

          {/* Tabs */}
          <div className="row hairline-b mt-4" style={{ gap: 0, marginTop: 24 }}>
            {[['book', 'Order book'], ['fills', 'Recent fills'], ['rules', 'Rules & sources']].map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} className="btn btn-ghost"
                style={{ borderRadius: 0, borderBottom: tab === k ? '1px solid var(--cyan)' : '1px solid transparent', color: tab === k ? 'var(--cyan)' : 'var(--text-2)', padding: '10px 16px', fontSize: 13 }}>
                {l}
              </button>
            ))}
          </div>

          {tab === 'book' && (
            <div className="panel mt-4" style={{ padding: 0 }}>
              <OrderBook />
            </div>
          )}
          {tab === 'fills' && (
            <div className="panel mt-4" style={{ padding: 0 }}>
              <table className="tbl">
                <thead><tr><th>Time</th><th>Side</th><th>Price</th><th style={{ textAlign: 'right' }}>Size</th><th>Origin</th></tr></thead>
                <tbody>
                  {FILLS.map((f, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ fontSize: 11 }}>{f.time}</td>
                      <td><span className={`pill ${f.side === 'YES' ? 'pill-green' : 'pill-red'}`} style={{ fontSize: 9 }}>{f.side}</span></td>
                      <td className="num">{f.price.toFixed(3)}</td>
                      <td style={{ textAlign: 'right' }} className="num">${f.size.toLocaleString()}</td>
                      <td><span className="pill pill-soft" style={{ fontSize: 9 }}>{f.vault ? 'VAULT' : 'MARKET'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === 'rules' && (
            <div className="panel mt-4" style={{ padding: 20 }}>
              <div className="micro">RESOLUTION CRITERIA</div>
              <p className="body mt-3" style={{ fontSize: 14 }}>{m.desc}</p>
              <div className="micro mt-4">SOURCES</div>
              <div className="col mt-2 gap-2">
                {m.sources.map((s, i) => (
                  <div key={i} className="row gap-2"><Icon d={ICONS.external} size={12} className="text-2" /><span className="small">{s}</span></div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: order ticket */}
        <div style={{ padding: 24 }}>
          <div className="panel" style={{ padding: 0 }}>
            <div className="row hairline-b" style={{ padding: '12px 16px', justifyContent: 'space-between' }}>
              <div className="micro">PLACE PRIVATE BET</div>
              <span className="pill pill-cyan" style={{ fontSize: 10 }}><span className="dot" />&nbsp;ZK-AUTH</span>
            </div>
            <div style={{ padding: 16 }}>
              {/* Side selector */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {(['YES', 'NO'] as const).map((s) => (
                  <button key={s} onClick={() => setSide(s)} className="btn" style={{
                    justifyContent: 'center', padding: '14px 0',
                    background: side === s ? (s === 'YES' ? 'oklch(0.78 0.16 152 / 0.12)' : 'oklch(0.70 0.18 25 / 0.12)') : 'transparent',
                    borderColor: side === s ? (s === 'YES' ? 'oklch(0.78 0.16 152 / 0.6)' : 'oklch(0.70 0.18 25 / 0.6)') : 'var(--line-strong)',
                    color: side === s ? (s === 'YES' ? 'var(--green)' : 'var(--red)') : 'var(--text-1)',
                    fontSize: 13, fontWeight: 500,
                  }}>
                    {s} · {s === 'YES' ? m.yes.toFixed(2) : (1 - m.yes).toFixed(2)}
                  </button>
                ))}
              </div>

              {/* Amount */}
              <div className="mt-4">
                <div className="micro">AMOUNT (USDC)</div>
                <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-1)', border: '1px solid var(--line-strong)', borderRadius: 6, padding: '0 12px', marginTop: 8 }}>
                  <span className="mono" style={{ color: 'var(--text-2)', fontSize: 18, marginRight: 6 }}>$</span>
                  <input type="number" value={amount} onChange={(e) => setAmount(Math.max(0, +e.target.value || 0))}
                    style={{ background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 22, padding: '10px 0', width: '100%' }} />
                  <span className="mono" style={{ color: 'var(--text-2)', fontSize: 12 }}>USDC</span>
                </div>
                <div className="row mt-2 gap-2">
                  {[100, 500, 1000, 5000].map((v) => (
                    <button key={v} onClick={() => setAmount(v)} className={`btn btn-sm ${amount === v ? 'btn-cyan' : 'btn-ghost'}`} style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}>
                      ${v >= 1000 ? `${v / 1000}k` : v}
                    </button>
                  ))}
                </div>
              </div>

              {/* Summary */}
              <div className="hairline-t mt-4" style={{ paddingTop: 12 }}>
                {[['Limit price', price.toFixed(3)], ['Expected shares', shares.toLocaleString()], ['Time in force', 'FOK'], ['Proof time', '~142ms'], ['Relay hops', '3 randomized']].map(([l, v]) => (
                  <div key={l as string} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                    <span className="small" style={{ fontSize: 12 }}>{l}</span>
                    <span className="mono" style={{ fontSize: 12 }}>{v}</span>
                  </div>
                ))}
              </div>

              <Link href={`/app/bet?market=${encodeURIComponent(m.name)}&side=${side}&price=${Math.round(price * 1e6)}`} className="btn btn-primary mt-4" style={{ width: '100%', justifyContent: 'center', padding: '14px 0', fontSize: 14, textDecoration: 'none' }}>
                Generate ZK proof & authorize
              </Link>
              <div className="small mt-2" style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 11 }}>
                Signed locally · proof relay 3-hop
              </div>
            </div>
          </div>

          {/* Your position */}
          <div className="panel mt-3" style={{ padding: 20 }}>
            <div className="micro">YOUR POSITION</div>
            <div className="small mt-2" style={{ color: 'var(--text-3)' }}>No open position in this market.</div>
            <div className="row gap-2 mt-3">
              <Link href="/app/deposit" className="btn btn-sm" style={{ flex: 1, justifyContent: 'center', textDecoration: 'none', fontSize: 12 }}>Deposit USDC</Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
