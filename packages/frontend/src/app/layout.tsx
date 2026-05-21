import type { Metadata } from 'next'
import '@/styles/globals.css'
import { Providers } from '@/providers'
import { TopNav } from '@/components/ui/TopNav'
import { DevStatusBar } from '@/components/app/DevStatusBar'

export const metadata: Metadata = {
  title: 'Polyshield — Private prediction market trading',
  description: 'Zero-knowledge vault layer for Polymarket. Deposit USDC, place trades from a shared anonymity set, and settle privately.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <TopNav />
          {children}
          <DevStatusBar />
        </Providers>
      </body>
    </html>
  )
}
