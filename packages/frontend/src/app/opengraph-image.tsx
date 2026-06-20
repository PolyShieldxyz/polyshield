import { ImageResponse } from 'next/og'

// SEO: code-generated 1200x630 social share card. Fixes blank/broken link
// previews on X, Discord, Telegram (twitter:card was summary_large_image with
// no image). Next wires this into BOTH og:image and twitter:image automatically.
export const runtime = 'nodejs'
export const alt = 'PolyShield — private prediction market trading on Polymarket'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const BG = '#14151c'
const GOLD = '#E3B956'
const INK1 = '#DDE2EA'
const INK2 = '#8B94A2'
const LINE = 'rgba(255,255,255,0.10)'

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: `radial-gradient(900px 500px at 80% -10%, rgba(227,185,86,0.10), ${BG})`,
          padding: '72px 80px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          {/* shield mark */}
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none">
            <path d="M12 2 L20 5 V11 C20 16 16.5 19.5 12 22 C7.5 19.5 4 16 4 11 V5 Z" fill="none" stroke={GOLD} strokeWidth="1.6" />
            <circle cx="12" cy="10.5" r="2.4" fill={GOLD} />
            <rect x="11.1" y="11.6" width="1.8" height="4.4" rx="0.9" fill={GOLD} />
          </svg>
          <div style={{ fontSize: 34, fontWeight: 600, color: INK1, letterSpacing: '-0.01em' }}>PolyShield</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <div style={{ fontSize: 72, fontWeight: 700, color: INK1, lineHeight: 1.05, letterSpacing: '-0.03em', maxWidth: 940 }}>
            Trade prediction markets, privately.
          </div>
          <div style={{ fontSize: 30, color: INK2, lineHeight: 1.35, maxWidth: 900 }}>
            A zero-knowledge vault for Polymarket. Deposit USDC, trade from a shared anonymity set, and settle privately.
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 28, borderTop: `1px solid ${LINE}`, paddingTop: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 22, color: GOLD, fontWeight: 600 }}>polyshield.xyz</div>
          <div style={{ display: 'flex', fontSize: 20, color: INK2 }}>Zero-knowledge proofs · Non-custodial · Polygon</div>
        </div>
      </div>
    ),
    { ...size },
  )
}
