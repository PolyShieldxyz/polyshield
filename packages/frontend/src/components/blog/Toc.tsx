'use client'
import { useEffect, useState } from 'react'

export interface Heading {
  id: string
  text: string
}

/* Desktop right-rail TOC with scroll-spy. Observes the <h2 id> elements that
   MDXRemote renders and highlights the section in view. Hidden ≤1080px (blog.css);
   the mobile <details> variant below takes over there. Degrades to a plain anchor
   list with no JS. */
export function Toc({ headings }: { headings: Heading[] }) {
  const [active, setActive] = useState(headings[0]?.id)

  useEffect(() => {
    if (!headings.length) return
    const els = headings.map((h) => document.getElementById(h.id)).filter((e): e is HTMLElement => !!e)
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive((e.target as HTMLElement).id)
        }
      },
      { rootMargin: '-72px 0px -65% 0px', threshold: 0 },
    )
    els.forEach((el) => obs.observe(el))
    return () => obs.disconnect()
  }, [headings])

  if (!headings.length) return <nav className="toc" aria-hidden />

  return (
    <nav className="toc" aria-label="On this page">
      <div className="ttl">On this page</div>
      {headings.map((h) => (
        <a key={h.id} href={`#${h.id}`} className={active === h.id ? 'active' : undefined}>
          {h.text}
        </a>
      ))}
    </nav>
  )
}

/* Mobile/tablet TOC — a collapsible list rendered at the top of the article. */
export function TocMobile({ headings }: { headings: Heading[] }) {
  if (!headings.length) return null
  return (
    <details className="toc-mobile">
      <summary>On this page</summary>
      {headings.map((h) => (
        <a key={h.id} href={`#${h.id}`}>
          {h.text}
        </a>
      ))}
    </details>
  )
}
