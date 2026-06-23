import { getPublishedPosts } from '@/lib/blogContent'
import { SITE_URL } from '@/lib/brand'

// RSS feed for distribution + answer-engine ingestion. Reads the content dir at request
// time and is cached; refreshed on publish via /api/revalidate (revalidate = safety net).
export const revalidate = 3600

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function GET() {
  const items = getPublishedPosts().map(
    ({ meta }) => `    <item>
      <title>${esc(meta.title)}</title>
      <link>${SITE_URL}/blog/${meta.slug}</link>
      <guid isPermaLink="true">${SITE_URL}/blog/${meta.slug}</guid>
      <pubDate>${new Date(meta.date).toUTCString()}</pubDate>
      <description>${esc(meta.description)}</description>
    </item>`,
  ).join('\n')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>PolyShield Blog</title>
    <link>${SITE_URL}/blog</link>
    <description>Privacy on Polymarket, explained — what leaks, why it matters, and how zero-knowledge cryptography fixes it.</description>
    <language>en</language>
${items}
  </channel>
</rss>`

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  })
}
