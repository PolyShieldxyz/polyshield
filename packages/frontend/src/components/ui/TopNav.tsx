'use client'

import Link from 'next/link'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Logo } from './Logo'
import { Icon, ICONS } from './Icon'
import { clearNoteCache } from '@/lib/notes'
import { formatUsdc } from '@/lib/notes'
import { usePortfolioState } from '@/lib/accountState'

const NAV_LINKS: [string, string][] = [
  ['/', 'Product'],
  ['/how', 'How It Works'],
  ['/docs', 'Docs'],
  ['/roadmap', 'Roadmap'],
  ['/careers', 'Careers'],
]

export function TopNav() {
  const pathname = usePathname()
  // On the app.* subdomain the middleware rewrites "/markets" -> "/app/markets"
  // INTERNALLY, so usePathname() still reports "/markets". Detect the subdomain too,
  // otherwise the app pages render the marketing nav. (Brief first-paint flash on the
  // subdomain is expected — window isn't available during SSR.)
  const [appHost, setAppHost] = useState(false)
  // The dApp lives on the app.* subdomain (middleware 301s apex/app/* -> app.<host>/*).
  // A Next <Link> soft-navigates and won't reliably switch hosts, so "Launch App" must be a
  // real cross-host navigation. Compute the absolute app URL per environment.
  const [launchHref, setLaunchHref] = useState('/app/markets')
  useEffect(() => {
    if (typeof window === 'undefined') return
    const h = window.location.hostname
    setAppHost(h.startsWith('app.'))
    const isLocal = h === 'localhost' || h === '127.0.0.1' || !h.includes('.')
    if (h.startsWith('app.')) setLaunchHref('/markets')
    else if (isLocal) setLaunchHref('/app/markets')
    else setLaunchHref(`${window.location.protocol}//app.${h.replace(/^www\./, '')}/markets`)
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
            TESTNET · POLYGON AMOY
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
          <a href={launchHref} className="btn btn-sm btn-primary">
            Launch App <Icon d={ICONS.arrow} size={12} />
          </a>
        </div>
      </div>
    </div>
  )
}

function AppTopNav({ pathname }: { pathname: string }) {
  const { address, isConnected } = useAccount()
  const { state } = usePortfolioState(address)
  const [walletMenuOpen, setWalletMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!isConnected) {
      clearNoteCache()
    }
  }, [isConnected])

  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setWalletMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const totalBalance = state ? `$${formatUsdc(state.totalBalance)}` : '—'

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
          <Link href="/app/markets" className={`nav-link ${pathname === '/app/markets' ? 'active' : ''}`}>Markets</Link>
          <Link href="/app/portfolio" className={`nav-link ${pathname === '/app/portfolio' ? 'active' : ''}`}>Portfolio</Link>
          <a href="/explorer" target="_blank" rel="noreferrer" className="nav-link">Explorer</a>
        </div>

        <div className="row gap-3">
          <div className="pill pill-soft" style={{ fontSize: 10 }}>
            {totalBalance}
          </div>
          <Link href="/app/deposit" className="btn btn-sm btn-ghost">Deposit</Link>
          <Link href="/app/withdraw" className="btn btn-sm btn-primary">Withdraw</Link>
          <ConnectKitButton.Custom>
            {({ isConnected: ckConnected, isConnecting, show, address: ckAddress, ensName }) => {
              const label = ensName ?? (ckAddress ? `${ckAddress.slice(0, 6)}…${ckAddress.slice(-4)}` : 'Connect wallet')
              return (
                <div ref={menuRef} style={{ position: 'relative' }}>
                  <button
                    className="btn btn-sm btn-ghost"
                    style={{ minWidth: 148, justifyContent: 'space-between' }}
                    onClick={() => {
                      if (!ckConnected) {
                        show?.()
                        return
                      }
                      setWalletMenuOpen((open) => !open)
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {ckConnected ? label : isConnecting ? 'Connecting…' : 'Connect wallet'}
                    </span>
                    <span style={{ opacity: 0.75 }}>⌄</span>
                  </button>
                  {walletMenuOpen && ckConnected && (
                    <div
                      className="panel"
                      style={{
                        position: 'absolute',
                        top: 'calc(100% + 8px)',
                        right: 0,
                        minWidth: 180,
                        padding: 8,
                        boxShadow: 'var(--shadow-2)',
                      }}
                    >
                      <Link className="btn btn-sm btn-ghost" href="/app/portfolio" style={{ width: '100%', justifyContent: 'flex-start' }}>
                        Dashboard
                      </Link>
                      <Link className="btn btn-sm btn-ghost" href="/app/settings" style={{ width: '100%', justifyContent: 'flex-start' }}>
                        Settings
                      </Link>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          setWalletMenuOpen(false)
                          show?.()
                        }}
                        style={{ width: '100%', justifyContent: 'flex-start' }}
                      >
                        Disconnect / Logout
                      </button>
                    </div>
                  )}
                </div>
              )
            }}
          </ConnectKitButton.Custom>
        </div>
      </div>
    </div>
  )
}
