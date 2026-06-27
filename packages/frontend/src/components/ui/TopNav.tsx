'use client'

import Link from 'next/link'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Logo } from './Logo'
import { Icon, ICONS } from './Icon'
import { NETWORK_STATUS } from '@/lib/brand'
import { clearNoteCache } from '@/lib/notes'
import { clearSession } from '@/lib/secretSession'
import { formatUsdc } from '@/lib/notes'
import { usePortfolioState } from '@/lib/accountState'

const NAV_LINKS: [string, string][] = [
  ['/', 'Product'],
  ['/how', 'How It Works'],
  ['/docs', 'Docs'],
  ['/blog', 'Blog'],
  ['/roadmap', 'Roadmap'],
]

export function TopNav() {
  const pathname = usePathname()
  // Active if the path matches the link OR is a sub-route of it (e.g. /docs/overview
  // under /docs, now that docs is split into per-page routes). '/' only matches exactly.
  const isActive = (href: string) => pathname === href || (href !== '/' && pathname.startsWith(`${href}/`))
  // On the app.* subdomain the middleware rewrites "/markets" -> "/app/markets"
  // INTERNALLY, so usePathname() still reports "/markets". Detect the subdomain too,
  // otherwise the app pages render the marketing nav. (Brief first-paint flash on the
  // subdomain is expected — window isn't available during SSR.)
  const [appHost, setAppHost] = useState(false)
  // The dApp lives on the app.* subdomain (middleware 301s apex/app/* -> app.<host>/*).
  // A Next <Link> soft-navigates and won't reliably switch hosts, so "Launch App" must be a
  // real cross-host navigation. Compute the absolute app URL per environment.
  const [launchHref, setLaunchHref] = useState('/app/deposit')
  useEffect(() => {
    if (typeof window === 'undefined') return
    const h = window.location.hostname
    setAppHost(h.startsWith('app.'))
    const isLocal = h === 'localhost' || h === '127.0.0.1' || !h.includes('.')
    if (h.startsWith('app.')) setLaunchHref('/deposit')
    else if (isLocal) setLaunchHref('/app/deposit')
    else setLaunchHref(`${window.location.protocol}//app.${h.replace(/^www\./, '')}/deposit`)
  }, [])
  const isApp = pathname.startsWith('/app') || appHost

  if (isApp) {
    return <AppTopNav pathname={pathname} />
  }

  return (
    <div className="topnav">
      <div className="topnav-inner">
        <div className="row gap-6">
          <Link href="/" style={{ cursor: 'pointer' }}>
            <Logo />
          </Link>
          <div className="pill pill-soft" style={{ fontSize: 10 }}>
            <span className="dot" style={{ background: 'var(--green)', boxShadow: '0 0 8px var(--green)' }}></span>
            {NETWORK_STATUS}
          </div>
        </div>
        <div className="nav-links">
          {NAV_LINKS.map(([href, label]) => {
            const active = isActive(href)
            return (
              <Link
                key={href}
                href={href}
                className={`nav-link ${active ? 'active' : ''}`}
                aria-current={active ? 'page' : undefined}
                // H12: stronger-than-background active cue (a11y) — gold underline + brighter text.
                style={active ? { color: 'var(--text-1)', boxShadow: 'inset 0 -2px 0 var(--accent)' } : undefined}
              >
                {label}
              </Link>
            )
          })}
        </div>
        <div className="row gap-3">
          <a href={launchHref} className="btn btn-sm btn-primary">
            Launch app <Icon d={ICONS.arrow} size={12} />
          </a>
          {/* NAV-001: reach the section links below 1180px (where .nav-links is hidden).
              Radix DropdownMenu handles open/close, outside-click, Esc, and keyboard roving focus. */}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="btn btn-sm btn-ghost nav-menu-btn" aria-label="Menu">
                <Icon d={ICONS.menu} size={16} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="panel nav-menu-panel" align="end" sideOffset={8}>
                {NAV_LINKS.map(([href, label]) => {
                  const active = isActive(href)
                  return (
                    <DropdownMenu.Item key={href} asChild>
                      <Link
                        href={href}
                        className={`nav-link ${active ? 'active' : ''}`}
                        aria-current={active ? 'page' : undefined}
                        style={active ? { color: 'var(--text-1)', boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined}
                      >
                        {label}
                      </Link>
                    </DropdownMenu.Item>
                  )
                })}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
    </div>
  )
}

function AppTopNav({ pathname }: { pathname: string }) {
  const { address, isConnected } = useAccount()
  const { state } = usePortfolioState(address)

  useEffect(() => {
    if (!isConnected) {
      clearNoteCache()
      clearSession() // FC-13: drop the in-memory master seed when no wallet is connected
    }
  }, [isConnected])

  const totalBalance = state ? `$${formatUsdc(state.totalBalance)}` : '—'
  const sections: [string, string, boolean][] = [
    ['/app/markets', 'Markets', false],
    ['/app/portfolio', 'Portfolio', false],
    ['/explorer', 'Explorer', true],
  ]

  return (
    <div className="topnav">
      <div className="topnav-inner">
        <div className="row gap-6">
          <Link href="/app/markets" style={{ cursor: 'pointer' }}>
            <Logo />
          </Link>
          <div className="pill pill-cyan" style={{ fontSize: 10 }}>
            <span className="dot"></span>
            APP
          </div>
        </div>

        <div className="nav-links">
          {([['/app/markets', 'Markets'], ['/app/portfolio', 'Portfolio']] as [string, string][]).map(([href, label]) => {
            const active = pathname === href
            return (
              <Link
                key={href}
                href={href}
                className={`nav-link ${active ? 'active' : ''}`}
                aria-current={active ? 'page' : undefined}
                // H12: gold underline + brighter text so the active tab isn't background-only.
                style={active ? { color: 'var(--text-1)', boxShadow: 'inset 0 -2px 0 var(--accent)' } : undefined}
              >
                {label}
              </Link>
            )
          })}
          <a href="/explorer" target="_blank" rel="noreferrer" className="nav-link">Explorer</a>
        </div>

        <div className="row gap-3">
          {/* NAV-001: section + action links reachable below 1180px (where .nav-links hides). */}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="btn btn-sm btn-ghost nav-menu-btn" aria-label="Menu">
                <Icon d={ICONS.menu} size={16} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="panel nav-menu-panel" align="end" sideOffset={8}>
                {sections.map(([href, label, ext]) =>
                  ext ? (
                    <DropdownMenu.Item key={href} asChild>
                      <a href={href} target="_blank" rel="noreferrer" className="nav-link">{label}</a>
                    </DropdownMenu.Item>
                  ) : (
                    <DropdownMenu.Item key={href} asChild>
                      <Link
                        href={href}
                        className={`nav-link ${pathname === href ? 'active' : ''}`}
                        aria-current={pathname === href ? 'page' : undefined}
                        style={pathname === href ? { color: 'var(--text-1)', boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined}
                      >
                        {label}
                      </Link>
                    </DropdownMenu.Item>
                  ),
                )}
                {isConnected && (
                  <>
                    <DropdownMenu.Separator className="nav-menu-divider" />
                    <DropdownMenu.Item asChild>
                      <Link href="/app/deposit" className="nav-link">Deposit</Link>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item asChild>
                      <Link href="/app/withdraw" className="nav-link">Withdraw</Link>
                    </DropdownMenu.Item>
                  </>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          {/* NAV-002: balance + Deposit/Withdraw are meaningless pre-connect — reveal once connected.
              MOBILE-001: on phones these duplicate the hamburger-menu links and overflow the action
              row, so .nav-connected-extras hides this group ≤760px (the menu keeps them reachable). */}
          {isConnected && (
            <span className="nav-connected-extras">
              <div className="pill pill-soft" style={{ fontSize: 10 }}>
                {totalBalance}
              </div>
              <Link href="/app/deposit" className="btn btn-sm btn-ghost">Deposit</Link>
              <Link href="/app/withdraw" className="btn btn-sm btn-primary">Withdraw</Link>
            </span>
          )}
          <ConnectKitButton.Custom>
            {({ isConnected: ckConnected, isConnecting, show, address: ckAddress, ensName }) => {
              const label = ensName ?? (ckAddress ? `${ckAddress.slice(0, 6)}…${ckAddress.slice(-4)}` : 'Connect wallet')
              // Not connected: the button opens the ConnectKit modal directly (no dropdown).
              if (!ckConnected) {
                return (
                  <button
                    className="btn btn-sm btn-ghost"
                    style={{ minWidth: 148, justifyContent: 'space-between' }}
                    onClick={() => show?.()}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {isConnecting ? 'Connecting…' : 'Connect wallet'}
                    </span>
                    <Icon d={ICONS.arrowDown} size={12} style={{ opacity: 0.75 }} />
                  </button>
                )
              }
              // Connected: a Radix dropdown with Dashboard + Disconnect.
              return (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      className="btn btn-sm btn-ghost"
                      style={{ minWidth: 148, justifyContent: 'space-between' }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                      <Icon d={ICONS.arrowDown} size={12} style={{ opacity: 0.75 }} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content className="panel" align="end" sideOffset={8} style={{ minWidth: 180, padding: 8, boxShadow: 'var(--shadow-2)' }}>
                      <DropdownMenu.Item asChild>
                        <Link className="btn btn-sm btn-ghost" href="/app/portfolio" style={{ width: '100%', justifyContent: 'flex-start' }}>
                          Dashboard
                        </Link>
                      </DropdownMenu.Item>
                      {/* CRED-003: Settings is a "Coming Soon" stub — hidden from nav until it ships. */}
                      <DropdownMenu.Item asChild>
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => show?.()}
                          style={{ width: '100%', justifyContent: 'flex-start' }}
                        >
                          Disconnect / Logout
                        </button>
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              )
            }}
          </ConnectKitButton.Custom>
        </div>
      </div>
    </div>
  )
}
