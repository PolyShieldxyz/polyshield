// Frontmatter validation + normalization. The boundary between untrusted authored
// content and the typed PostMeta the app renders. Tolerant of the extra editorial
// fields drafts carry (channel, type, role, word_count_target, internal_links, …) but
// strict about the SEO/render-critical ones — a malformed post fails loudly with a
// readable error instead of rendering broken. NO fs (pure), so it's unit-testable.
import { z } from 'zod'
import type { PostMeta } from './blog'

/** YAML parses an unquoted `date: 2026-06-25` into a JS Date; coerce back to the
 *  protocol's YYYY-MM-DD string form. Accepts already-string dates untouched. */
function toISODate(v: unknown): string | undefined {
  if (v == null || v === '') return undefined
  if (v instanceof Date) {
    const y = v.getUTCFullYear()
    const m = String(v.getUTCMonth() + 1).padStart(2, '0')
    const d = String(v.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(v)
}

const social = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    image: z.string().optional(),
    type: z.string().optional(),
    card: z.string().optional(),
  })
  .optional()

const schema = z
  .object({
    slug: z.string().min(1),
    title: z.string().min(1),
    subtitle: z.string().default(''),
    description: z.string().default(''),
    date: z.preprocess(toISODate, z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    date_modified: z.preprocess(toISODate, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
    author: z.string().default('PolyShield Team'),
    reading_time: z.string().default(''),
    level: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner'),
    pillar: z.coerce.number().int().min(1).max(4).default(1),
    funnel: z.string().optional(),
    primary_keyword: z.string().optional(),
    secondary_keywords: z.array(z.string()).optional(),
    hero_image: z.object({
      src: z.string(),
      alt: z.string().default(''),
      caption: z.string().optional(),
    }),
    og_image: z.string().optional(),
    og: social,
    twitter: social,
    canonical: z.string().optional(),
    toc: z.array(z.string()).optional(),
    faq: z.array(z.object({ q: z.string(), a: z.string() })).optional(),
    schema: z.array(z.string()).optional(),
    related: z.array(z.string()).optional(),
    featured: z.boolean().optional(),
    published: z.boolean().optional(),
    compliance_checked: z.boolean().optional(),
  })
  .passthrough()

export type ParseResult =
  | { ok: true; meta: PostMeta }
  | { ok: false; error: string }

/** Validate + normalize raw frontmatter (from gray-matter) into PostMeta. Returns a
 *  result object rather than throwing so the loader can skip a bad file and surface a
 *  clear per-file message instead of crashing the whole blog. */
export function parseFrontmatter(raw: unknown, file: string): ParseResult {
  const r = schema.safeParse(raw)
  if (!r.success) {
    const issues = r.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    return { ok: false, error: `${file}: invalid frontmatter — ${issues}` }
  }
  const d = r.data
  const meta: PostMeta = {
    slug: d.slug,
    title: d.title,
    subtitle: d.subtitle,
    description: d.description,
    date: d.date,
    date_modified: d.date_modified,
    author: d.author,
    reading_time: d.reading_time,
    level: d.level,
    pillar: d.pillar as PostMeta['pillar'],
    funnel: d.funnel,
    primary_keyword: d.primary_keyword,
    secondary_keywords: d.secondary_keywords,
    hero_image: d.hero_image,
    // Normalize the OG image source across the two author conventions
    // (`og_image:` in legacy posts, `og: { image }` in drafts), default to hero.
    og_image: d.og_image ?? d.og?.image ?? d.hero_image.src,
    og: d.og,
    twitter: d.twitter,
    canonical: d.canonical,
    toc: d.toc,
    faq: d.faq,
    schema: d.schema,
    related: d.related,
    featured: d.featured,
    published: d.published,
    compliance_checked: d.compliance_checked,
  }
  return { ok: true, meta }
}
