'use client'
import { ReactNode } from 'react'
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
      {/* Header kept honest: the old BLOCK/RELAY strip showed a hardcoded fake block number and a
          static "● ONLINE" status on a live money flow — removed rather than fabricate telemetry. */}
      <div className="row hairline-b" style={{ padding: '14px 24px', justifyContent: 'space-between' }}>
        <div className="micro">{kicker}</div>
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
