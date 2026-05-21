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
    if (
      !pathname.startsWith('/app') &&
      !pathname.startsWith('/_next') &&
      !pathname.startsWith('/api')
    ) {
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
    url.pathname = pathname.slice(4) || '/'  // strip leading /app
    return NextResponse.redirect(url, 301)
  }

  return NextResponse.next()
}

export const config = {
  // Skip static assets — only run middleware on real page/API routes.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
}
