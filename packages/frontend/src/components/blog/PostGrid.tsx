'use client'
import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import type { PostCardData } from '@/lib/blog'
import { fmtDate } from '@/lib/blogFormat'
import { Icon } from '@/components/ui/Icon'

/* Pillar marks are monochrome line-icons (no pillar colors — that discipline keeps
   the two-accent system intact). Keyed by pillar filter key. */
const PILLAR_ICON: Record<string, string> = {
  privacy: 'M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z',
  how: 'M12 3a9 9 0 100 18 9 9 0 000-18ZM12 8v5',
  strategy: 'M4 18l5-6 4 3 6-8',
  product: 'M4 5h16v14H4z',
}

function Card({ p }: { p: PostCardData }) {
  return (
    <Link className="card" href={`/blog/${p.slug}`}>
      <div className="cthumb">
        <div className="b-line-grid" />
        <Image src={p.hero} alt="" fill sizes="(max-width: 760px) 100vw, 360px" style={{ objectFit: 'cover' }} />
      </div>
      <div className="cbody">
        <div className="eyebrow">
          <Icon d={PILLAR_ICON[p.pillarKey] ?? PILLAR_ICON.privacy} size={11} />
          {p.pillarLabel} · {p.level}
        </div>
        <h4>{p.title}</h4>
        <p>{p.subtitle}</p>
        <div className="cmeta">
          <span className="level">{p.level}</span>
          <span>⏱ {p.reading_time}</span>
          <span>{fmtDate(p.date)}</span>
        </div>
      </div>
    </Link>
  )
}

export function PostGrid({
  posts,
  pillars,
}: {
  posts: PostCardData[]
  pillars: { key: string; label: string }[]
}) {
  const [filter, setFilter] = useState('all')
  const chips = [{ key: 'all', label: 'All' }, ...pillars]
  const shown = filter === 'all' ? posts : posts.filter((p) => p.pillarKey === filter)

  return (
    <>
      <div className="toolbar">
        <h3>Latest articles</h3>
        <div className="chips" role="group" aria-label="Filter by topic">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              className="chip"
              aria-pressed={filter === c.key}
              onClick={() => setFilter(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {shown.length ? (
        <div className="grid">
          {shown.map((p) => (
            <Card key={p.slug} p={p} />
          ))}
        </div>
      ) : (
        <div className="empty">
          No posts in this topic yet —{' '}
          <button type="button" className="gold-link" style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setFilter('all')}>
            browse all articles
          </button>
          .
        </div>
      )}
    </>
  )
}
