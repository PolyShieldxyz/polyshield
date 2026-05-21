'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Icon, ICONS } from '@/components/ui/Icon'
import { KV } from '@/components/app/KV'
import { getNotes, formatUsdc, type Note } from '@/lib/notes'

const KIND_COLOR: Record<string, string> = {
  DEPOSIT: 'var(--cyan)',
  BET_OUTPUT: 'var(--violet)',
  SETTLE_CREDIT: 'var(--green)',
  CANCEL_CREDIT: 'oklch(0.82 0.14 70)',
}

function formatAge(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function MerkleTreeVisual() {
  return (
    <svg viewBox="0 0 320 160" width="100%">
      {[[[160, 16]], [[80, 48], [240, 48]], [[40, 80], [120, 80], [200, 80], [280, 80]]].map((level, li) =>
        level.map(([x, y], i) => (
          <g key={`${li}-${i}`}>
            {li > 0 && (() => {
              const parents = [[[160, 16]], [[80, 48], [240, 48]]][li - 1]
              const [px, py] = parents[Math.floor(i / 2)]
              return <line x1={px} y1={py + 5} x2={x} y2={y - 5} stroke="rgba(255,255,255,0.1)" />
            })()}
            <circle cx={x} cy={y} r={li === 0 ? 6 : 5}
              fill={li === 0 ? 'var(--cyan)' : 'rgba(255,255,255,0.3)'} />
          </g>
        ))
      )}
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
        const x = 20 + i * 40
        const active = i < 5
        return (
          <g key={i}>
            <circle cx={x} cy={120} r={4}
              fill={active ? (i === 4 ? 'var(--green)' : 'rgba(255,255,255,0.45)') : 'rgba(255,255,255,0.08)'}
              stroke={i === 4 ? 'var(--green)' : 'none'} />
            {i === 4 && <text x={x} y={140} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="7" fill="var(--green)">YOU</text>}
          </g>
        )
      })}
      <text x="160" y="158" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="rgba(255,255,255,0.3)">leaf 48,220 of 67,108,864</text>
    </svg>
  )
}

export default function VaultPage() {
  const [filter, setFilter] = useState<'ALL' | 'OPEN' | 'SPENT'>('ALL')
  const [notes, setNotes] = useState<Note[]>([])

  useEffect(() => {
    // Load notes from localStorage and refresh every 5 s to catch updates
    const load = () => setNotes(getNotes())
    load()
    const id = setInterval(load, 5_000)
    return () => clearInterval(id)
  }, [])

  const open = notes.filter((n) => !n.spent)
  const totalOpenMicro = open.reduce((s, n) => s + n.balance, 0n)
  const filtered = filter === 'ALL' ? notes : notes.filter((n) => (filter === 'OPEN' ? !n.spent : n.spent))

  return (
    <div>
      <div className="row hairline-b" style={{ padding: '14px 24px', justifyContent: 'space-between' }}>
        <div className="row gap-4">
          <div className="micro">VAULT</div>
          <span className="pill pill-soft" style={{ fontSize: 10 }}>{open.length} open {open.length === 1 ? 'note' : 'notes'}</span>
        </div>
        <div className="row gap-2">
          <Link href="/app/deposit" className="btn btn-sm btn-primary" style={{ textDecoration: 'none' }}>
            <Icon d={ICONS.arrow} size={11} /> Deposit
          </Link>
          <Link href="/app/withdraw" className="btn btn-sm" style={{ textDecoration: 'none' }}>
            Withdraw
          </Link>
        </div>
      </div>

      <div style={{ padding: 24 }}>
        {/* Warning panel */}
        <div className="panel" style={{ padding: 16, borderColor: 'oklch(0.82 0.14 70 / 0.4)', background: 'oklch(0.82 0.14 70 / 0.03)', marginBottom: 20 }}>
          <div className="row gap-3">
            <Icon d={ICONS.lock} size={16} className="text-amber" style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Keep your note preimages safe.</div>
              <div className="small mt-1" style={{ fontSize: 12 }}>These notes are your only proof of ownership. Polyshield cannot recover them. Back up your encrypted note file.</div>
            </div>
            <button className="btn btn-sm" style={{ flexShrink: 0 }}>Export backup</button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24 }}>
          <div>
            {/* Totals row */}
            <div className="row gap-4 mb-4" style={{ marginBottom: 16 }}>
              <div className="panel" style={{ padding: '12px 16px', flex: 1 }}>
                <div className="micro" style={{ fontSize: 9 }}>SPENDABLE BALANCE</div>
                <div className="num mt-1" style={{ fontSize: 24, color: 'var(--green)' }}>${formatUsdc(totalOpenMicro)}</div>
                <div className="small" style={{ fontSize: 10 }}>USDC across {open.length} notes</div>
              </div>
              <div className="panel" style={{ padding: '12px 16px', flex: 1 }}>
                <div className="micro" style={{ fontSize: 9 }}>ANONYMITY SCORE</div>
                <div className="num mt-1" style={{ fontSize: 24, color: 'var(--cyan)' }}>94<span style={{ fontSize: 14 }}>/100</span></div>
                <div className="small" style={{ fontSize: 10 }}>1,842 wallet anonymity set</div>
              </div>
            </div>

            {/* Note table */}
            <div className="row gap-2 mb-3" style={{ marginBottom: 12 }}>
              {(['ALL', 'OPEN', 'SPENT'] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={`btn btn-sm ${filter === f ? 'btn-cyan' : 'btn-ghost'}`} style={{ fontSize: 11 }}>{f}</button>
              ))}
            </div>
            <div className="panel" style={{ padding: 0 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Note ID</th>
                    <th>Kind</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th>State</th>
                    <th>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24, fontSize: 12 }}>
                        No notes yet. <a href="/app/deposit" style={{ color: 'var(--cyan)', textDecoration: 'none' }}>Deposit USDC</a> to create your first note.
                      </td>
                    </tr>
                  )}
                  {filtered.map((n) => (
                    <tr key={n.id} style={{ opacity: n.spent ? 0.45 : 1 }}>
                      <td className="mono" style={{ fontSize: 10 }}>{n.id.slice(0, 10)}…{n.id.slice(-6)}</td>
                      <td>
                        <span className="pill" style={{ fontSize: 9, background: 'transparent', border: '1px solid', borderColor: KIND_COLOR[n.kind] ?? 'var(--line-strong)', color: KIND_COLOR[n.kind] ?? 'var(--text-2)' }}>
                          {n.kind}
                        </span>
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>${formatUsdc(n.balance)}</td>
                      <td>
                        <span style={{ fontSize: 10, color: n.spent ? 'var(--text-2)' : 'var(--green)' }}>{n.spent ? 'SPENT' : 'OPEN'}</span>
                      </td>
                      <td className="small">{formatAge(n.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <div className="micro">MERKLE POSITION</div>
            <div className="panel mt-3" style={{ padding: 20 }}>
              <MerkleTreeVisual />
              <div className="hairline-t mt-3" style={{ paddingTop: 12 }}>
                <KV l="Tree depth" v="32" />
                <KV l="Your leaf" v="48,220" />
                <KV l="Total leaves" v="48,225" />
                <KV l="Root (current)" v="0x91ae…4f23" />
                <KV l="Root window" v="last 30 roots" />
              </div>
            </div>
            <div className="panel mt-3" style={{ padding: 20 }}>
              <div className="micro">QUICK ACTIONS</div>
              <div className="col mt-3 gap-2">
                <Link href="/app/deposit" className="btn" style={{ justifyContent: 'flex-start', textDecoration: 'none', fontSize: 12 }}>
                  <Icon d={ICONS.arrow} size={12} /> Deposit USDC
                </Link>
                <Link href="/app/withdraw" className="btn" style={{ justifyContent: 'flex-start', textDecoration: 'none', fontSize: 12 }}>
                  <Icon d={ICONS.arrow} size={12} /> Withdraw to wallet
                </Link>
                <Link href="/app/settle" className="btn" style={{ justifyContent: 'flex-start', textDecoration: 'none', fontSize: 12 }}>
                  <Icon d={ICONS.arrow} size={12} /> Claim settlement
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
