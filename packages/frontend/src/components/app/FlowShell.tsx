'use client'
import { ReactNode, useEffect, useState } from 'react'
import { Icon, ICONS } from '@/components/ui/Icon'

interface FlowShellProps {
  title: string
  kicker: string
  summary: string
  steps: [string, string, string][]
  step: number
  children: ReactNode
  onBack: () => void
}

export function FlowShell({ title, kicker, summary, steps, step, children, onBack }: FlowShellProps) {
  return (
    <div>
      <div className="row hairline-b" style={{ padding: '14px 24px', justifyContent: 'space-between' }}>
        <div className="row gap-4">
          <div className="micro">{kicker}</div>
          <div className="row gap-2 mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>
            <span>BLOCK</span><span style={{ color: 'var(--text-1)' }}>21,448,072</span>
            <span style={{ marginLeft: 12 }}>RELAY</span><span style={{ color: 'var(--green)' }}>● ONLINE</span>
          </div>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={onBack}>← Cancel</button>
      </div>

      <div style={{ padding: 24 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div className="micro">{kicker}</div>
            <h2 className="h3 mt-2" style={{ margin: 0 }}>{title}</h2>
            <div className="small mt-2">{summary}</div>
          </div>
        </div>

        <div className="panel mt-6" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="row" style={{ borderBottom: '1px solid var(--line)' }}>
            {steps.map(([n, t, s], i) => {
              const active = i === step
              const done = i < step
              return (
                <div key={i} className="row gap-3"
                  style={{
                    padding: '16px 20px', flex: 1,
                    borderRight: i < steps.length - 1 ? '1px solid var(--line)' : 'none',
                    background: active ? 'rgba(255,255,255,0.025)' : 'transparent',
                  }}>
                  <div style={{
                    width: 26, height: 26, borderRadius: 6,
                    border: '1px solid',
                    borderColor: done ? 'var(--green)' : active ? 'var(--cyan)' : 'var(--line-strong)',
                    background: done ? 'oklch(0.78 0.16 152 / 0.12)' : active ? 'oklch(0.82 0.13 85 / 0.12)' : 'transparent',
                    color: done ? 'var(--green)' : active ? 'var(--cyan)' : 'var(--text-2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'var(--mono)', fontSize: 11,
                  }}>
                    {done ? <Icon d={ICONS.check} size={12} /> : n}
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: active || done ? 'var(--text)' : 'var(--text-2)' }}>{t}</div>
                    <div className="small" style={{ fontSize: 10 }}>{s}</div>
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{ padding: 28, minHeight: 440 }}>{children}</div>
        </div>
      </div>
    </div>
  )
}

export function CircuitTrace({ progress }: { progress: number }) {
  const gates = [
    { label: 'Witness generation', pct: 15 },
    { label: 'Arithmetic constraints', pct: 35 },
    { label: 'Permutation argument', pct: 60 },
    { label: 'Lookup argument', pct: 78 },
    { label: 'UltraPLONK prover', pct: 90 },
    { label: 'Proof serialise', pct: 100 },
  ]
  return (
    <div className="col gap-3">
      {gates.map(({ label, pct }, i) => {
        const done = progress >= pct
        const active = !done && progress >= (gates[i - 1]?.pct ?? 0)
        return (
          <div key={label} className="row gap-3" style={{ alignItems: 'center' }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: done ? 'var(--green)' : active ? 'var(--cyan)' : 'rgba(255,255,255,0.12)',
              boxShadow: active ? '0 0 6px var(--cyan)' : 'none',
            }} />
            <span className="mono" style={{ fontSize: 11, color: done ? 'var(--text)' : 'var(--text-2)', flex: 1 }}>{label}</span>
            {done && <span className="mono" style={{ fontSize: 10, color: 'var(--green)' }}>✓</span>}
          </div>
        )
      })}
      <div className="hairline-t mt-2" style={{ paddingTop: 12 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-2)' }}>constraints: 3,140</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-2)' }}>π size: 384 B</span>
        </div>
      </div>
    </div>
  )
}

export function RelayRouteVisual({ litHops }: { litHops: number }) {
  const hops = ['us-east-relay.07', 'eu-west-relay.12', 'ap-relay.04']
  const nodes = ['YOU', ...hops, 'VAULT']
  return (
    <svg viewBox="0 0 260 140" width="100%">
      {nodes.map((label, i) => {
        const x = 30 + i * 55
        const y = 60 + (i % 2 === 0 ? 0 : 20)
        const lit = i <= litHops
        return (
          <g key={label}>
            {i > 0 && (
              <line
                x1={30 + (i - 1) * 55} y1={60 + ((i - 1) % 2 === 0 ? 0 : 20) + 8}
                x2={x} y2={y - 8}
                stroke={i <= litHops ? 'var(--cyan)' : 'rgba(255,255,255,0.1)'}
                strokeDasharray={i <= litHops ? '0' : '3 3'}
              />
            )}
            <circle cx={x} cy={y} r={8}
              fill={lit ? (i === nodes.length - 1 ? 'oklch(0.78 0.16 152 / 0.3)' : 'oklch(0.82 0.13 85 / 0.2)') : 'rgba(255,255,255,0.05)'}
              stroke={lit ? (i === nodes.length - 1 ? 'var(--green)' : 'var(--cyan)') : 'rgba(255,255,255,0.15)'}
            />
            <text x={x} y={y + 20} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="7"
              fill={lit ? 'var(--text-2)' : 'rgba(255,255,255,0.25)'}>
              {i === 0 ? 'YOU' : i === nodes.length - 1 ? 'VAULT' : `HOP ${i}`}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export function useProgress(active: boolean, speed = 3, onDone?: () => void): number {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    if (!active) { setProgress(0); return }
    setProgress(0)
    const id = setInterval(() => {
      setProgress((p) => {
        if (p >= 100) {
          clearInterval(id)
          onDone && setTimeout(onDone, 500)
          return 100
        }
        return Math.min(100, p + speed)
      })
    }, 50)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  return progress
}
