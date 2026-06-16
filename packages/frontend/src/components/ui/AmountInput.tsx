'use client'

import { useEffect, useState, type CSSProperties } from 'react'

interface AmountInputProps {
  /** Numeric value owned by the parent. */
  value: number
  /** Called with the parsed number on every edit. */
  onValueChange: (n: number) => void
  ariaLabel: string
  placeholder?: string
  style?: CSSProperties
}

/**
 * Money input backed by a STRING (not a controlled `<input type="number">`).
 *
 * A controlled number input (`value={someNumber}` + `setX(+e.target.value)`) fights the user:
 * React forces the DOM value back to the coerced number on every keystroke, so digits get
 * dropped while a lone "." lingers (it doesn't change the parsed number) — the "only periods
 * stick" bug. Here we keep the raw text locally, sanitize to digits + one decimal point, and
 * surface the parsed number to the parent. `inputMode="decimal"` keeps the mobile numeric keypad.
 */
export function AmountInput({ value, onValueChange, ariaLabel, placeholder = '0.00', style }: AmountInputProps) {
  const [text, setText] = useState(value ? String(value) : '')

  // Sync external/programmatic changes (e.g. quick-select chips) WITHOUT clobbering in-progress
  // typing: only overwrite when the parent's number differs from what the text already parses to
  // (so "5." stays "5." while the parent holds 5).
  useEffect(() => {
    const cur = parseFloat(text)
    if ((Number.isNaN(cur) ? 0 : cur) !== value) setText(value ? String(value) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  function handle(raw: string) {
    let v = raw.replace(/[^\d.]/g, '') // digits + dots only
    const dot = v.indexOf('.')
    if (dot !== -1) {
      // collapse extra dots, then cap fractional digits at USDC precision (6) so callers that do
      // parseUnits(String(amount), 6) never throw on an over-precise entry.
      v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '').slice(0, 6)
    }
    setText(v)
    const n = parseFloat(v)
    onValueChange(Number.isNaN(n) ? 0 : n)
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      onChange={(e) => handle(e.target.value)}
      aria-label={ariaLabel}
      style={{ background: 'transparent', border: 'none', color: 'var(--text)', fontFamily: 'var(--mono)', width: '100%', ...style }}
    />
  )
}
