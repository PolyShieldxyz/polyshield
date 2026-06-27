'use client'
import { useState } from 'react'
import { Icon, ICONS } from './Icon'

interface HashProps {
  value: string
  short?: boolean
  color?: string
}

export function Hash({ value, short = true, color }: HashProps) {
  const s = short ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
  const [copied, setCopied] = useState(false)

  // H13: verifiability-first product — the full value must be recoverable and SR-readable.
  const copy = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable / denied — silently no-op */
    }
  }

  return (
    <span className="row" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {/* title gives the full hash on hover; aria-label gives SR users the real value, not the ellipsis. */}
      <span
        className="mono"
        title={value}
        aria-label={value}
        style={{ fontSize: 12, color: color || 'var(--text-2)' }}
      >
        {s}
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Hash copied' : 'Copy hash'}
        title={copied ? 'Copied' : 'Copy'}
        className="btn-sm btn-ghost"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 24,
          minHeight: 24,
          padding: 4,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: copied ? 'var(--green)' : 'var(--text-2)',
          lineHeight: 0,
        }}
      >
        <Icon d={copied ? ICONS.settle : ICONS.copy} size={13} />
      </button>
    </span>
  )
}
