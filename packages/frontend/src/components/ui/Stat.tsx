import { ReactNode } from 'react'
import { AnimatedNumber } from './AnimatedNumber'
import { Sparkline } from './Sparkline'

interface StatProps {
  label: string
  value: number | ReactNode
  sub?: string
  accent?: string
  sparkline?: number[]
  decimals?: number
  prefix?: string
  suffix?: string
}

export function Stat({ label, value, sub, accent, sparkline, decimals = 0, prefix = '', suffix = '' }: StatProps) {
  return (
    <div className="panel" style={{ padding: 16 }}>
      <div className="micro">{label}</div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 8 }}>
        <div style={{ fontSize: 26, letterSpacing: '-0.02em' }} className="num">
          {typeof value === 'number'
            ? <AnimatedNumber value={value} decimals={decimals} prefix={prefix} suffix={suffix} />
            : value}
        </div>
        {sparkline && (
          <Sparkline data={sparkline} width={80} height={28} color={accent || 'var(--cyan)'} />
        )}
      </div>
      {sub && <div className="small mt-1" style={{ color: accent || 'var(--text-2)' }}>{sub}</div>}
    </div>
  )
}
