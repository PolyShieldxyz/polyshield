'use client'

import { useState } from 'react'

// Paginate any list to PAGE_SIZE rows. One hook call per table (fixed count, before any early return).
export const PAGE_SIZE = 10
export function usePager<T>(items: T[], pageSize = PAGE_SIZE) {
  const [page, setPage] = useState(0)
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const safePage = Math.min(page, totalPages - 1)
  const pageItems = items.slice(safePage * pageSize, safePage * pageSize + pageSize)
  return { pageItems, page: safePage, setPage, totalPages }
}
// `< 1 2 … n >` page numbers: first, last, and a window around the current page, with ellipses.
export function pageNumbers(current: number, total: number): (number | '…')[] {
  const want = new Set<number>([0, total - 1, current - 1, current, current + 1])
  const shown = [...want].filter((p) => p >= 0 && p < total).sort((a, b) => a - b)
  const out: (number | '…')[] = []
  let prev = -1
  for (const p of shown) {
    if (prev >= 0 && p - prev > 1) out.push('…')
    out.push(p)
    prev = p
  }
  return out
}
export function PagerControls({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  if (totalPages <= 1) return null
  return (
    <div className="row gap-2" style={{ justifyContent: 'flex-end', alignItems: 'center', fontSize: 11, padding: '8px 16px' }}>
      <button className="btn btn-sm btn-ghost" disabled={page === 0} onClick={() => onChange(page - 1)} aria-label="Previous page" style={{ minWidth: 28, justifyContent: 'center' }}>‹</button>
      {pageNumbers(page, totalPages).map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} style={{ color: 'var(--text-3)' }}>…</span>
        ) : (
          <button
            key={p}
            className={`btn btn-sm ${p === page ? 'btn-cyan' : 'btn-ghost'}`}
            onClick={() => onChange(p)}
            style={{ minWidth: 28, justifyContent: 'center' }}
          >
            {p + 1}
          </button>
        ),
      )}
      <button className="btn btn-sm btn-ghost" disabled={page === totalPages - 1} onClick={() => onChange(page + 1)} aria-label="Next page" style={{ minWidth: 28, justifyContent: 'center' }}>›</button>
    </div>
  )
}
// Same control, wrapped as a full-width table row so it can live inside a <tbody>.
export function TablePagerRow({ page, totalPages, onChange, colSpan }: { page: number; totalPages: number; onChange: (p: number) => void; colSpan: number }) {
  if (totalPages <= 1) return null
  return (
    <tr>
      <td colSpan={colSpan} style={{ borderTop: '1px solid var(--line)' }}>
        <PagerControls page={page} totalPages={totalPages} onChange={onChange} />
      </td>
    </tr>
  )
}
