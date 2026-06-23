import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/brand'
import { getPublishedPosts } from '@/lib/blogContent'
import { DOC_PAGES } from '@/content/docs'

// SEO: serve a real /sitemap.xml so search engines discover the educational/marketing
// surface without relying on crawl-link discovery. The blog index + every post are
// emitted from the runtime content dir (BLOG_CONTENT_DIR). The authenticated /app dApp
// is excluded. Refreshed on publish via /api/revalidate; revalidate is the safety net.
export const revalidate = 3600

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes: {
    path: string
    priority: number
    changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency']
  }[] = [
    { path: '/', priority: 1.0, changeFrequency: 'weekly' },
    { path: '/how', priority: 0.9, changeFrequency: 'monthly' },
    { path: '/blog', priority: 0.7, changeFrequency: 'weekly' },
    { path: '/roadmap', priority: 0.5, changeFrequency: 'monthly' },
  ]
  const now = new Date()

  const staticEntries = staticRoutes.map(({ path, priority, changeFrequency }) => ({
    url: `${SITE_URL}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
  }))

  // /docs is now per-page routes (/docs/[slug]); emit each so they're crawlable.
  // The first page (Overview) is the canonical docs landing, so it ranks highest.
  const docEntries = DOC_PAGES.map((p, i) => ({
    url: `${SITE_URL}/docs/${p.slug}`,
    lastModified: now,
    changeFrequency: 'weekly' as const,
    priority: i === 0 ? 0.8 : 0.6,
  }))

  const postEntries = getPublishedPosts().map(({ meta }) => ({
    url: `${SITE_URL}/blog/${meta.slug}`,
    lastModified: new Date(meta.date_modified ?? meta.date),
    changeFrequency: 'monthly' as const,
    priority: 0.6,
  }))

  return [...staticEntries, ...docEntries, ...postEntries]
}
