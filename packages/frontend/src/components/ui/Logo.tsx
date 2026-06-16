import type { CSSProperties } from 'react'

interface LogoProps {
  size?: number
  withText?: boolean
  /** Draw-on the gold inclusion path + "verify" the leaf. Off in nav; on for hero/loading. */
  animate?: boolean
}

/* PolyShield mark — a Merkle proof pyramid held inside a shield (proof + protection).
   Gold = your inclusion path (root → mid → leaf, the last edge leaning right); indigo = the
   shield + sibling hashes. Colors read from the P5 tokens (--accent gold, --brand indigo) with
   hex fallbacks so the mark also renders standalone. viewBox 0 0 64 64. */
const SHIELD = 'M32 5 L55 13 V31 C55 44 45 53 32 58 C19 53 9 44 9 31 V13 Z'
const GOLD = 'var(--accent, #f1c45e)'
const INDIGO = 'var(--brand, #8285eb)'
// the single gold polyline: root → mid-left → leaf (last segment leans RIGHT)
const PATH = 'M32 17 L24 30 L29 43'

export function Logo({ size = 22, withText = true, animate = false }: LogoProps) {
  return (
    <div className="row gap-3" style={{ alignItems: 'center' }}>
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
        {/* Shield — faint indigo fill + outline so the tree reads inside it. */}
        <path d={SHIELD} fill="var(--brand-soft, rgba(130,133,235,0.06))" stroke={INDIGO} strokeWidth="2.4" strokeLinejoin="round" />
        {/* Sibling hashes (the rest of the tree) — indigo. */}
        <g stroke={INDIGO} strokeWidth="1.6" strokeLinecap="round">
          <line x1="32" y1="17" x2="40" y2="30" />
          <line x1="24" y1="30" x2="20" y2="43" />
          <line x1="40" y1="30" x2="36" y2="43" />
          <line x1="40" y1="30" x2="44" y2="43" />
        </g>
        <g fill={INDIGO}>
          <circle cx="40" cy="30" r="2.4" />
          <circle cx="20" cy="43" r="2.4" />
          <circle cx="36" cy="43" r="2.4" />
          <circle cx="44" cy="43" r="2.4" />
        </g>
        {/* Gold inclusion path — the hero. pathLength=1 lets it "draw on" when animate. */}
        <path
          d={PATH}
          fill="none"
          stroke={GOLD}
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          className={animate ? 'logo-draw' : undefined}
        />
        <g fill={GOLD}>
          <circle cx="32" cy="17" r="3.6" />
          <circle cx="24" cy="30" r="3" />
          <circle cx="29" cy="43" r="4" className={animate ? 'logo-verify' : undefined} />
        </g>
      </svg>
      {withText && (
        <span style={{ fontSize: 15, letterSpacing: '-0.01em', fontWeight: 500 } as CSSProperties}>
          PolyShield
        </span>
      )}
    </div>
  )
}
