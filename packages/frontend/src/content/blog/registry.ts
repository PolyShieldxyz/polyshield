import type { ComponentType } from 'react'
import type { PostMeta } from '@/lib/blog'
// Post registry. Each post is a TSX module exporting `meta` + a default component
// (compiled by Next's SWC — the RSC-safe path; see docs/blog-design.md on why MDX
// isn't used under React 18 + Next 15).
//
// ADDING A POST: create content/blog/<slug>.tsx (export meta + default Post), then
// add one import + one entry to MODULES below.
import * as areTradesPublic from './are-polymarket-trades-public'
import * as betPrivately from './how-to-bet-on-polymarket-privately'
import * as hidePositions from './hide-polymarket-positions'

export interface PostModule {
  meta: PostMeta
  Content: ComponentType
}

const MODULES: { meta: PostMeta; default: ComponentType }[] = [
  areTradesPublic,
  betPrivately,
  hidePositions,
]

/** Every registered post, newest first (includes drafts — internal use only). */
export const ALL_POSTS: PostModule[] = MODULES.map((m) => ({ meta: m.meta, Content: m.default })).sort(
  (a, b) => (a.meta.date < b.meta.date ? 1 : -1),
)

/** PUBLISH GATE: only posts a team member has explicitly marked `published: true`.
 *  Everything user-facing (index, [slug], sitemap, RSS) reads from here, so a draft
 *  is never listed, built, or served until it is published. */
export const PUBLISHED_POSTS: PostModule[] = ALL_POSTS.filter((p) => p.meta.published === true)

/** Resolve a slug to a PUBLISHED post (drafts return undefined → the route 404s). */
export function getPost(slug: string): PostModule | undefined {
  return PUBLISHED_POSTS.find((p) => p.meta.slug === slug)
}
