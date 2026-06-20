'use client'

import Link from 'next/link'
import { Suspense, useEffect, useRef, useState } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useAccount, useReadContract } from 'wagmi'
import { Icon, ICONS } from '@/components/ui/Icon'
import { AmountInput } from '@/components/ui/AmountInput'
import { Tip } from '@/components/ui/Tip'
import { BetModal } from '@/components/app/BetModal'
import { MARKETS, type MarketEntry } from '@/lib/marketsData'
import { getFreeNotes, MAX_CONSOLIDATE_INPUTS, formatUsdc } from '@/lib/notes'
import { VAULT_ABI } from '@/lib/vaultAbi'
import { marketBuyCeilingFromBook, roundToTick, type BookLevel } from '@/lib/pricing'
import { type OrderKind, ORDER_KIND_LABEL } from '@/lib/orderType'

const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS ??
  '0x0000000000000000000000000000000000000000') as `0x${string}`

// Order type is selected here on the market page (not in the bet-auth popup) so the user picks how
// the order executes before generating a proof. Two user-facing types (matching Polymarket): a
// Market order fills now at a price ceiling and refunds any unfilled remainder; a Limit order rests
// at the user's price (optionally with an expiry). The mapping to CLOB primitives lives in the
// signing layer — order type never reaches the chain.

type MarketPayload = {
  market: MarketEntry
  source: 'live' | 'fixture'
  book: {
    bids?: Array<{ price: string; size: string }>
    asks?: Array<{ price: string; size: string }>
  }
  // L1: CLOB minimum tick size for the YES token (default 0.001). The bet price is snapped to it
  // at proof time so the committed price matches what the CLOB executes on.
  tickSize?: number
}

function fmtVol(v: number) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v}`
}

const CHART_RANGES = ['1H', '6H', '1D', '1W', '1M', 'ALL'] as const
type ChartRange = (typeof CHART_RANGES)[number]

// Real price-history chart. Replaces the old synthetic-noise placeholder: it fetches the
// YES token's actual Polymarket price series for the selected range, auto-scales the Y axis
// to the data (so stable markets still show shape instead of a flat line), and re-polls
// every 10s. Range buttons are wired (they used to be decorative).
function PriceChart({ tokenId, fallback }: { tokenId?: string; fallback: number }) {
  const [range, setRange] = useState<ChartRange>('1D')
  const [pts, setPts] = useState<number[]>([])
  const [stale, setStale] = useState(false)

  useEffect(() => {
    if (!tokenId) {
      setPts([])
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(`/api/markets/history?token=${encodeURIComponent(tokenId)}&range=${range}`, { cache: 'no-store' })
        if (!res.ok) {
          if (!cancelled) setStale(true)
          return
        }
        const data = (await res.json()) as { history: Array<{ t: number; p: number }> }
        if (!cancelled) {
          setPts((data.history ?? []).map((h) => h.p))
          setStale(false)
        }
      } catch {
        if (!cancelled) setStale(true)
      }
    }
    void load()
    const id = window.setInterval(() => void load(), 10_000) // live refresh every 10s
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [tokenId, range])

  const w = 680
  const h = 280
  const padL = 48
  const padR = 24
  const padT = 16
  const padB = 28
  const hasData = pts.length >= 2
  const series = hasData ? pts : [fallback, fallback]
  const lo = Math.min(...series)
  const hi = Math.max(...series)
  const span = Math.max(hi - lo, 0.02)
  const yMin = Math.max(0, lo - span * 0.15)
  const yMax = Math.min(1, hi + span * 0.15)
  const xs = (i: number) => padL + (i / (series.length - 1)) * (w - padL - padR)
  const ys = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * (h - padT - padB)
  const line = series.map((v, i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(' ')
  const area = `M${xs(0).toFixed(1)},${h - padB} L${series.map((v, i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(' L')} L${xs(series.length - 1).toFixed(1)},${h - padB} Z`
  const up = series[series.length - 1] >= series[0]
  const stroke = up ? 'var(--green)' : 'var(--red)'
  const fill = up ? 'oklch(0.78 0.16 152 / 0.08)' : 'oklch(0.70 0.18 25 / 0.08)'
  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin))

  return (
    <div>
      <div className="row" style={{ marginBottom: 8, justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row gap-1">
          {CHART_RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`btn btn-sm ${r === range ? 'btn-cyan' : 'btn-ghost'}`}
              style={{ padding: '4px 8px', fontSize: 11 }}
            >
              {r}
            </button>
          ))}
        </div>
        {tokenId && (
          <span className="pill pill-soft" style={{ fontSize: 9 }}>
            <span className="dot" style={{ background: stale ? 'var(--amber)' : 'var(--green)' }} />&nbsp;{stale ? 'STALE' : 'LIVE'}
          </span>
        )}
      </div>
      <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
        <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="280">
          {gridVals.map((v, i) => (
            <g key={i}>
              <line x1={padL} y1={ys(v)} x2={w - padR} y2={ys(v)} stroke="rgba(255,255,255,0.05)" />
              <text x={padL - 8} y={ys(v) + 3} textAnchor="end" fontFamily="JetBrains Mono" fontSize="9" fill="rgba(255,255,255,0.4)">
                {v.toFixed(2)}
              </text>
            </g>
          ))}
          {hasData && <path d={area} fill={fill} />}
          <polyline points={line} fill="none" stroke={stroke} strokeWidth="1.5" />
          <circle cx={xs(series.length - 1)} cy={ys(series[series.length - 1])} r="4" fill={stroke} />
          {!hasData && (
            <text x={w / 2} y={h / 2} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="11" fill="rgba(255,255,255,0.35)">
              {tokenId ? 'No price history for this range yet' : 'Live price history unavailable'}
            </text>
          )}
        </svg>
      </div>
    </div>
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
  // Order type (Market/Limit + optional expiry), selected here and passed into the bet modal.
  const [orderKind, setOrderKind] = useState<OrderKind>('MARKET')
  const [limitCents, setLimitCents] = useState(50)
  const [expiryEnabled, setExpiryEnabled] = useState(false)
  const [gtdMinutes, setGtdMinutes] = useState(60)

  useEffect(() => {
    if (searchParams.get('modal') === 'bet') {
      setModalOpen(true)
    }
  }, [searchParams])

  const [status, setStatus] = useState<'loading' | 'ok' | 'unavailable'>('loading')
  const registeredRef = useRef(false)
  const payloadRef = useRef<MarketPayload | null>(null)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    registeredRef.current = false
    const load = async () => {
      try {
        const res = await fetch(`/api/markets/${encodeURIComponent(id)}`, { cache: 'no-store' })
        if (!res.ok) {
          if (!cancelled && !payloadRef.current) setStatus('unavailable')
          return
        }
        const data = (await res.json()) as MarketPayload
        if (cancelled) return
        payloadRef.current = data
        setPayload(data)
        setStatus('ok')
        // FC-15 (#5): ensure the signing layer can route this market before the user bets — register
        // its real conditionId once on open (the signing layer fetches authoritative tokens itself).
        if (!registeredRef.current && data.market?.conditionId) {
          registeredRef.current = true
          void fetch('/api/signing/register-market', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conditionId: data.market.conditionId }),
          }).catch(() => {})
        }
      } catch {
        if (!cancelled && !payloadRef.current) setStatus('unavailable')
      }
    }
    void load()
    // Refresh order book, YES/NO percentage, volume etc. every 10s (route is force-dynamic now → real).
    const poll = window.setInterval(() => void load(), 10_000)
    return () => {
      cancelled = true
      window.clearInterval(poll)
    }
  }, [id])

  // Hook-safety fallback only — never rendered (the loading/unavailable guards below early-return
  // before any fixture could show). The fixture is no longer a user-facing fallback (FC-15).
  const market = payload?.market ?? MARKETS.find((entry) => entry.id === id) ?? MARKETS[0]
  const book = payload?.book
  // Up/Down markets display "UP"/"DOWN"; everything else "YES"/"NO". The internal `side`
  // state stays 'YES'|'NO' (it drives the circuit's outcome_side 0/1) — only the label changes.
  const [yesLabel, noLabel] = market.outcomeLabels
    ? [market.outcomeLabels[0].toUpperCase(), market.outcomeLabels[1].toUpperCase()]
    : ['YES', 'NO']
  const sideLabel = side === 'YES' ? yesLabel : noLabel
  const price = side === 'YES' ? market.yes : 1 - market.yes
  // L1: snap the bet price to the market tick at proof time. tickSize comes from the CLOB via the
  // market payload (default 0.001). bestAsk is the best executable ask for the SELECTED side — YES
  // → lowest ask; NO → 1 − highest YES bid (complementary binary) — falling back to the side's
  // market price when the book side is empty.
  const tickSize = payload?.tickSize ?? 0.001
  const askPrices = (book?.asks ?? []).map((a) => Number(a.price)).filter((p) => Number.isFinite(p) && p > 0)
  const bidPrices = (book?.bids ?? []).map((b) => Number(b.price)).filter((p) => Number.isFinite(p) && p > 0)
  const bestAsk =
    side === 'YES'
      ? (askPrices.length ? Math.min(...askPrices) : price)
      : (bidPrices.length ? 1 - Math.max(...bidPrices) : price)
  // Executable ask ladder for the selected side (ascending by price). YES → the YES asks; NO → the
  // binary complement of the YES bids (a YES bid at p is NO liquidity at 1−p), matching how bestAsk
  // is derived above. Fed to the walk-the-book market ceiling.
  const sideLevels: BookLevel[] =
    side === 'YES'
      ? (book?.asks ?? []).map((a) => ({ price: Number(a.price), size: Number(a.size) }))
      : (book?.bids ?? []).map((b) => ({ price: 1 - Number(b.price), size: Number(b.size) }))
  // A Market BUY commits a tick-snapped CEILING from walking the book (worst price the stake would
  // touch + slippage pad) so the fill is at-or-better and the committed shares are a guaranteed
  // MINIMUM (surplus → pool, FC-4 Q4). A Limit order rests at the user's (tick-snapped) limit price.
  const isLimit = orderKind === 'LIMIT'
  const effectivePrice = isLimit
    ? roundToTick(limitCents / 100, tickSize)
    : marketBuyCeilingFromBook(sideLevels, amount, tickSize, bestAsk)
  const shares = effectivePrice > 0 ? Math.floor(amount / effectivePrice) : 0

  // Error prevention: surface affordability on the rail BEFORE the user opens the modal and pays for
  // a proof. Mirror BetModal's guard exactly — combinable = the largest MAX_CONSOLIDATE_INPUTS free
  // notes (the most that can merge into one bet), then maxBettable backs out the Vault-injected fee.
  const { address } = useAccount()
  const [combinableBalance, setCombinableBalance] = useState(0n)
  useEffect(() => {
    if (!address) { setCombinableBalance(0n); return }
    const recompute = () => {
      const sum = getFreeNotes(address)
        .sort((a, b) => (a.balance > b.balance ? -1 : 1))
        .slice(0, MAX_CONSOLIDATE_INPUTS)
        .reduce((s, n) => s + n.balance, 0n)
      setCombinableBalance(sum)
    }
    recompute()
    window.addEventListener('polyshield:notes-changed', recompute)
    return () => window.removeEventListener('polyshield:notes-changed', recompute)
  }, [address])
  const { data: feeConfigData } = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: 'feeConfig',
    query: { enabled: VAULT_ADDRESS !== '0x0000000000000000000000000000000000000000' },
  })
  const betFeeBps = feeConfigData ? BigInt(feeConfigData[0]) : 0n
  const relayGasFeeUSDC = feeConfigData ? BigInt(feeConfigData[1]) : 0n
  const maxBettable =
    combinableBalance <= relayGasFeeUSDC
      ? 0n
      : ((combinableBalance - relayGasFeeUSDC) * 10_000n) / (10_000n + betFeeBps)
  const amountMicro = Number.isFinite(amount) && amount > 0 ? BigInt(Math.round(amount * 1_000_000)) : 0n
  const noFunds = combinableBalance === 0n
  const exceedsBalance = amountMicro > 0n && amountMicro > maxBettable

  // Default the limit price to the current side's market price. Keyed on `side` only — not
  // `price` — so the user's manual limit edits aren't clobbered every 10s when the polled
  // market price drifts. Reads the latest price at the moment the side flips.
  useEffect(() => {
    // Default to the current market price, kept to 2 decimals of a cent (Polymarket prices are
    // fractional and can sit below 1¢ or above 99¢).
    setLimitCents(Math.max(0.01, Math.min(99.99, Math.round(price * 10000) / 100)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side])

  const closeModal = () => {
    setModalOpen(false)
    const next = new URLSearchParams(searchParams.toString())
    next.delete('modal')
    router.replace(next.toString() ? `/app/market/${id}?${next.toString()}` : `/app/market/${id}`)
  }

  // FC-15: honest states — no fixture market is ever shown. While the first load is in flight show a
  // spinner; if the market can't be resolved, show an unavailable notice instead of a fake market.
  if (!payload && status === 'loading') {
    // STATE-002: render the page chrome + layout-matched skeletons instead of a lone line of
    // mono text in a black void. Preserves perceived speed and the page's structure.
    return (
      <div>
        <div className="row hairline-b" style={{ padding: '12px 24px', gap: 12 }}>
          <Link href="/app/markets" className="btn btn-sm btn-ghost" style={{ textDecoration: 'none' }}>← Markets</Link>
          <div className="skeleton" style={{ width: 280, height: 16, borderRadius: 4 }} />
        </div>
        <div className="market-grid" style={{ padding: 24, gap: 20 }}>
          <div className="col gap-4">
            <div className="skeleton" style={{ height: 96 }} />
            <div className="skeleton" style={{ height: 220 }} />
            <div className="skeleton" style={{ height: 260 }} />
          </div>
          <div className="skeleton" style={{ height: 420 }} />
        </div>
        <span className="sr-only">Loading market…</span>
      </div>
    )
  }
  if (!payload && status === 'unavailable') {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <div className="body" style={{ marginBottom: 12 }}>This market is unavailable.</div>
        <Link href="/app/markets" className="btn btn-sm btn-cyan" style={{ textDecoration: 'none' }}>← Back to markets</Link>
      </div>
    )
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

      <div className="market-grid" style={{ gap: 0 }}>
        <div className="hairline-r" style={{ padding: 24, minWidth: 0 }}>
          <div className="row gap-6 mb-4" style={{ marginBottom: 16 }}>
            <div>
              <div className="micro">{yesLabel} probability</div>
              <div className="num" style={{ fontSize: 48, lineHeight: 1 }}>{market.yes.toFixed(2)}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 12 }}>
                <div style={{ height: 4, width: `${market.yes * 100}%`, background: 'var(--green)', borderRadius: 2 }} />
              </div>
              <div className="row mt-2" style={{ justifyContent: 'space-between', fontSize: 12, fontFamily: 'var(--mono)' }}>
                <span style={{ color: 'var(--green)' }}>{yesLabel} {market.yes.toFixed(2)}</span>
                <span style={{ color: 'var(--red)' }}>{noLabel} {(1 - market.yes).toFixed(2)}</span>
              </div>
            </div>
            <div className="col gap-1">
              {([
                ['Vol', fmtVol(market.vol), 'Total USDC traded in this market over its lifetime.'],
                ['Liq', fmtVol(market.liq), 'Order-book depth resting right now — how much you can trade against before moving the price.'],
                ['Traders', market.traders.toLocaleString(), 'Unique addresses that have traded this market.'],
              ] as [string, string, string][]).map(([label, value, hint]) => (
                <div key={label} className="row gap-3" style={{ justifyContent: 'space-between' }}>
                  <Tip label={hint}>
                    <span className="micro" tabIndex={0} style={{ fontSize: 9, cursor: 'help', borderBottom: '1px dotted var(--line-bright)' }}>{label}</span>
                  </Tip>
                  <span className="num" style={{ fontSize: 13 }}>{value}</span>
                </div>
              ))}
            </div>
          </div>

          <PriceChart tokenId={market.yesTokenId} fallback={market.yes} />

          <Tabs.Root value={tab} onValueChange={(v) => setTab(v as 'book' | 'fills' | 'rules')}>
          <Tabs.List className="row hairline-b mt-4" style={{ gap: 0, marginTop: 24 }} aria-label="Market details">
            {[
              ['book', 'Order book'],
              ['fills', 'Recent fills'],
              ['rules', 'Rules & sources'],
            ].map(([key, label]) => (
              <Tabs.Trigger
                key={key}
                value={key}
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
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          <Tabs.Content value="book">
            <div className="panel mt-4" style={{ padding: 0 }}>
              <div>
                <div className="row" style={{ padding: '8px 12px', fontSize: 10, color: 'var(--text-2)', fontFamily: 'var(--mono)', letterSpacing: '0.06em' }}>
                  <div style={{ width: 60 }}>PRICE</div>
                  <div style={{ flex: 1, textAlign: 'right' }}>SIZE</div>
                </div>
                {/* STATE-003: cap each side to an internally-scrolling region (nearest ~40 levels)
                    so a deep book doesn't stretch the whole page to thousands of pixels. */}
                <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                  {(book?.asks ?? []).slice(0, 40).map((ask, index) => (
                    <div key={`ask-${index}`} className="row" style={{ padding: '5px 12px', fontSize: 12, fontFamily: 'var(--mono)' }}>
                      <div style={{ width: 60, color: 'var(--red)' }}>{Number(ask.price).toFixed(3)}</div>
                      <div style={{ flex: 1, textAlign: 'right' }}>{Number(ask.size).toLocaleString()}</div>
                    </div>
                  ))}
                </div>
                <div className="row hairline-t hairline-b" style={{ padding: '6px 12px', justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: 12 }}>
                  <span style={{ color: 'var(--cyan)' }}>{price.toFixed(4)}</span>
                  <span style={{ color: 'var(--text-2)' }}>spread varies by book depth</span>
                </div>
                <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                  {(book?.bids ?? []).slice(0, 40).map((bid, index) => (
                    <div key={`bid-${index}`} className="row" style={{ padding: '5px 12px', fontSize: 12, fontFamily: 'var(--mono)' }}>
                      <div style={{ width: 60, color: 'var(--green)' }}>{Number(bid.price).toFixed(3)}</div>
                      <div style={{ flex: 1, textAlign: 'right' }}>{Number(bid.size).toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Tabs.Content>

          <Tabs.Content value="fills">
            <div className="panel mt-4" style={{ padding: 32, textAlign: 'center' }}>
              {/* Honest empty state — a per-market fills feed isn't wired yet. Showing fabricated
                  fills on a live money page reads as broken once noticed. */}
              <div className="small" style={{ color: 'var(--text-3)' }}>
                A recent-fills feed for this market isn’t available yet. Vault trades are visible in the{' '}
                <Link href="/explorer" style={{ color: 'var(--cyan)' }}>explorer</Link>.
              </div>
            </div>
          </Tabs.Content>

          <Tabs.Content value="rules">
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
          </Tabs.Content>
          </Tabs.Root>
        </div>

        <div style={{ padding: 24 }}>
          <div className="panel" style={{ padding: 0 }}>
            <div className="row hairline-b" style={{ padding: '12px 16px', justifyContent: 'space-between' }}>
              <div className="micro">PLACE PRIVATE BET</div>
              <span className="pill pill-cyan" style={{ fontSize: 10 }}><span className="dot" />&nbsp;ZK-AUTH</span>
            </div>
            <div style={{ padding: 16 }}>
              <ToggleGroup.Root type="single" value={side} onValueChange={(v) => { if (v) setSide(v as 'YES' | 'NO') }} aria-label="Bet side" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {(['YES', 'NO'] as const).map((choice) => (
                  <ToggleGroup.Item
                    key={choice}
                    value={choice}
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
                    {choice === 'YES' ? yesLabel : noLabel} · {choice === 'YES' ? market.yes.toFixed(2) : (1 - market.yes).toFixed(2)}
                  </ToggleGroup.Item>
                ))}
              </ToggleGroup.Root>

              <div className="mt-4">
                <div className="micro">AMOUNT (USDC)</div>
                <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-1)', border: '1px solid var(--line-strong)', borderRadius: 6, padding: '0 12px', marginTop: 8 }}>
                  <span className="mono" style={{ color: 'var(--text-2)', fontSize: 18, marginRight: 6 }}>$</span>
                  {/* String-backed money input (see AmountInput) — a controlled type=number dropped digits. */}
                  <AmountInput
                    value={amount}
                    onValueChange={(n) => setAmount(Math.max(0, n))}
                    ariaLabel="Bet amount in USDC"
                    style={{ fontSize: 22, padding: '10px 0' }}
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
                {/* Affordability up-front (error prevention): the user sees what they can bet before
                    paying for a proof, instead of dead-ending in the modal's "no balance" error. */}
                <div className="row mt-2" style={{ justifyContent: 'space-between', fontSize: 11, color: exceedsBalance ? 'var(--red)' : 'var(--text-2)' }}>
                  <span>Available <span className="num">${formatUsdc(combinableBalance)}</span></span>
                  <span>Max bettable <span className="num">${formatUsdc(maxBettable)}</span></span>
                </div>
              </div>

              <div className="hairline-t mt-4" style={{ paddingTop: 12 }}>
                <div className="row gap-2" style={{ alignItems: 'center' }}>
                  <div className="micro">ORDER TYPE</div>
                </div>
                <ToggleGroup.Root type="single" value={orderKind} onValueChange={(v) => { if (v) setOrderKind(v as OrderKind) }} aria-label="Order type" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
                  {(['MARKET', 'LIMIT'] as OrderKind[]).map((k) => (
                    <ToggleGroup.Item
                      key={k}
                      value={k}
                      className={`btn btn-sm ${orderKind === k ? 'btn-cyan' : 'btn-ghost'}`}
                      style={{ justifyContent: 'center', fontSize: 11 }}
                    >
                      {ORDER_KIND_LABEL[k]}
                    </ToggleGroup.Item>
                  ))}
                </ToggleGroup.Root>
                {isLimit ? (
                  <div className="mt-3">
                    <div className="micro">LIMIT PRICE (¢ / share)</div>
                    <input
                      type="number" min={0.01} max={99.99} step={0.01} value={limitCents}
                      onChange={(e) => setLimitCents(Number(e.target.value))}
                      onBlur={(e) => setLimitCents(Math.max(0.01, Math.min(99.99, Number(e.target.value) || 0.01)))}
                      aria-label="Limit price in cents per share"
                      style={{ width: '100%', background: 'var(--bg-1)', border: '1px solid var(--line-strong)', borderRadius: 6, padding: '8px 12px', marginTop: 6, color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 14 }}
                    />
                    <label className="row gap-2" style={{ alignItems: 'center', marginTop: 10, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={expiryEnabled}
                        onChange={(e) => setExpiryEnabled(e.target.checked)}
                        aria-label="Set an expiration for this limit order"
                      />
                      <span className="micro">SET EXPIRATION</span>
                    </label>
                    {expiryEnabled && (
                      <>
                        <div className="micro" style={{ marginTop: 10 }}>EXPIRES IN (MINUTES)</div>
                        <input
                          type="number" min={1} value={gtdMinutes}
                          onChange={(e) => setGtdMinutes(Math.max(1, Number(e.target.value) || 1))}
                          aria-label="Order expiry in minutes"
                          style={{ width: '100%', background: 'var(--bg-1)', border: '1px solid var(--line-strong)', borderRadius: 6, padding: '8px 12px', marginTop: 6, color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 14 }}
                        />
                      </>
                    )}
                    <div className="small mt-2" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                      Rests on the book at your limit price; the full stake is held until it fills, {expiryEnabled ? 'expires,' : 'you cancel,'} or partially fills (then reclaim the remainder).
                    </div>
                  </div>
                ) : (
                  <div className="small mt-2" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    Fills immediately at the best available price for whatever size the book offers now; any unfilled remainder of your stake is reclaimable afterward.
                  </div>
                )}
              </div>

              <div className="hairline-t mt-4" style={{ paddingTop: 12 }}>
                {/* FINDING: FUNC-001 — honest proof time (Groth16 in-browser proving is 30s–2min, not ~2s). */}
                {([
                  [isLimit ? 'Limit price' : 'Max price (ceiling)', effectivePrice.toFixed(3),
                    isLimit
                      ? 'The price you bid; the order rests on the book until the market trades at or below it.'
                      : 'The worst price your stake could fill at — walked from the live order book plus a small slippage pad. You commit a guaranteed-minimum number of shares; any surplus returns to the pool.'],
                  [isLimit ? 'Expected shares' : 'Minimum shares', shares.toLocaleString(),
                    'Shares ≈ stake ÷ price. For a market order this is the guaranteed minimum; a better fill yields more.'],
                  ['Order type', ORDER_KIND_LABEL[orderKind], undefined],
                  ...(isLimit && expiryEnabled ? [['Expires in', `${gtdMinutes} min`, 'If unfilled by this time the order is cancelled and your full stake becomes reclaimable.'] as [string, string, string]] : []),
                  ['Proof time', '30s–2min', 'A zero-knowledge proof is generated in your browser before the bet is submitted — this is roughly how long that takes.'],
                ] as [string, string, string | undefined][]).map(([label, value, hint]) => (
                  <div key={label} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                    {hint ? (
                      <Tip label={hint}>
                        <span className="small" tabIndex={0} style={{ fontSize: 12, cursor: 'help', borderBottom: '1px dotted var(--line-bright)' }}>{label}</span>
                      </Tip>
                    ) : (
                      <span className="small" style={{ fontSize: 12 }}>{label}</span>
                    )}
                    <span className="mono" style={{ fontSize: 12 }}>{value}</span>
                  </div>
                ))}
              </div>

              {noFunds ? (
                // First-run / never-deposited: route to deposit instead of opening a modal that
                // would error after the user has already invested clicks.
                <Link
                  href="/app/deposit"
                  className="btn btn-primary mt-4"
                  style={{ width: '100%', justifyContent: 'center', padding: '14px 0', fontSize: 14, textDecoration: 'none' }}
                >
                  Deposit USDC to bet
                </Link>
              ) : (
                <button
                  className="btn btn-primary mt-4"
                  onClick={() => setModalOpen(true)}
                  disabled={exceedsBalance || amountMicro <= 0n}
                  style={{ width: '100%', justifyContent: 'center', padding: '14px 0', fontSize: 14, opacity: exceedsBalance || amountMicro <= 0n ? 0.5 : 1 }}
                >
                  {exceedsBalance ? 'Amount exceeds balance' : 'Generate ZK proof & authorize'}
                </button>
              )}
              <div className="small mt-2" style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 11 }}>
                {noFunds
                  ? 'No deposited funds yet'
                  : exceedsBalance
                    ? `Most you can bet now: $${formatUsdc(maxBettable)}`
                    : 'Signed locally · proof relay'}
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
          sideLabel={sideLabel}
          initialAmount={amount}
          price={price}
          tickSize={tickSize}
          bestAsk={bestAsk}
          levels={sideLevels}
          orderKind={orderKind}
          limitCents={limitCents}
          expiryEnabled={expiryEnabled}
          gtdMinutes={gtdMinutes}
          onClose={closeModal}
          onSuccess={async () => {
            // no-op for now; modal drives portfolio refresh by local storage state
          }}
        />
      )}
    </div>
  )
}
