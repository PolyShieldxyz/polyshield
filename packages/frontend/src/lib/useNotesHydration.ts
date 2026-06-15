'use client'

/**
 * FC-13: gate note-reading UI on the encrypted-cache hydration.
 *
 * The note cache now lives in IndexedDB (encrypted) and is read asynchronously into the in-memory
 * working set by hydrateCache(). All the synchronous note getters (getCurrentCashNote, getNotes,
 * loadPortfolioState, …) read that in-memory set, which is empty until hydration finishes. This
 * hook runs hydration once on mount and returns `ready`; the app subtree renders its note-reading
 * screens only once `ready` is true, so nothing reads an empty cache on first paint.
 */

import { useEffect, useState } from 'react'
import { hydrateCache } from './notes'

export function useNotesHydration(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    void hydrateCache().finally(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return ready
}
