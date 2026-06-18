'use client'
import { useEffect, useRef } from 'react'

/* A slow-drifting graph of nodes and edges, sitting at low opacity behind the
   connect / reconnect / wrong-network gates. It is brand-meaningful, not decoration:
   the product IS a graph of commitments (a Merkle/proof tree), so a living node-edge
   field reinforces "your bets live inside a cryptographic graph." Most nodes are indigo
   (--brand); a few are gold (--accent) — the "inclusion path" motif from the logo.

   Edges form and break as nodes drift past a proximity threshold, so the field reads as
   "some connected, some not." Pure canvas so it paints on first frame (no layout cost),
   pointer-events:none so it never blocks the gate controls, and it honors
   prefers-reduced-motion by rendering a single static frame instead of animating. */

const INDIGO = '130,133,235' // --brand fallback #8285eb, as rgb for alpha modulation
const GOLD = '241,196,94' // --accent fallback #f1c45e
const LINK_DIST = 150 // px within which two nodes draw an edge
const SPEED = 0.12 // px/frame — deliberately slow drift

interface Node {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  gold: boolean
}

export function AppBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    let nodes: Node[] = []
    let raf = 0
    let w = 0
    let h = 0

    const rand = (min: number, max: number) => min + Math.random() * (max - min)

    const seed = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // Scale node count to area, capped for perf on large screens / weak devices.
      const count = Math.min(60, Math.max(18, Math.round((w * h) / 19000)))
      nodes = Array.from({ length: count }, () => ({
        x: rand(0, w),
        y: rand(0, h),
        vx: rand(-SPEED, SPEED),
        vy: rand(-SPEED, SPEED),
        r: rand(2.2, 4.6),
        gold: Math.random() < 0.12, // ~1 in 8 is a gold "inclusion" node
      }))
    }

    const draw = () => {
      ctx.clearRect(0, 0, w, h)
      // Edges first, so nodes sit on top.
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]
          const b = nodes[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const dist = Math.hypot(dx, dy)
          if (dist > LINK_DIST) continue
          // Closer pairs draw a stronger edge; max alpha stays low for subtlety.
          const alpha = (1 - dist / LINK_DIST) * 0.22
          const gold = a.gold && b.gold
          ctx.strokeStyle = `rgba(${gold ? GOLD : INDIGO},${alpha})`
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }
      for (const n of nodes) {
        ctx.fillStyle = `rgba(${n.gold ? GOLD : INDIGO},${n.gold ? 0.55 : 0.42})`
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const step = () => {
      for (const n of nodes) {
        n.x += n.vx
        n.y += n.vy
        if (n.x < 0 || n.x > w) n.vx *= -1
        if (n.y < 0 || n.y > h) n.vy *= -1
      }
      draw()
      raf = requestAnimationFrame(step)
    }

    seed()
    if (reduceMotion) {
      draw() // single static frame — no animation for motion-sensitive users
    } else {
      raf = requestAnimationFrame(step)
    }

    const onResize = () => {
      seed()
      if (reduceMotion) draw()
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return (
    <canvas
      ref={ref}
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        opacity: 0.9,
        pointerEvents: 'none',
        // Fade the field toward the center so the gate panel stays the focal point.
        maskImage: 'radial-gradient(120% 90% at 50% 45%, transparent 18%, #000 70%)',
        WebkitMaskImage: 'radial-gradient(120% 90% at 50% 45%, transparent 18%, #000 70%)',
      }}
    />
  )
}
