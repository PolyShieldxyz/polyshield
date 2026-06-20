import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/brand'

// SEO: serve a real /robots.txt (previously 404'd) with a Sitemap directive.
// The /app surface is the authenticated dApp — keep it out of the index; the
// marketing/educational routes are the indexable surface.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/app', '/app/', '/api/', '/explorer'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
