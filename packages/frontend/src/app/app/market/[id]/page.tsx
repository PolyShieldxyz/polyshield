'use client'

import Link from 'next/link'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { Icon, ICONS } from '@/components/ui/Icon'
import { BetModal } from '@/components/app/BetModal'
import { MARKETS, type MarketEntry } from '@/lib/marketsData'

type MarketPayload = {
  market: MarketEntry
  source: 'live' | 'fixture'
  book: {
    bids?: Array<{ price: string; size: string }>
    asks?: Array<{ price: string; size: string }>
  }
}

function fmtVol(v: number) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v}`
}

function FullChart({ trend }: { trend: number[] }) {
  const w = 680
  const h = 280
  const data = useMemo(() => {
    const pts: number[] = []
    let p = trend[0] ?? 0.5
    for (let i = 0; i < 120; i++) {
      p += (Math.sin(i * 0.3) + (Math.random() - 0.5)) * 0.008
      p = Math.max(0.05, Math.min(0.98, p))
      pts.push(p)
    }
    trend.forEach((v) => pts.push(v))
    return pts
  }, [trend])

  const xs = (i: number) => 48 + (i / (data.length - 1)) * (w - 72)
  const ys = (v: number) => h - 28 - v * (h - 56)
  const line = data.map((v, i) => `${xs(i)},${ys(v)}`).join(' ')
  const area = `M${xs(0)},${h - 28} L${line.split(' ').join(' L')} L${xs(data.length - 1)},${h - 28} Z`

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="280">
      {[0.2, 0.4, 0.6, 0.8].map((v) => (
        <g key={v}>
          <line x1="48" y1={ys(v)} x2={w - 24} y2={ys(v)} stroke="rgba(255,255,255,0.05)" />
          <text x="40" y={ys(v) + 3} textAnchor="end" fontFamily="JetBrains Mono" fontSize="9" fill="rgba(255,255,255,0.4)">
            {v.toFixed(2)}
          </text>
        </g>
      ))}
      <path d={area} fill="oklch(0.82 0.13 210 / 0.07)" />
      <polyline points={line} fill="none" stroke="oklch(0.82 0.13 210)" strokeWidth="1.5" />
      <circle cx={xs(data.length - 1)} cy={ys(data[data.length - 1])} r="4" fill="oklch(0.82 0.13 210)" />
    </svg>
  )
}

// Next 15 requires any component calling useSearchParams() to be wrapped in a
// Suspense boundary, or `next build` fails. The page content lives in
// MarketDetailContent; this default export provides the boundary.
export default function MarketDetailPage() {
  return (
    <Suspense fallback={null}>
      <MarketDetailContent />
    </Suspense>
  )
}

function MarketDetailContent() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const id = params.id as string
  const [payload, setPayload] = useState<MarketPayload | null>(null)
  const [tab, setTab] = useState<'book' | 'fills' | 'rules'>('book')
  const [side, setSide] = useState<'YES' | 'NO'>('YES')
  const [amount, setAmount] = useState(1000)
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    if (searchParams.get('modal') === 'bet') {
      setModalOpen(true)
    }
  }, [searchParams])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await fetch(`/api/markets/${encodeURIComponent(id)}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json() as MarketPayload
      if (!cancelled) setPayload(data)
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  const market = payload?.market ?? MARKETS.find((entry) => entry.id === id) ?? MARKETS[0]
  const book = payload?.book
  const price = side === 'YES' ? market.yes : 1 - market.yes
  const shares = Math.floor(amount / price)

  const closeModal = () => {
    setModalOpen(false)
    const next = new URLSearchParams(searchParams.toString())
    next.delete('modal')
    router.replace(next.toString() ? `/app/market/${id}?${next.toString()}` : `/app/market/${id}`)
  }

  return (
    <div>
      <div className="row hairline-b" style={{ padding: '12px 24px', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div className="row gap-3">
          <Link href="/app/markets" className="btn btn-sm btn-ghost" style={{ textDecoration: 'none' }}>← Markets</Link>
          <span style={{ color: 'var(--line-strong)' }}>·</span>
          <span className="pill pill-soft" style={{ fontSize: 9 }}>{market.cat}</span>
          <span style={{ fontSize: 13, color: 'var(--text-1)' }}>{market.name}</span>
        </div>
        <div className="row gap-3">
          <span className="small" style={{ fontSize: 12 }}>Resolves {market.resolves}</span>
          <span className={`pill ${market.delta >= 0 ? 'pill-green' : 'pill-red'}`} style={{ fontSize: 10 }}>
            {market.delta >= 0 ? '+' : '−'}{(Math.abs(market.delta) * 100).toFixed(1)}% 24h
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 0 }}>
        <div className="hairline-r" style={{ padding: 24 }}>
          <div className="row gap-6 mb-4" style={{ marginBottom: 16 }}>
            <div>
              <div className="micro">YES probability</div>
              <div className="num" style={{ fontSize: 48, lineHeight: 1 }}>{market.yes.toFixed(2)}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 12 }}>
                <div style={{ height: 4, width: `${market.yes * 100}%`, background: 'var(--green)', borderRadius: 2 }} />
              </div>
              <div className="row mt-2" style={{ justifyContent: 'space-between', fontSize: 12, fontFamily: 'var(--mono)' }}>
                <span style={{ color: 'var(--green)' }}>YES {market.yes.toFixed(2)}</span>
                <span style={{ color: 'var(--red)' }}>NO {(1 - market.yes).toFixed(2)}</span>
              </div>
            </div>
            <div className="col gap-1">
              {[['Vol', fmtVol(market.vol)], ['Liq', fmtVol(market.liq)], ['Traders', market.traders.toLocaleString()]].map(([label, value]) => (
                <div key={label as string} className="row gap-3" style={{ justifyContent: 'space-between' }}>
                  <span className="micro" style={{ fontSize: 9 }}>{label}</span>
                  <span className="num" style={{ fontSize: 13 }}>{value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="row gap-2" style={{ marginBottom: 8 }}>
            {['1H', '6H', '1D', '1W', '1M', 'ALL'].map((label) => (
              <button key={label} className={`btn btn-sm ${label === '1M' ? 'btn-cyan' : 'btn-ghost'}`} style={{ padding: '4px 8px', fontSize: 11 }}>
                {label}
              </button>
            ))}
          </div>

          <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
            <FullChart trend={market.trend} />
          </div>

          <div className="row hairline-b mt-4" style={{ gap: 0, marginTop: 24 }}>
            {[
              ['book', 'Order book'],
              ['fills', 'Recent fills'],
              ['rules', 'Rules & sources'],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key as 'book' | 'fills' | 'rules')}
                className="btn btn-ghost"
                style={{
                  borderRadius: 0,
                  borderBottom: tab === key ? '1px solid var(--cyan)' : '1px solid transparent',
                  color: tab === key ? 'var(--cyan)' : 'var(--text-2)',
                  padding: '10px 16px',
                  fontSize: 13,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'book' && (
            <div className="panel mt-4" style={{ padding: 0 }}>
              <div>
                <div className="row" style={{ padding: '8px 12px', fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--mono)', letterSpacing: '0.06em' }}>
                  <div style={{ width: 60 }}>PRICE</div>
                  <div style={{ flex: 1, textAlign: 'right' }}>SIZE</div>
                </div>
                {(book?.asks ?? []).map((ask, index) => (
                  <div key={`ask-${index}`} className="row" style={{ padding: '5px 12px', fontSize: 12, fontFamily: 'var(--mono)' }}>
                    <div style={{ width: 60, color: 'var(--red)' }}>{Number(ask.price).toFixed(3)}</div>
                    <div style={{ flex: 1, textAlign: 'right' }}>{Number(ask.size).toLocaleString()}</div>
                  </div>
                ))}
                <div className="row hairline-t hairline-b" style={{ padding: '6px 12px', justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: 12 }}>
                  <span style={{ color: 'var(--cyan)' }}>{price.toFixed(4)}</span>
                  <span style={{ color: 'var(--text-2)' }}>spread varies by book depth</span>
                </div>
                {(book?.bids ?? []).map((bid, index) => (
                  <div key={`bid-${index}`} className="row" style={{ padding: '5px 12px', fontSize: 12, fontFamily: 'var(--mono)' }}>
                    <div style={{ width: 60, color: 'var(--green)' }}>{Number(bid.price).toFixed(3)}</div>
                    <div style={{ flex: 1, textAlign: 'right' }}>{Number(bid.size).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'fills' && (
            <div className="panel mt-4" style={{ padding: 0 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Side</th>
                    <th>Price</th>
                    <th style={{ textAlign: 'right' }}>Size</th>
                    <th>Origin</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { time: '14:02:08', side: 'YES', price: market.yes, size: 4250, vault: true },
                    { time: '14:01:33', side: 'NO', price: 1 - market.yes, size: 800, vault: false },
                    { time: '14:00:55', side: 'YES', price: market.yes, size: 12400, vault: true },
                  ].map((fill, index) => (
                    <tr key={index}>
                      <td className="mono" style={{ fontSize: 11 }}>{fill.time}</td>
                      <td><span className={`pill ${fill.side === 'YES' ? 'pill-green' : 'pill-red'}`} style={{ fontSize: 9 }}>{fill.side}</span></td>
                      <td className="num">{fill.price.toFixed(3)}</td>
                      <td style={{ textAlign: 'right' }} className="num">${fill.size.toLocaleString()}</td>
                      <td><span className="pill pill-soft" style={{ fontSize: 9 }}>{fill.vault ? 'VAULT' : 'MARKET'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'rules' && (
            <div className="panel mt-4" style={{ padding: 20 }}>
              <div className="micro">RESOLUTION CRITERIA</div>
              <p className="body mt-3" style={{ fontSize: 14 }}>{market.desc ?? ''}</p>
              <div className="micro mt-4">SOURCES</div>
              <div className="col mt-2 gap-2">
                {(market.sources ?? []).map((source, index) => (
                  <div key={index} className="row gap-2">
                    <Icon d={ICONS.external} size={12} className="text-2" />
                    <span className="small">{source}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: 24 }}>
          <div className="panel" style={{ padding: 0 }}>
            <div className="row hairline-b" style={{ padding: '12px 16px', justifyContent: 'space-between' }}>
              <div className="micro">PLACE PRIVATE BET</div>
              <span className="pill pill-cyan" style={{ fontSize: 10 }}><span className="dot" />&nbsp;ZK-AUTH</span>
            </div>
            <div style={{ padding: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {(['YES', 'NO'] as const).map((choice) => (
                  <button
                    key={choice}
                    onClick={() => setSide(choice)}
                    className="btn"
                    style={{
                      justifyContent: 'center',
                      padding: '14px 0',
                      background: side === choice ? (choice === 'YES' ? 'oklch(0.78 0.16 152 / 0.12)' : 'oklch(0.70 0.18 25 / 0.12)') : 'transparent',
                      borderColor: side === choice ? (choice === 'YES' ? 'oklch(0.78 0.16 152 / 0.6)' : 'oklch(0.70 0.18 25 / 0.6)') : 'var(--line-strong)',
                      color: side === choice ? (choice === 'YES' ? 'var(--green)' : 'var(--red)') : 'var(--text-1)',
                      fontSize: 13,
                      fontWeight: 500,
                    }}
                  >
                    {choice} · {choice === 'YES' ? market.yes.toFixed(2) : (1 - market.yes).toFixed(2)}
                  </button>
                ))}
              </div>

              <div className="mt-4">
                <div className="micro">AMOUNT (USDC)</div>
                <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-1)', border: '1px solid var(--line-strong)', borderRadius: 6, padding: '0 12px', marginTop: 8 }}>
                  <span className="mono" style={{ color: 'var(--text-2)', fontSize: 18, marginRight: 6 }}>$</span>
                  {/* FINDING: A11Y-002 aria-label; A11Y-001 dropped inline outline:none for global :focus-visible ring. */}
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(Math.max(0, +e.target.value || 0))}
                    aria-label="Bet amount in USDC"
                    style={{ background: 'transparent', border: 'none', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 22, padding: '10px 0', width: '100%' }}
                  />
                  <span className="mono" style={{ color: 'var(--text-2)', fontSize: 12 }}>USDC</span>
                </div>
                <div className="row mt-2 gap-2">
                  {[100, 500, 1000, 5000].map((value) => (
                    <button
                      key={value}
                      onClick={() => setAmount(value)}
                      className={`btn btn-sm ${amount === value ? 'btn-cyan' : 'btn-ghost'}`}
                      style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
                    >
                      ${value >= 1000 ? `${value / 1000}k` : value}
                    </button>
                  ))}
                </div>
              </div>

              <div className="hairline-t mt-4" style={{ paddingTop: 12 }}>
                {/* FINDING: FUNC-001 — honest proof time (Groth16 in-browser proving is 30s–2min, not ~2s). */}
                {[['Limit price', price.toFixed(3)], ['Expected shares', shares.toLocaleString()], ['Time in force', 'FOK'], ['Proof time', '30s–2min']].map(([label, value]) => (
                  <div key={label as string} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                    <span className="small" style={{ fontSize: 12 }}>{label}</span>
                    <span className="mono" style={{ fontSize: 12 }}>{value}</span>
                  </div>
                ))}
              </div>

              <button
                className="btn btn-primary mt-4"
                onClick={() => setModalOpen(true)}
                style={{ width: '100%', justifyContent: 'center', padding: '14px 0', fontSize: 14 }}
              >
                Generate ZK proof & authorize
              </button>
              <div className="small mt-2" style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 11 }}>
                Signed locally · proof relay
              </div>
            </div>
          </div>

          <div className="panel mt-3" style={{ padding: 20 }}>
            <div className="micro">YOUR POSITION</div>
            <div className="small mt-2" style={{ color: 'var(--text-3)' }}>No open position in this market.</div>
            <div className="row gap-2 mt-3">
              <Link href="/app/deposit" className="btn btn-sm" style={{ flex: 1, justifyContent: 'center', textDecoration: 'none', fontSize: 12 }}>Deposit USDC</Link>
            </div>
          </div>
        </div>
      </div>

      {modalOpen && (
        <BetModal
          open={modalOpen}
          marketId={market.id}
          marketName={market.name}
          conditionId={market.conditionId}
          side={side}
          initialAmount={amount}
          price={price}
          onClose={closeModal}
          onSuccess={async () => {
            // no-op for now; modal drives portfolio refresh by local storage state
          }}
        />
      )}
    </div>
  )
}
