import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import '@/styles/globals.css'
import { Providers } from '@/providers'
import { TopNav } from '@/components/ui/TopNav'
import { SiteFooterGate } from '@/components/ui/SiteFooterGate'
import { DevStatusBar } from '@/components/app/DevStatusBar'
import { SITE_URL, TWITTER_HANDLE } from '@/lib/brand'

// FINDING: PRIV-002 / PERF-002 — self-host fonts via next/font instead of the
// third-party Google Fonts CDN @import (which leaked visitor IP/Referer to Google
// and render-blocked). Weights mirror the previous @import exactly. Exposed as CSS
// variables (--font-inter / --font-mono) consumed by --sans / --mono in globals.css.
const inter = Inter({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-inter',
  display: 'swap',
})
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
})

const TITLE = 'PolyShield — Private prediction market trading'
const DESCRIPTION =
  'Zero-knowledge vault layer for Polymarket. Deposit USDC, place trades from a shared anonymity set, and settle privately.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'PolyShield',
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    site: TWITTER_HANDLE,
    creator: TWITTER_HANDLE,
    title: TITLE,
    description: DESCRIPTION,
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        {/* FINDING: A11Y-003 — skip link + <main> landmark for keyboard/screen-reader users. */}
        <a href="#main" className="sr-only-focusable">Skip to main content</a>
        <Providers>
          <TopNav />
          <main id="main">{children}</main>
          <SiteFooterGate />
          <DevStatusBar />
        </Providers>
      </body>
    </html>
  )
}
