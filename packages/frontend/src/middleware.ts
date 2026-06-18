import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const hostname = request.headers.get('host') ?? ''
  const { pathname } = request.nextUrl

  // ── API access control ────────────────────────────────────────────────────
  // PolyShield does not offer a public API. The only internet-facing surface is
  // these Next.js /api/* routes (the proof-relay / signing-layer / indexer backends
  // are loopback-bound and only reachable through these server-side proxies). We
  // restrict /api/* to our own dApp so third parties cannot call it:
  //   - dev-only routes 404 outside development;
  //   - cross-site browser requests are rejected;
  //   - state-changing requests must be same-origin (or carry a matching Origin),
  //     which blocks header-less scripted (curl) abuse of the mutating proxies.
  // Server-to-server fetches from the route handlers to the backend do NOT pass
  // through middleware, so internal traffic is unaffected.
  if (pathname.startsWith('/api')) {
    const apiResponse = guardApi(request, pathname, hostname)
    if (apiResponse) return apiResponse
    return NextResponse.next()
  }

  // Local dev (localhost / 127.0.0.1 / any non-dot host): no subdomain routing.
  // Developers access /app/* directly.
  const isLocalDev =
    hostname.startsWith('localhost') ||
    hostname.startsWith('127.0.0.1') ||
    !hostname.includes('.')

  if (isLocalDev) return NextResponse.next()

  const isAppSubdomain = hostname.startsWith('app.')
  const isExplorerSubdomain = hostname.startsWith('explorer.')

  // explorer.polyshield.xyz → a single-page host that serves ONLY the /explorer page.
  if (isExplorerSubdomain) {
    // Framework paths, the /api proxies, and static assets (incl. ZK wasm/zkey) are served
    // from this host as-is — never redirected, or proving/data fetches would break.
    const isAsset =
      pathname.startsWith('/_next') ||
      pathname.startsWith('/api') ||
      pathname.startsWith('/circuits') ||
      pathname.startsWith('/zkeys') ||
      /\.[a-zA-Z0-9]+$/.test(pathname)
    if (isAsset) return NextResponse.next()

    // The explorer itself: subdomain root → serve /explorer; /explorer* → serve as-is.
    if (pathname === '/') {
      const url = request.nextUrl.clone()
      url.pathname = '/explorer'
      return NextResponse.rewrite(url)
    }
    if (pathname === '/explorer' || pathname.startsWith('/explorer/')) {
      return NextResponse.next()
    }

    // Any other page link from the shared nav/footer (Product, How, Docs, Roadmap, and
    // "Launch App" → /app/*) belongs to the apex/app hosts, not here. Redirect to the apex
    // root with the same path; the apex host's own rules then forward /app/* to app.<root>.
    const root = hostname.replace(/^explorer\./, '')
    const url = request.nextUrl.clone()
    url.hostname = root
    url.port = ''  // behind a TLS proxy: don't leak Next's internal :3000 into the redirect
    return NextResponse.redirect(url, 307)
  }

  // Canonicalize the explorer to its own subdomain: /explorer on the apex or app.* host
  // → 301 to explorer.<root>/ (strip a leading app./www. to get the root domain). Keeps
  // the relative `/explorer` links in TopNav/SiteFooter working in local dev (where
  // subdomain routing is disabled and /explorer is served directly).
  if (pathname === '/explorer' || pathname.startsWith('/explorer/')) {
    const root = hostname.replace(/^app\./, '').replace(/^www\./, '')
    const url = request.nextUrl.clone()
    url.hostname = `explorer.${root}`
    url.port = ''  // behind a TLS proxy: don't leak Next's internal :3000 into the redirect
    url.pathname = '/'
    return NextResponse.redirect(url, 301)
  }

  // app.polyshield.xyz/foo → internally serve /app/foo
  if (isAppSubdomain) {
    // Do NOT rewrite app routes, framework paths, or STATIC ASSETS. Rewriting public
    // assets (e.g. /circuits/deposit.wasm, /zkeys/*.zkey) to /app/... 404s them and breaks
    // ALL proof generation on the subdomain. Skip anything with a file extension, plus the
    // ZK asset dirs explicitly.
    // Shared top-level pages (not under /app) must serve as-is on the subdomain too —
    // otherwise e.g. /docs rewrites to /app/docs (404). These exist only at the root.
    // (/explorer is handled earlier — it 301s to the explorer.<root> subdomain.)
    const SHARED_TOP_LEVEL = ['/docs', '/how', '/roadmap']
    const isShared = SHARED_TOP_LEVEL.some((r) => pathname === r || pathname.startsWith(r + '/'))
    const skip =
      isShared ||
      pathname.startsWith('/app') ||
      pathname.startsWith('/_next') ||
      pathname.startsWith('/api') ||
      pathname.startsWith('/circuits') ||
      pathname.startsWith('/zkeys') ||
      /\.[a-zA-Z0-9]+$/.test(pathname)
    if (!skip) {
      const url = request.nextUrl.clone()
      url.pathname = `/app${pathname === '/' ? '/markets' : pathname}`
      return NextResponse.rewrite(url)
    }
    return NextResponse.next()
  }

  // polyshield.xyz/app/* → 301 to app.polyshield.xyz/*
  if (pathname.startsWith('/app')) {
    const url = request.nextUrl.clone()
    url.hostname = `app.${hostname.replace(/^www\./, '')}`
    url.port = ''  // behind a TLS proxy: don't leak Next's internal :3000 into the redirect
    url.pathname = pathname.slice(4) || '/'  // strip leading /app
    return NextResponse.redirect(url, 301)
  }

  return NextResponse.next()
}

/**
 * Restrict /api/* to our own dApp. Returns a response to short-circuit (block) the
 * request, or null to allow it to proceed.
 */
function guardApi(request: NextRequest, pathname: string, hostname: string): NextResponse | null {
  // Dev-only routes are never available in production.
  if (pathname.startsWith('/api/dev') && process.env.NEXT_PUBLIC_DEV_MODE !== 'true') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  // Reject any cross-site browser request (another website calling our API).
  const secFetchSite = request.headers.get('sec-fetch-site')
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'same-site') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // State-changing requests must demonstrably originate from our own page. A same-origin
  // fetch sends Sec-Fetch-Site: same-origin; a header-less direct call (e.g. curl) has
  // neither that nor a matching Origin and is rejected. Reads (GET/HEAD) stay lenient so
  // prefetch/navigation are unaffected; the cross-site check above still applies to them.
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const sameOrigin = secFetchSite === 'same-origin' || secFetchSite === 'same-site'
    const origin = request.headers.get('origin')
    let originOk = false
    if (origin) {
      try {
        originOk = new URL(origin).host === hostname
      } catch {
        originOk = false
      }
    }
    if (!sameOrigin && !originOk) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  }

  return null
}

export const config = {
  // Skip static assets — only run middleware on real page/API routes.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
}
