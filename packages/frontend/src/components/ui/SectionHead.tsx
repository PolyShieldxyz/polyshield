interface SectionHeadProps {
  kicker?: string
  title: string
  sub?: string
  align?: 'left' | 'center'
}

export function SectionHead({ kicker, title, sub, align = 'left' }: SectionHeadProps) {
  return (
    <div style={{ textAlign: align, maxWidth: align === 'center' ? 720 : '100%', margin: align === 'center' ? '0 auto' : 0 }}>
      {kicker && <div className="micro" style={{ color: 'var(--cyan)' }}>{kicker}</div>}
      <h2 className="h2 mt-3" style={{ margin: 0 }}>{title}</h2>
      {sub && (
        <div className="body mt-3" style={{ maxWidth: 560, margin: align === 'center' ? '12px auto 0' : '12px 0 0' }}>
          {sub}
        </div>
      )}
    </div>
  )
}
