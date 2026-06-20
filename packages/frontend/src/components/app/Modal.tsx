'use client'

import { type ReactNode, useRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Icon, ICONS } from '@/components/ui/Icon'

interface ModalProps {
  open: boolean
  title: string
  eyebrow?: string
  onClose: () => void
  children: ReactNode
  width?: number
}

/* Built on Radix Dialog (headless): focus trap, Esc-to-close, scroll-lock, pointer-outside
   close, aria-modal/role=dialog, and — the gap the old hand-rolled version had — automatic
   focus RESTORATION to the trigger on close are all handled by Radix. The visual layer is
   unchanged: the panel is still our `.panel` and the scrim our P5 glass, styled with tokens.
   The public API (open/title/eyebrow/onClose/children/width) is identical, so the five
   consumer modals didn't change. */
export function Modal({ open, title, eyebrow = 'APP', onClose, children, width = 760 }: ModalProps) {
  const contentRef = useRef<HTMLDivElement | null>(null)

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 120,
            // P5 glass scrim. Dialog itself stays a solid .panel — modal content is dense
            // money-data where legibility must win over translucency.
            background: 'color-mix(in oklab, var(--bg) 74%, transparent)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
        />
        <Dialog.Content
          ref={contentRef}
          aria-describedby={undefined}
          className="panel"
          // Focus the first real field on open (not the X), so typing starts in the input.
          // If there's no field, fall through to Radix's default (first focusable).
          onOpenAutoFocus={(event) => {
            const field = contentRef.current?.querySelector<HTMLElement>(
              'input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
            )
            if (field) {
              event.preventDefault()
              field.focus()
            }
          }}
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 121,
            width: 'calc(100% - 48px)',
            maxWidth: width,
            maxHeight: 'min(88vh, 900px)',
            overflow: 'auto',
            boxShadow: 'var(--shadow-2)',
          }}
        >
          <div className="row hairline-b" style={{ justifyContent: 'space-between', padding: '16px 18px' }}>
            <div>
              <div className="micro">{eyebrow}</div>
              <Dialog.Title className="h4 mt-2" style={{ margin: 0 }}>{title}</Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button className="btn btn-sm btn-ghost" aria-label="Close modal">
                <Icon d={ICONS.cross} size={14} />
              </button>
            </Dialog.Close>
          </div>
          <div style={{ padding: 18 }}>{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
