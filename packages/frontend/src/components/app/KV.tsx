interface KVProps {
  l: string
  v: string | number
  mono?: boolean
}

export function KV({ l, v, mono = true }: KVProps) {
  return (
    <div className="row hairline-b" style={{ padding: '10px 0', justifyContent: 'space-between' }}>
      <span className="small" style={{ fontSize: 12 }}>{l}</span>
      <span className={mono ? 'mono' : ''} style={{ fontSize: 13, color: 'var(--text)' }}>{v}</span>
    </div>
  )
}
