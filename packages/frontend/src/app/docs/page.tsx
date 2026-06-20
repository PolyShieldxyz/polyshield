import { redirect } from 'next/navigation'
import { DOC_PAGES } from '@/content/docs'

// /docs is now split into per-page, server-rendered routes (/docs/[slug]) so each
// section is deep-linkable, crawlable, and back-button friendly. The index redirects
// to the first page (Overview).
export default function DocsIndex() {
  redirect(`/docs/${DOC_PAGES[0].slug}`)
}
