'use client'
import Link from 'next/link'
import type { ReactNode } from 'react'
import type { DocSection } from '@/content/docs'

/* Presentational docs layout. Responsive (CSS .docs-* in globals.css):
   ≥901px → sticky 230px sidebar + content; ≤900px → content single-column with a
   collapsible <details> nav on top. Active state is derived from `slug` (a prop), so
   no client state is needed beyond the native <details> toggle. */
export function DocsShell({
  sections,
  slug,
  section,
  title,
  children,
}: {
  sections: DocSection[]
  slug: string
  section: string
  title: string
  children: ReactNode
}) {
  const nav = sections.map((sec) => (
    <div key={sec.title} style={{ marginBottom: 18 }}>
      <div className="docs-secttl">{sec.title}</div>
      {sec.pages.map((p) => (
        <Link
          key={p.slug}
          href={`/docs/${p.slug}`}
          className={`docs-link${p.slug === slug ? ' active' : ''}`}
          aria-current={p.slug === slug ? 'page' : undefined}
        >
          {p.title}
        </Link>
      ))}
    </div>
  ))

  return (
    <div className="docs-shell">
      <nav className="docs-sidebar" aria-label="Documentation">
        <div className="micro" style={{ marginBottom: 14 }}>DOCS</div>
        {nav}
      </nav>

      <details className="docs-nav-mobile">
        <summary>Docs menu · {section}</summary>
        {nav}
      </details>

      <article style={{ minWidth: 0 }}>
        <div className="micro" style={{ color: 'var(--text-2)', marginBottom: 8 }}>{section.toUpperCase()}</div>
        <h1 style={{ margin: '0 0 24px', fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em' }}>{title}</h1>
        <div style={{ maxWidth: 720 }}>{children}</div>
      </article>
    </div>
  )
}
