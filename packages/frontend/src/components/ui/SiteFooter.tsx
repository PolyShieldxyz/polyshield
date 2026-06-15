import Link from 'next/link'
import { Logo } from './Logo'
import { Icon, ICONS } from './Icon'
import { NETWORK_STATUS } from '@/lib/brand'

// Only link to destinations that actually exist today. Dead "Coming soon"
// placeholders (Markets/Vault/SDK/Press/Whitepaper/Legal/…) were removed for the
// mainnet beta — an empty footer of disabled spans reads as unfinished.
const FOOTER_LINKS: { href: string; label: string }[] = [
  { href: '/', label: 'Product' },
  { href: '/how', label: 'How It Works' },
  { href: '/docs', label: 'Docs' },
  { href: '/roadmap', label: 'Roadmap' },
  { href: '/explorer', label: 'Explorer' },
]

export function SiteFooter() {
  const vaultAddr = process.env.NEXT_PUBLIC_VAULT_ADDRESS
  const addrDisplay = vaultAddr ? `${vaultAddr.slice(0, 6)}…${vaultAddr.slice(-4)}` : 'VAULT TBD'
  return (
    <footer style={{ borderTop: '1px solid var(--line)', marginTop: 120, background: 'linear-gradient(180deg, transparent, rgba(255,255,255,0.012))' }}>
      <div className="container" style={{ padding: '72px 32px 32px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 48 }}>
          <div>
            <Logo />
            <div className="small mt-4" style={{ maxWidth: 280 }}>
              Zero-knowledge privacy infrastructure for prediction markets.
              Built for traders who treat conviction as an asset.
            </div>
            {/* X / Twitter and GitHub only — destinations to be wired up; rendered as
                disabled placeholders until the handles are live. Discord removed. */}
            <div className="row gap-3 mt-6">
              <span className="btn btn-sm btn-ghost" role="link" aria-disabled="true" title="Coming soon" aria-label="X / Twitter (coming soon)" style={{ cursor: 'not-allowed', opacity: 0.5 }}>
                <Icon d={ICONS.twitter} />
              </span>
              <span className="btn btn-sm btn-ghost" role="link" aria-disabled="true" title="Coming soon" aria-label="GitHub (coming soon)" style={{ cursor: 'not-allowed', opacity: 0.5 }}>
                <Icon d={ICONS.github} />
              </span>
            </div>
          </div>
          <div>
            <div className="micro">Explore</div>
            <div className="col gap-2 mt-3">
              {FOOTER_LINKS.map((l) => (
                <Link key={l.href} href={l.href} className="small" style={{ color: 'var(--text-2)' }}>{l.label}</Link>
              ))}
            </div>
          </div>
        </div>
        <div className="row hairline-t mt-12" style={{ paddingTop: 24, justifyContent: 'space-between' }}>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
            POLYSHIELD · {addrDisplay} · {NETWORK_STATUS}
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
            © 2026 · NOT INVESTMENT ADVICE
          </div>
        </div>
      </div>
    </footer>
  )
}
