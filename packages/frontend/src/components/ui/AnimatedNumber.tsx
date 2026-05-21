'use client'
import { useState, useEffect, useRef } from 'react'

interface AnimatedNumberProps {
  value: number
  decimals?: number
  prefix?: string
  suffix?: string
  duration?: number
}

export function AnimatedNumber({ value, decimals = 0, prefix = '', suffix = '', duration = 1400 }: AnimatedNumberProps) {
  const [n, setN] = useState(0)
  const ref = useRef({ raf: 0 })

  useEffect(() => {
    cancelAnimationFrame(ref.current.raf)
    const from = n
    const to = value
    const t0 = performance.now()
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      setN(from + (to - from) * eased)
      if (p < 1) ref.current.raf = requestAnimationFrame(tick)
    }
    ref.current.raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(ref.current.raf)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const formatted = n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  return <span className="num">{prefix}{formatted}{suffix}</span>
}
