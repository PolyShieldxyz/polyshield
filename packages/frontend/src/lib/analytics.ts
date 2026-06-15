/**
 * FC-15: anonymous, aggregate engagement analytics (client helper).
 *
 * Fire-and-forget POST to /api/analytics → proof-relay, which stores ONLY aggregate (scope,key)
 * counters. NO wallet address, no IP, no stable/session id is ever sent — this must stay anonymous
 * (tying browsing to a wallet would be a deanonymization vector for the protocol). Uses sendBeacon
 * when available so a `market_view` survives the navigation it triggers. All failures are swallowed.
 */

export type AnalyticsEvent = {
  // Bounded scopes (the backend rejects anything else): what the user engaged with.
  scope: 'market_view' | 'tag_click' | 'sort_change' | 'category_click' | 'search_query' | 'search_live'
  key: string // conditionId / tag / sort option / category / search term
}

export function track(events: AnalyticsEvent[]): void {
  if (typeof window === 'undefined' || events.length === 0) return
  try {
    const body = JSON.stringify({ events })
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/api/analytics', new Blob([body], { type: 'application/json' }))
    } else {
      void fetch('/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {})
    }
  } catch {
    /* analytics is best-effort; never disrupt the UI */
  }
}
