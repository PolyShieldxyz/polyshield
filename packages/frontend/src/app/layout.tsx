import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import '@/styles/globals.css'
import { Providers } from '@/providers'
import { TopNav } from '@/components/ui/TopNav'
import { SiteFooterGate } from '@/components/ui/SiteFooterGate'
import { DevStatusBar } from '@/components/app/DevStatusBar'
import { SITE_URL, TWITTER_HANDLE, TWITTER_URL, GITHUB_URL } from '@/lib/brand'

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

// SEO: the social/share/brand title (used for OG + Twitter cards), and the
// keyword-led <title> shown in the browser tab and the SERP. They can differ —
// the SERP title leads with the highest-intent keyword ("Polymarket").
const BRAND_TITLE = 'PolyShield — Private prediction market trading'
const SEO_TITLE = 'Private Polymarket Trading — PolyShield ZK Vault'
const DESCRIPTION =
  'Zero-knowledge vault layer for Polymarket. Deposit USDC, place trades from a shared anonymity set, and settle privately. Non-custodial, on Polygon — start trading privately.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SEO_TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'PolyShield',
    title: BRAND_TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    site: TWITTER_HANDLE,
    creator: TWITTER_HANDLE,
    title: BRAND_TITLE,
    description: DESCRIPTION,
  },
}

// SEO/AEO: sitewide structured data. Organization + WebSite establish the brand
// entity (Knowledge Graph / sitelinks search box); SoftwareApplication describes
// the product so it can earn rich results and be cited by answer engines.
const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: 'PolyShield',
      url: SITE_URL,
      description: DESCRIPTION,
      sameAs: [TWITTER_URL, GITHUB_URL],
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'PolyShield',
      publisher: { '@id': `${SITE_URL}/#organization` },
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_URL}/#app`,
      name: 'PolyShield',
      applicationCategory: 'FinanceApplication',
      operatingSystem: 'Web',
      url: SITE_URL,
      description: DESCRIPTION,
      publisher: { '@id': `${SITE_URL}/#organization` },
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        {/* SEO/AEO: sitewide Organization + WebSite + SoftwareApplication schema. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
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
