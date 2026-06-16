'use client'
import { useState, useEffect } from 'react'
import { fetchDevStatus, type DevStatus } from '@/lib/api'

const DOT = ({ on }: { on: boolean }) => (
  <span style={{
    width: 6, height: 6, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
    background: on ? 'var(--green)' : 'oklch(0.70 0.18 25 / 0.8)',
    boxShadow: on ? '0 0 6px oklch(0.78 0.16 152 / 0.6)' : 'none',
  }} />
)

export function DevStatusBar() {
  const [status, setStatus] = useState<DevStatus | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function check() {
      const s = await fetchDevStatus()
      if (!cancelled) setStatus(s)
    }

    check()
    const id = setInterval(check, 10_000) // re-check every 10 s
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (!status?.devMode) return null

  const allGood = status.anvil && status.proofRelay && status.mockClob

  return (
    <div style={{
      position: 'fixed', bottom: 16, right: 16, zIndex: 9999,
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6,
    }}>
      {open && (
        <div className="panel" style={{ padding: '12px 16px', minWidth: 260, background: 'var(--surface)', fontSize: 11 }}>
          <div className="micro" style={{ marginBottom: 10 }}>DEV ENVIRONMENT STATUS</div>
          <div className="col gap-2">
            <ServiceRow label="Anvil (chain 31337)" up={status.anvil} url="http://127.0.0.1:8545" />
            <ServiceRow label="Proof relay (:3002)"  up={status.proofRelay} url="http://127.0.0.1:3002" />
            <ServiceRow label="Mock CLOB (:3001)"    up={status.mockClob}   url="http://127.0.0.1:3001" />
          </div>
          {(status.vaultAddress || status.usdcAddress) && (
            <div className="col gap-1 mt-3" style={{ borderTop: '1px solid var(--line-strong)', paddingTop: 10 }}>
              {status.vaultAddress && (
                <div className="row gap-2" style={{ justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-2)' }}>Vault</span>
                  <span className="mono" style={{ fontSize: 10 }}>{status.vaultAddress.slice(0, 10)}…</span>
                </div>
              )}
              {status.usdcAddress && (
                <div className="row gap-2" style={{ justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-2)' }}>USDC</span>
                  <span className="mono" style={{ fontSize: 10 }}>{status.usdcAddress.slice(0, 10)}…</span>
                </div>
              )}
            </div>
          )}
          {!allGood && (
            <div className="small mt-3" style={{ color: 'oklch(0.82 0.14 55)', fontSize: 10 }}>
              Run <span className="mono">pnpm dev:mock</span> to start all services.
            </div>
          )}
        </div>
      )}

      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 10px', borderRadius: 6,
          background: 'var(--surface)', border: '1px solid var(--line-strong)',
          cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)',
        }}
      >
        <DOT on={allGood} />
        <span>DEV</span>
        <span style={{ color: allGood ? 'var(--green)' : 'var(--red)' }}>
          {allGood ? 'ALL LIVE' : `${[status.anvil, status.proofRelay, status.mockClob].filter(Boolean).length}/3`}
        </span>
      </button>
    </div>
  )
}

function ServiceRow({ label, up, url }: { label: string; up: boolean; url: string }) {
  return (
    <div className="row gap-2" style={{ justifyContent: 'space-between' }}>
      <div className="row gap-2">
        <DOT on={up} />
        <span style={{ color: 'var(--text-2)' }}>{label}</span>
      </div>
      <a href={url} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 9, color: up ? 'var(--cyan)' : 'var(--text-3)', textDecoration: 'none' }}>
        {up ? 'open ↗' : 'down'}
      </a>
    </div>
  )
}
