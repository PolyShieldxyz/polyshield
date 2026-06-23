// Blog types + helpers. Pure data module (no fs), safe to import from server or
// client. Posts are authored as Markdown files (frontmatter + body) read at RUNTIME
// from BLOG_CONTENT_DIR by lib/blogContent.ts — publishing is decoupled from the app
// build/deploy. The body is parsed to React elements at render time by
// components/blog/MarkdownRenderer.tsx (react-markdown, NOT compiled MDX — that
// crashed under React 18 + Next 15 RSC; see docs/blog-content-system.md).

export { fmtDate, slugifyHeading } from './blogFormat'

export type Pillar = 1 | 2 | 3 | 4
export type Level = 'beginner' | 'intermediate' | 'advanced'

export interface HeroImage {
  src: string
  alt: string
  caption?: string
}
export interface FaqItem {
  q: string
  a: string
}

export interface SocialMeta {
  title?: string
  description?: string
  image?: string
  type?: string
  card?: string
}

export interface PostMeta {
  slug: string
  title: string // SEO <title>
  subtitle: string // visible deck under H1
  description: string // meta description
  date: string // YYYY-MM-DD published
  date_modified?: string
  author: string
  reading_time: string // e.g. "7 min"
  level: Level
  pillar: Pillar
  funnel?: string
  primary_keyword?: string
  secondary_keywords?: string[]
  hero_image: HeroImage
  og_image?: string // defaults to hero
  og?: SocialMeta // optional OpenGraph overrides (title/description/image/type)
  twitter?: SocialMeta // optional Twitter-card overrides
  canonical?: string // defaults to /blog/<slug>
  toc?: string[] // H2 section titles, in order (drive the right-rail TOC)
  faq?: FaqItem[]
  schema?: string[] // e.g. ["Article","FAQPage","HowTo"]
  related?: string[] // slugs
  featured?: boolean // surface in the index featured slot
  // PUBLISH GATE: a post is hidden everywhere (index, sitemap, RSS) and 404s on
  // direct access until a team member sets this to `true`. Drafts are never built
  // or served. This is the deliberate "don't show until we add it" switch.
  published?: boolean
  // Editorial claim-safety sign-off (mirrors the draft frontmatter). Informational
  // for rendering; `published` is the authoritative live switch.
  compliance_checked?: boolean
}

export const PILLARS: Record<Pillar, { key: string; label: string }> = {
  1: { key: 'privacy', label: 'Privacy' },
  2: { key: 'how', label: 'How it works' },
  3: { key: 'strategy', label: 'Strategy' },
  4: { key: 'product', label: 'Product' },
}

/** Serializable card summary for the client grid. */
export interface PostCardData {
  slug: string
  title: string
  subtitle: string
  level: Level
  reading_time: string
  date: string
  pillar: Pillar
  pillarKey: string
  pillarLabel: string
  hero: string
}

export function toCardData(p: PostMeta): PostCardData {
  const { key, label } = PILLARS[p.pillar]
  return {
    slug: p.slug,
    title: p.title,
    subtitle: p.subtitle,
    level: p.level,
    reading_time: p.reading_time,
    date: p.date,
    pillar: p.pillar,
    pillarKey: key,
    pillarLabel: label,
    hero: p.hero_image.src,
  }
}
