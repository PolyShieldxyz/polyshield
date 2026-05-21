'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Logo } from './Logo'
import { Icon, ICONS } from './Icon'
import { WalletConnect } from './WalletConnect'

const NAV_LINKS: [string, string][] = [
  ['/', 'Product'],
  ['/how', 'How It Works'],
  ['/docs', 'Docs'],
  ['/roadmap', 'Roadmap'],
  ['/careers', 'Careers'],
]

export function TopNav() {
  const pathname = usePathname()
  const isApp = pathname.startsWith('/app')

  return (
    <div className="topnav">
      <div className="topnav-inner">
        <div className="row gap-6">
          <Link href="/" style={{ cursor: 'pointer' }}>
            <Logo />
          </Link>
          <div className="pill pill-soft" style={{ fontSize: 10 }}>
            <span className="dot" style={{ background: 'var(--green)', boxShadow: '0 0 8px var(--green)' }}></span>
            MAINNET ALPHA · v0.4.2
          </div>
        </div>
        <div className="nav-links">
          {NAV_LINKS.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className={`nav-link ${pathname === href ? 'active' : ''}`}
            >
              {label}
            </Link>
          ))}
        </div>
        <div className="row gap-3">
          <Link href="/testnet" className="btn btn-sm btn-ghost">Testnet</Link>
          <Link
            href="/app/markets"
            className={`btn btn-sm ${isApp ? 'btn-cyan' : 'btn-primary'}`}
          >
            {isApp ? 'In App' : 'Launch App'} <Icon d={ICONS.arrow} size={12} />
          </Link>
          <WalletConnect />
        </div>
      </div>
    </div>
  )
}
