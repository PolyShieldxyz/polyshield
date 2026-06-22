/**
 * Resolve the live CLOB midpoint for each held position/order, keyed by receipt id — and flag whether
 * a missing price is because the market has RESOLVED/ENDED (not just a transient blip).
 *
 * A receipt stores the market's real `raw_condition_id` and the held `side`, but NOT the outcome's
 * CLOB token id or a price. So per distinct market we: resolve conditionId → yesTokenId (cached for
 * the session — token ids don't change), then batch the YES midpoints in one `/api/markets/prices`
 * call. The caller turns yesMid into the held side's mark via lib/positionPricing.
 *
 * `resolving`: when a held token's midpoint is GONE, we re-check `/api/markets/:conditionId` — a 404
 * means the market has left the bettable catalog (resolved/ended → no order book), vs a 200 which means
 * the price is just momentarily unavailable (a blip). This lets the UI show "Resolving…" for a settled
 * market instead of a blank/"—" that looks broken, WITHOUT mislabeling a live position during a blip.
 * Only trusted for a REAL conditionId (raw_condition_id) — a recovered note's field-safe id never
 * resolves in the catalog, so we never infer "resolving" from it.
 *
 * Public-data only (a conditionId + public midpoints) — no secret leaves the client.
 */

import { useEffect, useRef, useState } from 'react'
import type { Note } from './notes'

const CID_RE = /^0x[0-9a-f]{64}$/

export interface PositionMark {
  mark: number | null // live YES midpoint (0–1), or null if unavailable
  resolving: boolean // market gone from the bettable catalog (resolved/ended) → price won't return
}

export function usePositionMarks(receipts: Note[], pollKey: number): Record<string, PositionMark> {
  const [marks, setMarks] = useState<Record<string, PositionMark>>({})
  // conditionId → yesTokenId ('' = looked up, no token). Persists across polls; token ids are stable.
  const tokenCacheRef = useRef<Record<string, string>>({})
  // conditionIds confirmed gone from the bettable catalog (a re-check 404'd) → resolved/ended. Cached
  // so a settled market is re-checked once, not every poll.
  const resolvedRef = useRef<Set<string>>(new Set())

  const condOf = (r: Note): string | undefined => (r.raw_condition_id ?? r.condition_id)?.toLowerCase()
  // Re-run when the set of markets changes or the poll ticks (refresh prices).
  const condKey = receipts.map((r) => `${r.id}:${condOf(r) ?? ''}`).join(',')

  useEffect(() => {
    if (receipts.length === 0) { setMarks({}); return }
    let cancelled = false
    void (async () => {
      const conds = [...new Set(receipts.map(condOf).filter((c): c is string => !!c && CID_RE.test(c)))]

      // 1. Resolve any not-yet-known yesTokenIds (cached; one fetch per new market, ever).
      await Promise.all(
        conds.map(async (c) => {
          if (tokenCacheRef.current[c] !== undefined) return
          try {
            const res = await fetch(`/api/markets/${c}`, { cache: 'no-store' })
            const tok = res.ok ? ((await res.json())?.market?.yesTokenId as string | undefined) : undefined
            tokenCacheRef.current[c] = tok ?? ''
          } catch {
            tokenCacheRef.current[c] = ''
          }
        }),
      )

      // 2. Batch the live YES midpoints for all resolved tokens in one request.
      const tokenIds = [...new Set(conds.map((c) => tokenCacheRef.current[c]).filter((t) => !!t))]
      let prices: Record<string, number> = {}
      if (tokenIds.length > 0) {
        try {
          const res = await fetch(`/api/markets/prices?ids=${tokenIds.join(',')}`, { cache: 'no-store' })
          if (res.ok) prices = ((await res.json()) as { prices?: Record<string, number> }).prices ?? {}
        } catch {
          /* leave prices empty → marks null */
        }
      }

      // 3. A held token whose midpoint is GONE: re-check the catalog ONCE to tell a resolved/ended
      // market (404 → no order book) from a transient price blip (still listed). Cache the verdict.
      const missing = conds.filter((c) => {
        const tok = tokenCacheRef.current[c]
        return !!tok && prices[tok] == null && !resolvedRef.current.has(c)
      })
      await Promise.all(
        missing.map(async (c) => {
          try {
            const res = await fetch(`/api/markets/${c}`, { cache: 'no-store' })
            if (!res.ok) resolvedRef.current.add(c) // gone from the bettable catalog → resolved/ended
          } catch {
            /* transient — leave unresolved; a later poll retries */
          }
        }),
      )

      // 4. Map back to each receipt's mark + resolving flag.
      const out: Record<string, PositionMark> = {}
      for (const r of receipts) {
        const c = condOf(r)
        const tok = c ? tokenCacheRef.current[c] : ''
        const mid = tok ? prices[tok] : undefined
        const mark = mid != null && Number.isFinite(mid) ? mid : null
        const resolving = !!r.raw_condition_id && !!c && (tokenCacheRef.current[c] === '' || resolvedRef.current.has(c))
        out[r.id] = { mark, resolving }
      }
      if (!cancelled) setMarks(out)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [condKey, pollKey])

  return marks
}
