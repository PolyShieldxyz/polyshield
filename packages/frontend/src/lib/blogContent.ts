import 'server-only'
// Runtime content loader. Reads authored Markdown posts from BLOG_CONTENT_DIR at
// REQUEST/REVALIDATE time — this is what decouples publishing from the app build:
// the post set is no longer compiled into the bundle. The on-disk files are the source
// of truth; the publish step drops/edits a .md and pings /api/revalidate. The dir is a
// mounted volume in production (outside the image) and an in-repo folder in dev.
//
// PUBLIC, anonymous data only — no secrets ever touch this path (privacy invariant).
import fs from 'fs'
import path from 'path'
import { cache } from 'react'
import matter from 'gray-matter'
import type { PostMeta, FaqItem } from './blog'
import { parseFrontmatter } from './blogSchema'
import {
  cleanBody,
  stripFaqSection,
  extractFaq,
  extractHeadings,
  type ExtractedHeading,
} from './blogMarkdown'

export interface PostRecord {
  meta: PostMeta
  /** Render-ready Markdown body: reviewer notes, HTML comments, trailing disclaimer,
   *  and the FAQ section removed (FAQ is rendered separately from `meta.faq`). */
  body: string
  headings: ExtractedHeading[]
}

function contentDir(): string {
  return process.env.BLOG_CONTENT_DIR ?? path.join(process.cwd(), 'content', 'blog-md')
}

function loadOne(dir: string, file: string): PostRecord | null {
  try {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8')
    const { data, content } = matter(raw)
    const parsed = parseFrontmatter(data, file)
    if (!parsed.ok) {
      console.warn(`[blog] skipping ${file}: ${parsed.error}`)
      return null
    }
    const cleaned = cleanBody(content)
    const faq: FaqItem[] = parsed.meta.faq?.length ? parsed.meta.faq : extractFaq(cleaned)
    const body = stripFaqSection(cleaned)
    return {
      meta: { ...parsed.meta, faq: faq.length ? faq : undefined },
      body,
      headings: extractHeadings(body),
    }
  } catch (e) {
    console.warn(`[blog] failed to read ${file}:`, (e as Error).message)
    return null
  }
}

/** All posts (incl. drafts) found in the content dir, newest first. Per-request
 *  memoized; the route/full-route cache + ISR revalidation control freshness across
 *  requests. */
export const getAllPosts = cache((): PostRecord[] => {
  const dir = contentDir()
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('.'))
  } catch {
    console.warn(`[blog] content dir not found: ${dir} (no posts will render)`)
    return []
  }
  const seen = new Set<string>()
  const posts: PostRecord[] = []
  for (const f of files) {
    const rec = loadOne(dir, f)
    if (!rec) continue
    if (seen.has(rec.meta.slug)) {
      console.warn(`[blog] duplicate slug "${rec.meta.slug}" in ${f} — ignoring`)
      continue
    }
    seen.add(rec.meta.slug)
    posts.push(rec)
  }
  return posts.sort((a, b) => (a.meta.date < b.meta.date ? 1 : -1))
})

/** Live posts only — the publish gate. Everything user-facing (index, [slug],
 *  sitemap, RSS) reads from here, so a draft is never listed or served. */
export const getPublishedPosts = cache((): PostRecord[] =>
  getAllPosts().filter((p) => p.meta.published === true),
)

/** Resolve a slug to a PUBLISHED post (drafts/unknown → undefined → the route 404s). */
export function getPostBySlug(slug: string): PostRecord | undefined {
  return getPublishedPosts().find((p) => p.meta.slug === slug)
}

export function getPublishedSlugs(): string[] {
  return getPublishedPosts().map((p) => p.meta.slug)
}
