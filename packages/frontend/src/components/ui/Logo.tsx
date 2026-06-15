import { useId } from 'react'

interface LogoProps {
  size?: number
  withText?: boolean
}

// Shared shield silhouette (viewBox 0 0 32 32). Filled — survives small sizes and light backgrounds.
const SHIELD = 'M16 2.5 L27.5 6.6 V15.8 C27.5 22.6 22.3 27.6 16 29.7 C9.7 27.6 4.5 22.6 4.5 15.8 V6.6 Z'
// V1: brand initial "P" (evenodd keeps the bowl counter open). Used as the standalone brand mark.
const CUT_P = 'M12.2 9 H17.4 C19.9 9 21.6 10.7 21.6 13.1 C21.6 15.5 19.9 17.2 17.4 17.2 H14.7 V22.6 H12.2 Z M14.7 11.3 V14.9 H17.1 C18.3 14.9 19 14.2 19 13.1 C19 12 18.3 11.3 17.1 11.3 Z'
// V2: keyhole (privacy). Used as the mark beside the "PolyShield" wordmark.
const CUT_KEYHOLE = 'M16 9.5 A3.2 3.2 0 0 1 17.7 15.4 L19 22 H13 L14.3 15.4 A3.2 3.2 0 0 1 16 9.5 Z'

export function Logo({ size = 22, withText = true }: LogoProps) {
  const uid = useId()
  const gid = `lg-${uid}`
  const mid = `lm-${uid}`
  // V2 keyhole when shown next to the name; V1 "P" as the standalone brand mark.
  const cut = withText ? CUT_KEYHOLE : CUT_P
  return (
    <div className="row gap-3" style={{ alignItems: 'center' }}>
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="oklch(0.84 0.13 210)" />
            <stop offset="1" stopColor="oklch(0.66 0.15 290)" />
          </linearGradient>
          {/* White = visible shield, black = knocked-out cut → the cut is transparent on any background. */}
          <mask id={mid}>
            <path d={SHIELD} fill="white" />
            <path d={cut} fill="black" fillRule="evenodd" />
          </mask>
        </defs>
        <path d={SHIELD} fill={`url(#${gid})`} mask={`url(#${mid})`} />
      </svg>
      {withText && (
        <span style={{ fontSize: 15, letterSpacing: '-0.01em', fontWeight: 500 }}>
          PolyShield
        </span>
      )}
    </div>
  )
}
