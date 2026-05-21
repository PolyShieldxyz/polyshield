'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Logo } from '@/components/ui/Logo'
import { Icon, ICONS } from '@/components/ui/Icon'
import { Hash } from '@/components/ui/Hash'
import { Sparkline } from '@/components/ui/Sparkline'
import { WalletConnect } from '@/components/ui/WalletConnect'
import { ReactNode } from 'react'

interface SidebarGroup {
  title: string
  items: [string, string, ReactNode, string | null][]
}

const GROUPS: SidebarGroup[] = [
  {
    title: 'TRADE', items: [
      ['/app/markets', 'Markets', ICONS.markets, null],
      ['/app/portfolio', 'Portfolio', ICONS.dashboard, '14'],
    ]
  },
  {
    title: 'VAULT', items: [
      ['/app/vault', 'Vault & notes', ICONS.vault, null],
      ['/app/deposit', 'Deposit', ICONS.arrowDown, null],
      ['/app/withdraw', 'Withdraw', ICONS.withdraw, null],
      ['/app/settle', 'Settlements', ICONS.settle, '3'],
    ]
  },
  {
    title: 'PRIVACY', items: [
      ['/app/proofs', 'Proof activity', ICONS.proof, '3'],
      ['/app/privacy', 'Privacy metrics', ICONS.privacy, null],
    ]
  },
  {
    title: 'SYSTEM', items: [
      ['/app/settings', 'Settings', ICONS.settings, null],
    ]
  },
]

export function AppSidebar() {
  const pathname = usePathname()

  return (
    <aside className="sidebar">
      <div className="row gap-3" style={{ padding: '4px 8px 14px' }}>
        <Logo size={20} />
      </div>
      {GROUPS.map((g) => (
        <div key={g.title}>
          <div className="sb-group micro">{g.title}</div>
          {g.items.map(([href, label, ic, count]) => {
            const isSoon = count === 'SOON'
            const isActive = pathname === href

            if (isSoon) {
              return (
                <div key={href} className="sb-item" style={{ opacity: 0.5, cursor: 'not-allowed' }}>
                  <Icon d={ic} className="icon" />
                  <span>{label}</span>
                  <span className="sb-count" style={{
                    background: 'rgba(255,255,255,0.04)',
                    padding: '2px 6px',
                    borderRadius: 3,
                    letterSpacing: '0.08em',
                  }}>{count}</span>
                </div>
              )
            }

            return (
              <Link
                key={href}
                href={href}
                className={`sb-item ${isActive ? 'active' : ''}`}
                style={{ textDecoration: 'none' }}
              >
                <Icon d={ic} className="icon" />
                <span>{label}</span>
                {count && (
                  <span className="sb-count">{count}</span>
                )}
              </Link>
            )
          })}
        </div>
      ))}
      <div style={{ flex: 1 }}></div>
      {/* Wallet connect / disconnect — only shown inside the app */}
      <div style={{ padding: '0 8px 8px' }}>
        <WalletConnect variant="sidebar" />
      </div>
      <div className="panel" style={{ padding: 12, margin: 8 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="micro">VAULT</div>
          <span className="pill pill-cyan" style={{ fontSize: 9 }}>
            <span className="dot"></span>ANON
          </span>
        </div>
        <Hash value="0x7a4fcc8829b14f12abc92c2b9" />
        <div className="row mt-3" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <div className="micro" style={{ fontSize: 9 }}>ANON SCORE</div>
            <div className="num" style={{ fontSize: 16, color: 'var(--cyan)' }}>94.2</div>
          </div>
          <Sparkline data={[80, 84, 82, 88, 90, 89, 92, 94, 94.2]} width={60} height={24} />
        </div>
        <div className="hairline-t mt-3" style={{ paddingTop: 8 }}>
          <div className="micro" style={{ fontSize: 9 }}>SET SIZE</div>
          <div className="num" style={{ fontSize: 14 }}>1,842 wallets</div>
        </div>
      </div>
    </aside>
  )
}
