import { ReactNode, CSSProperties } from 'react'

interface IconProps {
  d: ReactNode
  size?: number
  fill?: string
  className?: string
  style?: CSSProperties
}

export function Icon({ d, size = 14, fill = 'none', className = '', style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      {typeof d === 'string' ? <path d={d} /> : d}
    </svg>
  )
}

export const ICONS = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></>,
  markets: <><path d="M3 17 L9 11 L13 15 L21 7"/><path d="M15 7 H21 V13"/></>,
  vault: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="3.5"/><path d="M12 8.5 V7 M12 17 V15.5 M8.5 12 H7 M17 12 H15.5"/></>,
  bets: <><path d="M4 7 L12 3 L20 7 L12 11 Z"/><path d="M4 12 L12 16 L20 12"/><path d="M4 17 L12 21 L20 17"/></>,
  settle: <><path d="M4 12 L10 18 L20 6"/></>,
  withdraw: <><path d="M12 3 V14 M7 9 L12 14 L17 9"/><path d="M4 18 H20 V21 H4 Z"/></>,
  proof: <><circle cx="12" cy="12" r="9"/><path d="M8 12 L11 15 L16 9"/></>,
  privacy: <><path d="M12 3 L20 6 V12 C20 16.5 16.5 20 12 21 C7.5 20 4 16.5 4 12 V6 Z"/></>,
  analytics: <><path d="M4 20 V12 M10 20 V6 M16 20 V14 M22 20 H2"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M12 2 V5 M12 19 V22 M4.2 4.2 L6.3 6.3 M17.7 17.7 L19.8 19.8 M2 12 H5 M19 12 H22 M4.2 19.8 L6.3 17.7 M17.7 6.3 L19.8 4.2"/></>,
  arrow: <><path d="M5 12 H19 M13 6 L19 12 L13 18"/></>,
  arrowDown: <><path d="M12 5 V19 M6 13 L12 19 L18 13"/></>,
  arrowUp: <><path d="M12 19 V5 M6 11 L12 5 L18 11"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="M16 16 L21 21"/></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15 H4 V4 H15 V5"/></>,
  external: <><path d="M14 4 H20 V10"/><path d="M20 4 L11 13"/><path d="M18 14 V20 H4 V6 H10"/></>,
  check: <><path d="M5 12 L10 17 L19 7"/></>,
  cross: <><path d="M6 6 L18 18 M18 6 L6 18"/></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11 V8 A4 4 0 0 1 16 8 V11"/></>,
  github: <><path d="M9 19c-4 1.2-4-2-5.5-2.5M14 22v-3.5c0-1 .1-1.4-.5-2 3-.3 6-1.5 6-6.5a5 5 0 0 0-1.4-3.5c.3-1 .3-2.2-.1-3.2 0 0-1.1-.4-3.5 1.3a12 12 0 0 0-6 0C6.1 1 5 1.4 5 1.4c-.4 1-.4 2.1-.1 3.2A5 5 0 0 0 3.5 8c0 5 3 6.2 6 6.5-.6.5-.6 1-.5 2V22"/></>,
  discord: <><path d="M8 12 a1 1 0 1 0 0.1 0 M16 12 a1 1 0 1 0 0.1 0"/><path d="M18 6 c-1-.5-2.5-1-4-1L13.5 6.5 M6 6 c1-.5 2.5-1 4-1L10.5 6.5"/><path d="M5 17 C4 14 4 11 5 8 L6 6 L9 5.5 M19 17 C20 14 20 11 19 8 L18 6 L15 5.5"/><path d="M5 17 C7 18 9 18.5 12 18.5 C15 18.5 17 18 19 17"/></>,
  twitter: <><path d="M3 4 L9.5 12.5 L3.5 20 H6 L10.7 14.5 L14.7 20 H21 L14.2 11 L20 4 H17.5 L13.1 9 L9.3 4 Z"/></>,
  menu: <><path d="M4 7 H20 M4 12 H20 M4 17 H20"/></>,
  bell: <><path d="M6 9 a6 6 0 0 1 12 0 c0 6 2 7 2 7 H4 s2-1 2-7 Z M10 20 a2 2 0 0 0 4 0"/></>,
  plus: <><path d="M12 5 V19 M5 12 H19"/></>,
  filter: <><path d="M4 5 H20 L14 12 V19 L10 21 V12 Z"/></>,
} as const
