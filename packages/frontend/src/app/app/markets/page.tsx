'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { Icon, ICONS } from '@/components/ui/Icon'
import { Sparkline } from '@/components/ui/Sparkline'
import { type MarketEntry } from '@/lib/marketsData'
import { track } from '@/lib/analytics'

const CATEGORIES = ['ALL', 'POLITICS', 'CRYPTO', 'MACRO', 'COMMODITIES', 'TECH', 'GEO', 'SPORTS', 'CULTURE', 'WEATHER', 'OTHER']
const SORTS = ['Volume', 'Liquidity', 'Δ24h', 'Resolves soon']
const PAGE = 60

type MarketsResponse = { markets: MarketEntry[]; total: number }
type PricesResponse = { prices: Record<string, number> }

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
    <Link
      href={`/app/market/${market.id}`}
      onClick={() => track([{ scope: 'market_view', key: market.id }])}
      style={{ textDecoration: 'none' }}
    >
      <div className="panel market-card" style={{ padding: 0, overflow: 'hidden', cursor: 'pointer' }}>
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
                  {/* Static odds are neutral (matches the list + detail views); green/red is
                      reserved for movement (Δ/sparkline) and the YES/NO action buttons below. */}
                  <div className="num" style={{ fontSize: 20, color: 'var(--text)' }}>{market.yes.toFixed(2)}</div>
                </div>
                <div>
                  <div className="micro" style={{ fontSize: 9 }}>{noLabel}</div>
                  <div className="num" style={{ fontSize: 20, color: 'var(--text-1)' }}>{(1 - market.yes).toFixed(2)}</div>
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
          <span className="small" style={{ fontSize: 11 }}>{fmtVol(market.vol)} vol</span>
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
        <Link
          href={`/app/market/${market.id}`}
          onClick={() => track([{ scope: 'market_view', key: market.id }])}
          style={{ textDecoration: 'none', color: 'inherit' }}
        >
          {market.name}
        </Link>
      </td>
      <td><span className="pill pill-soft" style={{ fontSize: 9 }}>{market.cat}</span></td>
      <td style={{ textAlign: 'right' }} className="num">{market.yes.toFixed(2)}</td>
      <td style={{ textAlign: 'right', color: market.delta >= 0 ? 'var(--green)' : 'var(--red)' }} className="num">
        {market.delta >= 0 ? '+' : '−'}{(Math.abs(market.delta) * 100).toFixed(1)}%
      </td>
      <td style={{ textAlign: 'right' }} className="num">{fmtVol(market.vol)}</td>
      <td><Sparkline data={market.trend} width={80} height={20} color={market.delta >= 0 ? 'var(--green)' : 'var(--red)'} /></td>
      <td>
        <div className="row gap-1">
          <Link href={`/app/market/${market.id}?modal=bet&side=YES`} onClick={() => track([{ scope: 'market_view', key: market.id }])} className="btn btn-sm" style={{ padding: '4px 8px', fontSize: 10, background: 'oklch(0.78 0.16 152 / 0.08)', borderColor: 'oklch(0.78 0.16 152 / 0.3)', color: 'var(--green)' }}>
            {yesLabel}
          </Link>
          <Link href={`/app/market/${market.id}?modal=bet&side=NO`} onClick={() => track([{ scope: 'market_view', key: market.id }])} className="btn btn-sm" style={{ padding: '4px 8px', fontSize: 10, background: 'oklch(0.70 0.18 25 / 0.08)', borderColor: 'oklch(0.70 0.18 25 / 0.3)', color: 'var(--red)' }}>
            {noLabel}
          </Link>
        </div>
      </td>
    </tr>
  )
}

function CardSkeleton() {
  return <div className="skeleton" style={{ height: 184 }} />
}

export default function MarketsPage() {
  const [category, setCategory] = useState('ALL')
  const [sort, setSort] = useState('Volume')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(PAGE)

  // ── Catalog browse (slow set; cached server-side). keepPreviousData = no flicker on refetch. ──
  const { data, isLoading, isError, isFetching, refetch } = useQuery<MarketsResponse>({
    queryKey: ['markets', category, sort, limit],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(limit), sort })
      if (category !== 'ALL') params.set('category', category)
      const res = await fetch(`/api/markets?${params.toString()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error('markets unavailable')
      return res.json() as Promise<MarketsResponse>
    },
    placeholderData: keepPreviousData,
    refetchInterval: 60_000, // the SET changes slowly; odds refresh separately (below)
    refetchOnWindowFocus: true,
  })
  const catalogMarkets = useMemo(() => data?.markets ?? [], [data])
  const total = data?.total ?? 0

  // ── Live search: instant-local first; when the loaded set has too few hits, hit Polymarket. ──
  const [liveResults, setLiveResults] = useState<MarketEntry[]>([])
  const [searching, setSearching] = useState(false)
  const catalogRef = useRef<MarketEntry[]>([])
  catalogRef.current = catalogMarkets
  useEffect(() => {
    const q = search.trim()
    if (q.length < 3) { setLiveResults([]); setSearching(false); return }
    const local = catalogRef.current.filter((m) => m.name.toLowerCase().includes(q.toLowerCase()))
    if (local.length >= 5) { setLiveResults([]); setSearching(false); return } // cache satisfies it
    setSearching(true)
    const t = window.setTimeout(async () => {
      try {
        track([{ scope: 'search_query', key: q }])
        const res = await fetch(`/api/markets/search?q=${encodeURIComponent(q)}`, { cache: 'no-store' })
        const json = (await res.json()) as { markets?: MarketEntry[]; wentLive?: boolean }
        setLiveResults(json.markets ?? [])
        if (json.wentLive) track([{ scope: 'search_live', key: q }])
      } catch {
        setLiveResults([])
      } finally {
        setSearching(false)
      }
    }, 350)
    return () => window.clearTimeout(t)
  }, [search])

  // Merge catalog + live-searched results (dedup by id), preserving catalog order then appending.
  const pool = useMemo(() => {
    const byId = new Map<string, MarketEntry>()
    for (const m of catalogMarkets) byId.set(m.id, m)
    for (const m of liveResults) if (!byId.has(m.id)) byId.set(m.id, m)
    return [...byId.values()]
  }, [catalogMarkets, liveResults])

  // ── Odds overlay (fast; decoupled from the set). Merged in place → no row reorder. ──
  const tokenIds = useMemo(
    () => pool.map((m) => m.yesTokenId).filter((t): t is string => !!t).slice(0, 100),
    [pool],
  )
  const { data: priceData } = useQuery<PricesResponse>({
    queryKey: ['market-prices', tokenIds.join(',')],
    queryFn: async () => {
      const res = await fetch(`/api/markets/prices?ids=${tokenIds.join(',')}`, { cache: 'no-store' })
      if (!res.ok) return { prices: {} }
      return res.json() as Promise<PricesResponse>
    },
    enabled: tokenIds.length > 0,
    refetchInterval: 12_000,
    placeholderData: keepPreviousData,
  })
  const odds = priceData?.prices ?? {}

  // Visible list: odds overlay + instant client search filter + client-side staleness guard.
  // Sort keys (vol/liq/endTs/|delta|) are unaffected by the odds overlay, so odds refreshes
  // never reorder rows. Search filters the merged pool instantly on every keystroke.
  const visible = useMemo(() => {
    const now = Date.now()
    const q = search.trim().toLowerCase()
    let arr = pool
      .filter((m) => m.acceptingOrders !== false && (!m.endTs || m.endTs > now))
      .map((m) => {
        const mid = m.yesTokenId ? odds[m.yesTokenId] : undefined
        return mid != null && Number.isFinite(mid) ? { ...m, yes: mid } : m
      })
    if (q) arr = arr.filter((m) => m.name.toLowerCase().includes(q))
    const sorted = arr.slice()
    if (sort === 'Volume') sorted.sort((a, b) => b.vol - a.vol)
    else if (sort === 'Liquidity') sorted.sort((a, b) => b.liq - a.liq)
    else if (sort === 'Δ24h') sorted.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    else if (sort === 'Resolves soon') {
      const key = (m: MarketEntry) => (m.endTs && m.endTs > 0 ? m.endTs : Number.POSITIVE_INFINITY)
      sorted.sort((a, b) => key(a) - key(b))
    }
    return sorted
  }, [pool, odds, search, sort])

  const canLoadMore = !search.trim() && catalogMarkets.length < total
  const showSkeleton = isLoading && catalogMarkets.length === 0

  return (
    <div>
      <div className="row hairline-b" style={{ padding: '14px 24px', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div className="row gap-4">
          <div className="micro">MARKETS</div>
          <span className="pill pill-soft" style={{ fontSize: 10 }}>{visible.length}{total ? ` / ${total}` : ''} markets</span>
          {(isFetching || searching) && <span className="pill pill-cyan" style={{ fontSize: 10 }}>{searching ? 'Searching Polymarket…' : 'Updating'}</span>}
        </div>
        <div className="row gap-3">
          <div className="row gap-2 panel" style={{ padding: '6px 10px', borderRadius: 6, flex: '1 1 140px', minWidth: 0, maxWidth: 240 }}>
            <Icon d={ICONS.search} size={12} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search markets…"
              aria-label="Search markets"
              style={{ background: 'transparent', border: 'none', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, width: '100%', minWidth: 0 }}
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
            <button
              key={value}
              onClick={() => { setCategory(value); setLimit(PAGE); if (value !== 'ALL') track([{ scope: 'category_click', key: value }]) }}
              className={`btn btn-sm ${category === value ? 'btn-cyan' : ''}`}
              style={{ fontSize: 11 }}
            >
              {value}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <select
            value={sort}
            onChange={(event) => { setSort(event.target.value); track([{ scope: 'sort_change', key: event.target.value }]) }}
            style={{ background: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: 6, color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, padding: '6px 10px' }}
          >
            {SORTS.map((value) => <option key={value}>{value}</option>)}
          </select>
        </div>

        {/* Honest states: error, skeleton on first load, empty. */}
        {isError && (
          <div className="panel" style={{ padding: 32, textAlign: 'center' }}>
            <div className="body" style={{ marginBottom: 12 }}>Markets are temporarily unavailable.</div>
            <button className="btn btn-sm btn-cyan" onClick={() => void refetch()}>Retry</button>
          </div>
        )}
        {!isError && showSkeleton && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
            {Array.from({ length: 9 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        )}
        {!isError && !showSkeleton && visible.length === 0 && (
          <div className="panel" style={{ padding: 32, textAlign: 'center' }}>
            <div className="body">{search.trim() ? `No markets match “${search.trim()}”.` : 'No markets available right now.'}</div>
          </div>
        )}

        {!isError && !showSkeleton && visible.length > 0 && (
          view === 'grid' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
              {visible.map((market) => <MarketCard key={market.id} market={market} />)}
            </div>
          ) : (
            <div className="panel scroll-x" style={{ padding: 0 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Cat</th>
                    <th style={{ textAlign: 'right' }}>YES</th>
                    <th style={{ textAlign: 'right' }}>Δ24h</th>
                    <th style={{ textAlign: 'right' }}>Vol</th>
                    <th>Trend</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((market) => <MarketListRow key={market.id} market={market} />)}
                </tbody>
              </table>
            </div>
          )
        )}

        {canLoadMore && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}>
            <button className="btn btn-sm" disabled={isFetching} onClick={() => setLimit((l) => l + PAGE)}>
              {isFetching ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
