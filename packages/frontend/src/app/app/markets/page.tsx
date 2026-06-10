'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { Icon, ICONS } from '@/components/ui/Icon'
import { Sparkline } from '@/components/ui/Sparkline'
import { type MarketEntry } from '@/lib/marketsData'

const CATEGORIES = ['ALL', 'POLITICS', 'CRYPTO', 'MACRO', 'TECH', 'GEO', 'SPORTS', 'CULTURE', 'OTHER']
const SORTS = ['Volume', 'Liquidity', 'Δ24h', 'Resolves soon']

function fmtVol(v: number) {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v}`
}

// Up/Down markets show "UP"/"DOWN"; everything else "YES"/"NO". side 0 = labels[0].
function sideLabels(market: MarketEntry): [string, string] {
  const l = market.outcomeLabels
  return l ? [l[0].toUpperCase(), l[1].toUpperCase()] : ['YES', 'NO']
}

function MarketCard({ market }: { market: MarketEntry }) {
  const pct = market.yes * 100
  const [yesLabel, noLabel] = sideLabels(market)
  return (
    <Link href={`/app/market/${market.id}`} style={{ textDecoration: 'none' }}>
      <div className="panel" style={{ padding: 0, overflow: 'hidden', cursor: 'pointer', transition: 'border-color .15s' }}>
        <div style={{ padding: '16px 18px 12px' }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <span className="pill pill-soft" style={{ fontSize: 9 }}>{market.cat}</span>
            <span className="small" style={{ fontSize: 11 }}>resolves {market.resolves}</span>
          </div>
          <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.4, minHeight: 40 }}>{market.name}</div>
          <div className="row mt-3" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div>
              <div className="row gap-4">
                <div>
                  <div className="micro" style={{ fontSize: 9 }}>{yesLabel}</div>
                  <div className="num" style={{ fontSize: 20, color: 'var(--green)' }}>{market.yes.toFixed(2)}</div>
                </div>
                <div>
                  <div className="micro" style={{ fontSize: 9 }}>{noLabel}</div>
                  <div className="num" style={{ fontSize: 20, color: 'var(--red)' }}>{(1 - market.yes).toFixed(2)}</div>
                </div>
                <div>
                  <div className="micro" style={{ fontSize: 9 }}>Δ24h</div>
                  <div className="num" style={{ fontSize: 14, color: market.delta >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {market.delta >= 0 ? '+' : '−'}{(Math.abs(market.delta) * 100).toFixed(1)}%
                  </div>
                </div>
              </div>
            </div>
            <Sparkline data={market.trend} width={80} height={28} color={market.delta >= 0 ? 'var(--green)' : 'var(--red)'} />
          </div>
          <div style={{ height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 12 }}>
            <div style={{ height: 3, width: `${pct}%`, background: 'var(--green)', borderRadius: 2 }} />
          </div>
        </div>
        <div className="row hairline-t" style={{ padding: '10px 18px', justifyContent: 'space-between' }}>
          <span className="small" style={{ fontSize: 11 }}>{fmtVol(market.vol)} vol · {market.traders.toLocaleString()} traders</span>
          <div className="row gap-2">
            <button className="btn btn-sm" style={{ padding: '4px 10px', fontSize: 11, background: 'oklch(0.78 0.16 152 / 0.08)', borderColor: 'oklch(0.78 0.16 152 / 0.3)', color: 'var(--green)' }}>
              {yesLabel}
            </button>
            <button className="btn btn-sm" style={{ padding: '4px 10px', fontSize: 11, background: 'oklch(0.70 0.18 25 / 0.08)', borderColor: 'oklch(0.70 0.18 25 / 0.3)', color: 'var(--red)' }}>
              {noLabel}
            </button>
          </div>
        </div>
      </div>
    </Link>
  )
}

function MarketListRow({ market }: { market: MarketEntry }) {
  const [yesLabel, noLabel] = sideLabels(market)
  return (
    <tr>
      <td style={{ color: 'var(--text)' }}>
        <Link href={`/app/market/${market.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>{market.name}</Link>
      </td>
      <td><span className="pill pill-soft" style={{ fontSize: 9 }}>{market.cat}</span></td>
      <td style={{ textAlign: 'right' }} className="num">{market.yes.toFixed(2)}</td>
      <td style={{ textAlign: 'right', color: market.delta >= 0 ? 'var(--green)' : 'var(--red)' }} className="num">
        {market.delta >= 0 ? '+' : '−'}{(Math.abs(market.delta) * 100).toFixed(1)}%
      </td>
      <td style={{ textAlign: 'right' }} className="num">{fmtVol(market.vol)}</td>
      <td style={{ textAlign: 'right' }} className="num">{market.traders.toLocaleString()}</td>
      <td><Sparkline data={market.trend} width={80} height={20} color={market.delta >= 0 ? 'var(--green)' : 'var(--red)'} /></td>
      <td>
        <div className="row gap-1">
          <Link href={`/app/market/${market.id}?modal=bet&side=YES`} className="btn btn-sm" style={{ padding: '4px 8px', fontSize: 10, background: 'oklch(0.78 0.16 152 / 0.08)', borderColor: 'oklch(0.78 0.16 152 / 0.3)', color: 'var(--green)' }}>
            {yesLabel}
          </Link>
          <Link href={`/app/market/${market.id}?modal=bet&side=NO`} className="btn btn-sm" style={{ padding: '4px 8px', fontSize: 10, background: 'oklch(0.70 0.18 25 / 0.08)', borderColor: 'oklch(0.70 0.18 25 / 0.3)', color: 'var(--red)' }}>
            {noLabel}
          </Link>
        </div>
      </td>
    </tr>
  )
}

export default function MarketsPage() {
  const [category, setCategory] = useState('ALL')
  const [sort, setSort] = useState('Volume')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [search, setSearch] = useState('')
  // Start empty (not the fixtures) so live Polymarket data from /api/markets is the only
  // thing users ever see — no flash of mock markets.
  const [markets, setMarkets] = useState<MarketEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/api/markets', { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json() as MarketEntry[]
        if (!cancelled) setMarkets(data)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    // Refresh prices/volume every 10s. Updates are merged into state silently (the
    // "Refreshing" pill is only shown on the initial load), so the user's category,
    // sort, search, and view selections are preserved across polls.
    const id = window.setInterval(() => void load(), 10_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const filtered = useMemo(() => {
    let arr = markets.slice()
    if (category !== 'ALL') arr = arr.filter((market) => market.cat === category)
    if (search) arr = arr.filter((market) => market.name.toLowerCase().includes(search.toLowerCase()))
    if (sort === 'Volume') arr.sort((a, b) => b.vol - a.vol)
    else if (sort === 'Liquidity') arr.sort((a, b) => b.liq - a.liq)
    else if (sort === 'Δ24h') arr.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    else if (sort === 'Resolves soon') {
      // Soonest first; markets with no end timestamp sort to the bottom.
      const key = (m: MarketEntry) => (m.endTs && m.endTs > 0 ? m.endTs : Number.POSITIVE_INFINITY)
      arr.sort((a, b) => key(a) - key(b))
    }
    return arr
  }, [markets, category, sort, search])

  return (
    <div>
      <div className="row hairline-b" style={{ padding: '14px 24px', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div className="row gap-4">
          <div className="micro">MARKETS</div>
          <span className="pill pill-soft" style={{ fontSize: 10 }}>{markets.length} markets</span>
          {loading && <span className="pill pill-cyan" style={{ fontSize: 10 }}>Refreshing</span>}
        </div>
        <div className="row gap-3">
          <div className="row gap-2 panel" style={{ padding: '6px 10px', borderRadius: 6 }}>
            <Icon d={ICONS.search} size={12} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search markets..."
              aria-label="Search markets"
              style={{ background: 'transparent', border: 'none', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, width: 180 }}
            />
          </div>
          <div className="row gap-1">
            {(['grid', 'list'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setView(mode)}
                className={`btn btn-sm ${view === mode ? 'btn-cyan' : 'btn-ghost'}`}
                style={{ padding: '6px 10px' }}
              >
                <Icon d={mode === 'grid' ? ICONS.dashboard : ICONS.analytics} size={13} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ padding: 24 }}>
        <div className="row gap-2" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
          {CATEGORIES.map((value) => (
            <button key={value} onClick={() => setCategory(value)} className={`btn btn-sm ${category === value ? 'btn-cyan' : ''}`} style={{ fontSize: 11 }}>
              {value}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            style={{ background: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: 6, color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, padding: '6px 10px' }}
          >
            {SORTS.map((value) => <option key={value}>{value}</option>)}
          </select>
        </div>

        {view === 'grid' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
            {filtered.map((market) => <MarketCard key={market.id} market={market} />)}
          </div>
        ) : (
          <div className="panel" style={{ padding: 0 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Cat</th>
                  <th style={{ textAlign: 'right' }}>YES</th>
                  <th style={{ textAlign: 'right' }}>Δ24h</th>
                  <th style={{ textAlign: 'right' }}>Vol</th>
                  <th style={{ textAlign: 'right' }}>Traders</th>
                  <th>Trend</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((market) => <MarketListRow key={market.id} market={market} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
