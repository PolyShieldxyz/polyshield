'use client'

import { type ReactNode, useEffect, useRef } from 'react'
import { Icon, ICONS } from '@/components/ui/Icon'

interface ModalProps {
  open: boolean
  title: string
  eyebrow?: string
  onClose: () => void
  children: ReactNode
  width?: number
}

function getFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return []
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
}

export function Modal({ open, title, eyebrow = 'APP', onClose, children, width = 760 }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusables = getFocusable(dialogRef.current)
    focusables[0]?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }

      if (event.key !== 'Tab') return
      const current = getFocusable(dialogRef.current)
      if (current.length === 0) return

      const first = current[0]
      const last = current[current.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      aria-hidden={!open}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 120,
        background: 'rgba(6, 8, 11, 0.74)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        className="panel"
        style={{
          width: '100%',
          maxWidth: width,
          maxHeight: 'min(88vh, 900px)',
          overflow: 'auto',
          boxShadow: 'var(--shadow-2)',
        }}
      >
        <div className="row hairline-b" style={{ justifyContent: 'space-between', padding: '16px 18px' }}>
          <div>
            <div className="micro">{eyebrow}</div>
            <h3 className="h4 mt-2" style={{ margin: 0 }}>{title}</h3>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close modal">
            <Icon d={ICONS.cross} size={14} />
          </button>
        </div>
        <div style={{ padding: 18 }}>{children}</div>
      </div>
    </div>
  )
}
