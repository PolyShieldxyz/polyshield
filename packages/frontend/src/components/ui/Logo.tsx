interface LogoProps {
  size?: number
  withText?: boolean
}

export function Logo({ size = 22, withText = true }: LogoProps) {
  const s = size
  return (
    <div className="row gap-3" style={{ alignItems: 'center' }}>
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
        <defs>
          <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="oklch(0.85 0.13 210)" />
            <stop offset="1" stopColor="oklch(0.62 0.15 290)" />
          </linearGradient>
        </defs>
        <path d="M12 1.5 L21.5 6 V13.2 C21.5 18 17 21.5 12 22.5 C7 21.5 2.5 18 2.5 13.2 V6 Z"
          stroke="url(#lg)" strokeWidth="1.4" fill="none" />
        <path d="M12 5 L18 8 V13 C18 16 15.3 18.4 12 19.2 C8.7 18.4 6 16 6 13 V8 Z"
          stroke="url(#lg)" strokeWidth="1" fill="none" opacity="0.55" />
        <circle cx="12" cy="12" r="1.4" fill="oklch(0.85 0.13 210)" />
        <path d="M12 9 V14.5 M9.5 12 H14.5" stroke="oklch(0.85 0.13 210)" strokeWidth="0.8" opacity="0.7" />
      </svg>
      {withText && (
        <span style={{ fontSize: 15, letterSpacing: '-0.01em', fontWeight: 500 }}>
          Polyshield
        </span>
      )}
    </div>
  )
}
