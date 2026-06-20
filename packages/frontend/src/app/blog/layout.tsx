import '@/styles/blog.css'
import type { ReactNode } from 'react'

// All blog pages share the scoped `.blog` wrapper (so blog.css selectors apply)
// and the blog stylesheet. Per-page metadata is set by each page / generateMetadata.
export default function BlogLayout({ children }: { children: ReactNode }) {
  return <div className="blog">{children}</div>
}
