'use client'
import { type ReactNode } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'

/* Reusable tooltip on Radix primitives (keyboard + hover accessible; styled with P5 tokens).
   Relies on the app-wide <Tooltip.Provider> in providers.tsx. Wrap any focusable trigger:
     <Tip label="…explanation…"><span tabIndex={0}>Liq</span></Tip>
   Note: tooltips are a desktop hover/focus affordance — they don't appear on touch, so never
   put load-bearing information ONLY in a tooltip. */
export function Tip({
  children,
  label,
  side = 'top',
}: {
  children: ReactNode
  label: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="elev"
          style={{
            zIndex: 200,
            maxWidth: 260,
            padding: '8px 11px',
            borderRadius: 'var(--r-2)',
            fontSize: 12,
            lineHeight: 1.5,
            color: 'var(--text-1)',
          }}
        >
          {label}
          <Tooltip.Arrow style={{ fill: 'var(--surface-1)' }} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
