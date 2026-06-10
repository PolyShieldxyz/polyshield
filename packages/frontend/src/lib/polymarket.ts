/**
 * Live Polymarket market data (SERVER-ONLY — used by /api/markets routes).
 *
 * Replaces the hardcoded fixtures in lib/marketsData.ts with the real Polymarket
 * universe. The Gamma API (gamma-api.polymarket.com) is the listing source (question,
 * conditionId, prices, volume, clobTokenIds); the CLOB API serves the live order book.
 *
 * The Polyshield UI is binary YES/NO, so non-binary markets ("X vs Y", multi-outcome)
 * are filtered out. Each LiveMarket carries the REAL conditionId + YES/NO clobTokenIds —
 * the conditionId flows through the bet flow as market_id. (Actual order EXECUTION against
 * Polymarket still requires the signing layer to resolve conditionId→tokenId; see the
 * deploy notes — this module makes the frontend show/operate on real markets.)
 */

const GAMMA = process.env.GAMMA_API_URL ?? 'https://gamma-api.polymarket.com'
const CLOB = process.env.POLY_API_URL ?? 'https://clob.polymarket.com'

export type LiveMarket = {
  id: string // = conditionId (route key for /app/market/[id])
  conditionId: `0x${string}`
  cat: string
  name: string
  yes: number
  delta: number
  vol: number
  liq: number
  traders: number
  resolves: string
  endTs: number // endDate as epoch ms (0 if unknown); used for "Resolves soon" sort
  trend: number[]
  desc?: string
  yesTokenId?: string
  noTokenId?: string
  outcomeLabels?: [string, string] // real outcome names, e.g. ["Up","Down"]; YES=side 0, NO=side 1
  acceptingOrders?: boolean
  source?: 'live'
}

type GammaTag = { label?: string; slug?: string }

type GammaMarket = {
  conditionId?: string
  question?: string
  slug?: string
  description?: string
  category?: string | null
  tags?: GammaTag[] // present when the query passes include_tag=true
  outcomes?: string // JSON string e.g. '["Yes","No"]'
  outcomePrices?: string // JSON string e.g. '["0.71","0.29"]'
  clobTokenIds?: string // JSON string of token id decimals
  volumeNum?: number
  liquidityNum?: number
  endDate?: string | null
  oneDayPriceChange?: number
  enableOrderBook?: boolean
  acceptingOrders?: boolean
  active?: boolean
  closed?: boolean
}

// Polymarket's `category` field is almost always null; real categorization lives in the
// per-market `tags` array (e.g. "Crypto Prices", "Politics", "Soccer"). Map a tag onto one
// of the UI's fixed buckets. Order matters: the FIRST matching tag (in Gamma's tag order,
// which leads with the primary category) wins, so check buckets per-tag.
const TAG_BUCKETS: Array<[RegExp, string]> = [
  [/crypto|bitcoin|ethereum|solana|memecoin|defi|\bbtc\b|\beth\b|\bxrp\b|dogecoin/, 'CRYPTO'],
  [/geopolit|iran|israel|russia|ukraine|china|taiwan|\bwar\b|middle.?east|nato|gaza/, 'GEO'],
  [/econ|\bfed\b|interest.?rate|inflation|recession|\bgdp\b|\bcpi\b|jobs|macro/, 'MACRO'],
  [/\bai\b|artificial|technology|\btech\b|science|space|software|openai/, 'TECH'],
  [/sport|soccer|football|\bnfl\b|\bnba\b|\bmlb\b|fifa|tennis|\bufc\b|\bf1\b|hockey|baseball|basketball|golf/, 'SPORTS'],
  [/politic|election|trump|biden|congress|senate|president|\bgov\b|democrat|republican/, 'POLITICS'],
  [/culture|entertain|movie|music|award|celebr|\btv\b|oscar|grammy|\bpop\b/, 'CULTURE'],
]

function categoryFromTags(tags: GammaTag[] | undefined, fallback: string | null | undefined): string {
  for (const t of tags ?? []) {
    const s = `${t.slug ?? ''} ${t.label ?? ''}`.toLowerCase()
    for (const [re, bucket] of TAG_BUCKETS) if (re.test(s)) return bucket
  }
  return (fallback || 'OTHER').toUpperCase()
}

// Polyshield is a binary YES/NO vault, but Polymarket's short-dated recurring markets use
// ["Up","Down"]. Accept either pair (side 0 = YES-equivalent, side 1 = NO-equivalent) and
// reject everything else (multi-outcome, "X vs Y", etc.).
const BINARY_PAIRS: Array<[string, string]> = [
  ['yes', 'no'],
  ['up', 'down'],
]

function binaryIndices(outcomesLc: string[]): { yesIdx: number; noIdx: number; labels: [string, string] } | null {
  if (outcomesLc.length !== 2) return null
  for (const [a, b] of BINARY_PAIRS) {
    const yesIdx = outcomesLc.indexOf(a)
    const noIdx = outcomesLc.indexOf(b)
    if (yesIdx >= 0 && noIdx >= 0) {
      return { yesIdx, noIdx, labels: [a === 'yes' ? 'Yes' : 'Up', b === 'no' ? 'No' : 'Down'] }
    }
  }
  return null
}

// Collapse a recurring market's slug to its series key by stripping the trailing epoch
// suffix: "btc-updown-5m-1780936500" → "btc-updown-5m". Distinct windows of the same series
// (5m vs 15m vs 4h) keep distinct keys, so each granularity surfaces once. Returns '' for
// non-recurring markets (no numeric suffix) so they are never collapsed together.
function seriesKey(slug: string | undefined): string {
  if (!slug) return ''
  const m = /^(.*)-\d{6,}$/.exec(slug)
  return m ? m[1] : ''
}

function parseJsonArray(s: string | undefined): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Map a Gamma market to a binary LiveMarket, or null if it isn't a tradeable YES/NO market. */
export function toBinaryMarket(m: GammaMarket): LiveMarket | null {
  const cid = (m.conditionId ?? '').toLowerCase()
  if (!cid.startsWith('0x') || cid.length !== 66) return null
  if (!m.enableOrderBook) return null

  const outcomes = parseJsonArray(m.outcomes).map((o) => o.toLowerCase())
  const bin = binaryIndices(outcomes)
  if (!bin) return null // not a binary YES/NO or Up/Down market
  const { yesIdx, noIdx, labels } = bin

  const prices = parseJsonArray(m.outcomePrices).map(Number)
  const tokens = parseJsonArray(m.clobTokenIds)
  const yes = Number.isFinite(prices[yesIdx]) ? prices[yesIdx] : 0.5
  const endMs = m.endDate ? new Date(m.endDate).getTime() : NaN

  return {
    id: cid,
    conditionId: cid as `0x${string}`,
    cat: categoryFromTags(m.tags, m.category),
    name: m.question ?? 'Untitled market',
    yes,
    delta: typeof m.oneDayPriceChange === 'number' ? m.oneDayPriceChange : 0,
    vol: m.volumeNum ?? 0,
    liq: m.liquidityNum ?? 0,
    traders: 0, // not provided by Gamma
    resolves: fmtDate(m.endDate),
    endTs: Number.isFinite(endMs) ? endMs : 0,
    trend: [yes, yes], // Gamma listing has no cheap price history; flat placeholder
    desc: m.description,
    yesTokenId: tokens[yesIdx],
    noTokenId: tokens[noIdx],
    outcomeLabels: labels,
    acceptingOrders: !!m.acceptingOrders,
    source: 'live',
  }
}

async function fetchGamma(query: string): Promise<GammaMarket[]> {
  const res = await fetch(`${GAMMA}/markets?${query}&include_tag=true`, { next: { revalidate: 30 } })
  if (!res.ok) return []
  const data = (await res.json()) as unknown
  return Array.isArray(data) ? (data as GammaMarket[]) : []
}

/**
 * Live binary markets for the listing page. Two sources, merged and de-duplicated:
 *  1. Top markets by 24h volume — the deep, headline markets (mostly long-dated).
 *  2. Soonest-resolving markets — so short-dated markets (incl. Bitcoin/ETH "Up or Down"
 *     5m/15m/1h/daily) are reachable for quick end-to-end testing instead of waiting months.
 * Recurring series (slug `…-<epoch>`) are collapsed to one entry per series at its nearest
 * open window, so the list isn't flooded with hundreds of identical 5-minute markets.
 * Returns [] only if Gamma is entirely unreachable.
 */
export async function fetchLiveMarkets(limit = 48): Promise<LiveMarket[]> {
  try {
    const nowIso = new Date().toISOString()
    const [volRaw, soonRaw] = await Promise.all([
      fetchGamma(`closed=false&active=true&limit=100&order=volume24hr&ascending=false`),
      fetchGamma(`closed=false&active=true&limit=100&order=endDate&ascending=true&end_date_min=${encodeURIComponent(nowIso)}`),
    ])

    const byCid = new Map<string, LiveMarket>()
    const seenSeries = new Set<string>()

    const add = (raw: GammaMarket[], collapseSeries: boolean, cap: number) => {
      let added = 0
      for (const m of raw) {
        if (added >= cap) break
        const lm = toBinaryMarket(m)
        if (!lm) continue
        if (byCid.has(lm.id)) continue
        if (collapseSeries) {
          const key = seriesKey(m.slug)
          if (key) {
            if (seenSeries.has(key)) continue
            seenSeries.add(key)
          }
        }
        byCid.set(lm.id, lm)
        added++
      }
    }

    add(volRaw, false, limit) // headline markets, no series collapsing
    add(soonRaw, true, 40) // soon-resolving, one entry per recurring series (incl. 5m/15m/1h/4h/daily windows)

    return [...byCid.values()]
  } catch {
    return []
  }
}

/** A single live market by conditionId, or null. */
export async function fetchLiveMarket(conditionId: string): Promise<LiveMarket | null> {
  try {
    const url = `${GAMMA}/markets?condition_ids=${encodeURIComponent(conditionId)}&include_tag=true`
    const res = await fetch(url, { next: { revalidate: 15 } })
    if (!res.ok) return null
    const data = (await res.json()) as GammaMarket[]
    if (!Array.isArray(data) || data.length === 0) return null
    return toBinaryMarket(data[0])
  } catch {
    return null
  }
}

export type OrderBook = {
  bids?: Array<{ price: string; size: string }>
  asks?: Array<{ price: string; size: string }>
  hash?: string
}

export type PricePoint = { t: number; p: number }

// UI range button → Polymarket CLOB prices-history params. Polymarket's `interval` uses
// "1m" = one MONTH (not minute) and "max" = all history; `fidelity` is the bucket size in
// minutes (smaller = finer). Tuned per range so each returns a sensible point count.
const RANGE_TO_INTERVAL: Record<string, { interval: string; fidelity: number }> = {
  '1H': { interval: '1h', fidelity: 1 },
  '6H': { interval: '6h', fidelity: 2 },
  '1D': { interval: '1d', fidelity: 10 },
  '1W': { interval: '1w', fidelity: 60 },
  '1M': { interval: '1m', fidelity: 180 },
  ALL: { interval: 'max', fidelity: 720 },
}

/** Live price history for a token id over a UI range ("1H"|"6H"|"1D"|"1W"|"1M"|"ALL"). */
export async function fetchPriceHistory(tokenId: string, range: string): Promise<PricePoint[]> {
  const cfg = RANGE_TO_INTERVAL[range] ?? RANGE_TO_INTERVAL['1D']
  try {
    const res = await fetch(
      `${CLOB}/prices-history?market=${encodeURIComponent(tokenId)}&interval=${cfg.interval}&fidelity=${cfg.fidelity}`,
      { next: { revalidate: 10 } },
    )
    if (!res.ok) return []
    const data = (await res.json()) as { history?: unknown }
    const hist = Array.isArray(data?.history) ? data.history : []
    return hist
      .map((x) => ({ t: Number((x as PricePoint).t), p: Number((x as PricePoint).p) }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.p))
  } catch {
    return []
  }
}

/** Live CLOB order book for a token id. */
export async function fetchBook(tokenId: string): Promise<OrderBook | null> {
  try {
    const res = await fetch(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`, {
      next: { revalidate: 5 },
    })
    if (!res.ok) return null
    return (await res.json()) as OrderBook
  } catch {
    return null
  }
}

/**
 * Live CLOB minimum tick size for a token id (e.g. 0.01 / 0.001). The frontend snaps the bet
 * price to this tick at proof time so the committed price matches what the CLOB executes against
 * (see lib/pricing.ts). Defaults to 0.001 (Polymarket's finest) on any failure — the SAME default
 * the signing layer's budgetedBuyOrder uses, so the two stay consistent.
 */
export async function fetchTickSize(tokenId: string): Promise<number> {
  try {
    const res = await fetch(`${CLOB}/tick-size?token_id=${encodeURIComponent(tokenId)}`, {
      next: { revalidate: 60 },
    })
    if (!res.ok) return 0.001
    const data = (await res.json()) as { minimum_tick_size?: number | string }
    const t = Number(data?.minimum_tick_size)
    return Number.isFinite(t) && t > 0 ? t : 0.001
  } catch {
    return 0.001
  }
}
