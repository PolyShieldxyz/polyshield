'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { SiteFooter } from './SiteFooter'

// Renders the marketing footer on every static/landing page but never inside the
// dApp. Mirrors TopNav's app-vs-marketing detection: the dApp lives under /app
// (apex) or on the app.* subdomain (where middleware rewrites /markets -> /app/markets,
// so usePathname still reports the bare path — hence the host check).
export function SiteFooterGate() {
  const pathname = usePathname()
  const [appHost, setAppHost] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    setAppHost(window.location.hostname.startsWith('app.'))
  }, [])

  const isApp = pathname.startsWith('/app') || appHost
  if (isApp) return null
  return <SiteFooter />
}
