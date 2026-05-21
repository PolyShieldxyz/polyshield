interface HashProps {
  value: string
  short?: boolean
  color?: string
}

export function Hash({ value, short = true, color }: HashProps) {
  const s = short ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
  return (
    <span className="mono" style={{ fontSize: 12, color: color || 'var(--text-2)' }}>{s}</span>
  )
}
