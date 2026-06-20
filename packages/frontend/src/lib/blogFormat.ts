// Client-safe blog helpers (no fs), so client components (PostGrid, BlogKit) can
// import them without pulling server-only code into the browser bundle.

/** Human date e.g. "Jun 30, 2026" from an ISO YYYY-MM-DD (locale-stable). */
export function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[(m || 1) - 1]} ${d}, ${y}`
}

/** Slug a heading consistently so the TOC anchor and the rendered <h2 id> match. */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[`*_]/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
}
