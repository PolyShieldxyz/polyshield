interface SectionHeadProps {
  kicker?: string
  title: string
  sub?: string
  align?: 'left' | 'center'
}

export function SectionHead({ kicker, title, sub, align = 'left' }: SectionHeadProps) {
  return (
    <div
      className={align === 'left' && kicker ? 'editorial-head' : undefined}
      style={{ textAlign: align, maxWidth: align === 'center' ? 720 : '100%', margin: align === 'center' ? '0 auto' : 0 }}
    >
      {/* Section eyebrow = brand/structure → indigo (not the gold action accent). */}
      {kicker && <div className="micro" style={{ color: 'var(--brand)' }}>{kicker}</div>}
      <h2 className="h2 mt-3" style={{ margin: 0 }}>{title}</h2>
      {sub && (
        <div className="body mt-3" style={{ maxWidth: 560, margin: align === 'center' ? '12px auto 0' : '12px 0 0' }}>
          {sub}
        </div>
      )}
    </div>
  )
}
