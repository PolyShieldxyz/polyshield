import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const hostname = request.headers.get('host') ?? ''
  const { pathname } = request.nextUrl

  // Local dev (localhost / 127.0.0.1 / any non-dot host): no subdomain routing.
  // Developers access /app/* directly.
  const isLocalDev =
    hostname.startsWith('localhost') ||
    hostname.startsWith('127.0.0.1') ||
    !hostname.includes('.')

  if (isLocalDev) return NextResponse.next()

  const isAppSubdomain = hostname.startsWith('app.')

  // app.polyshield.xyz/foo → internally serve /app/foo
  if (isAppSubdomain) {
    // Do NOT rewrite app routes, framework paths, or STATIC ASSETS. Rewriting public
    // assets (e.g. /circuits/deposit.wasm, /zkeys/*.zkey) to /app/... 404s them and breaks
    // ALL proof generation on the subdomain. Skip anything with a file extension, plus the
    // ZK asset dirs explicitly.
    // Shared top-level pages (not under /app) must serve as-is on the subdomain too —
    // otherwise e.g. /explorer rewrites to /app/explorer (404). These exist only at the root.
    const SHARED_TOP_LEVEL = ['/explorer', '/docs', '/how', '/roadmap', '/careers', '/testnet']
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

export const config = {
  // Skip static assets — only run middleware on real page/API routes.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
}
