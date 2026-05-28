import { Logo } from './Logo'
import { Icon, ICONS } from './Icon'

const FOOTER_COLS = [
  { title: 'Product', links: ['Markets', 'Vault', 'Privacy Metrics', 'Settlement'] },
  { title: 'Developers', links: ['Docs', 'Circuits', 'SDK', 'GitHub'] },
  { title: 'Company', links: ['About', 'Careers', 'Roadmap', 'Press'] },
  { title: 'Resources', links: ['Threat Model', 'Audits', 'Whitepaper', 'Brand'] },
  { title: 'Legal', links: ['Privacy', 'Terms', 'Disclosures'] },
]

export function SiteFooter() {
  const vaultAddr = process.env.NEXT_PUBLIC_VAULT_ADDRESS
  const addrDisplay = vaultAddr ? `${vaultAddr.slice(0, 6)}…${vaultAddr.slice(-4)}` : 'VAULT TBD'
  return (
    <footer style={{ borderTop: '1px solid var(--line)', marginTop: 120, background: 'linear-gradient(180deg, transparent, rgba(255,255,255,0.012))' }}>
      <div className="container" style={{ padding: '72px 32px 32px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr repeat(5, 1fr)', gap: 48 }}>
          <div>
            <Logo />
            <div className="small mt-4" style={{ maxWidth: 280 }}>
              Zero-knowledge privacy infrastructure for prediction markets.
              Built for traders who treat conviction as an asset.
            </div>
            <div className="row gap-3 mt-6">
              <a className="btn btn-sm btn-ghost" href="#" aria-label="X / Twitter">
                <Icon d={ICONS.twitter} />
              </a>
              <a className="btn btn-sm btn-ghost" href="#" aria-label="GitHub">
                <Icon d={ICONS.github} />
              </a>
              <a className="btn btn-sm btn-ghost" href="#" aria-label="Discord">
                <Icon d={ICONS.discord} />
              </a>
            </div>
          </div>
          {FOOTER_COLS.map((c) => (
            <div key={c.title}>
              <div className="micro">{c.title}</div>
              <div className="col gap-2 mt-3">
                {c.links.map((l) => (
                  <a key={l} href="#" className="small" style={{ color: 'var(--text-1)' }}>{l}</a>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="row hairline-t mt-12" style={{ paddingTop: 24, justifyContent: 'space-between' }}>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
            POLYSHIELD LABS · {addrDisplay} · POLYGON AMOY TESTNET · BUILD 2026.05.20
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
            © 2026 · NOT INVESTMENT ADVICE
          </div>
        </div>
      </div>
    </footer>
  )
}
