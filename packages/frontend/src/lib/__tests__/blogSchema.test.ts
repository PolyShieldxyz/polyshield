import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from '@/lib/blogSchema'

const base = {
  slug: 'x',
  title: 'Title',
  description: 'desc',
  date: '2026-06-25',
  hero_image: { src: '/blog/img/x-hero.png', alt: 'alt' },
}

describe('parseFrontmatter', () => {
  it('accepts valid frontmatter and defaults og_image to the hero', () => {
    const r = parseFrontmatter(base, 'x.md')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.meta.slug).toBe('x')
      expect(r.meta.og_image).toBe('/blog/img/x-hero.png')
      expect(r.meta.author).toBe('PolyShield Team') // default
      expect(r.meta.pillar).toBe(1) // default
    }
  })

  it('coerces a YAML Date back to YYYY-MM-DD', () => {
    const r = parseFrontmatter({ ...base, date: new Date(Date.UTC(2026, 5, 25)) }, 'x.md')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.meta.date).toBe('2026-06-25')
  })

  it('prefers og.image, then og_image, then hero for the OG image', () => {
    const r = parseFrontmatter({ ...base, og: { image: '/og.png' } }, 'x.md')
    if (r.ok) expect(r.meta.og_image).toBe('/og.png')
  })

  it('tolerates the extra editorial fields drafts carry', () => {
    const r = parseFrontmatter(
      { ...base, channel: 'blog', type: 'pillar', role: 'PILLAR', word_count_target: '2000', internal_links: ['/a'] },
      'x.md',
    )
    expect(r.ok).toBe(true)
  })

  it('coerces a numeric-string pillar', () => {
    const r = parseFrontmatter({ ...base, pillar: '2' }, 'x.md')
    if (r.ok) expect(r.meta.pillar).toBe(2)
  })

  it('fails with a readable message when a required field is missing', () => {
    const { title: _omit, ...noTitle } = base
    const r = parseFrontmatter(noTitle, 'bad.md')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('bad.md')
      expect(r.error).toContain('title')
    }
  })

  it('rejects a malformed date', () => {
    const r = parseFrontmatter({ ...base, date: 'June 25' }, 'bad.md')
    expect(r.ok).toBe(false)
  })
})
