'use client'

import { useEffect, useState, useCallback } from 'react'
import { createPublicClient, http } from 'viem'
import { polygon, polygonAmoy } from 'viem/chains'
import { defineChain } from 'viem'
import { polygonReadRpc } from '../../lib/rpc'
import { usePager, TablePagerRow } from '../../components/ui/Pager'

// ── Types ────────────────────────────────────────────────────────────────────

type TxType =
  | 'Deposit'
  | 'Bet Authorized'
  | 'Settlement Credited'
  | 'Bet Cancellation'
  | 'N/A Cancellation'
  | 'Withdrawal'
  | 'Market Resolved'

interface VaultTx {
  id: string
  type: TxType
  timestamp: number | null
  blockNumber: bigint
  txHash: string
  amount: bigint | null
  nullifier?: string
  status: 'Confirmed'
}

const TYPE_COLOR: Record<TxType, string> = {
  'Deposit':              'var(--cyan)',
  'Bet Authorized':       'var(--violet)',
  'Settlement Credited':  'var(--green)',
  'Bet Cancellation':     'oklch(0.80 0.15 55)',
  'N/A Cancellation':     'oklch(0.80 0.15 55)',
  'Withdrawal':           'var(--text-2)',
  'Market Resolved':      'oklch(0.75 0.15 55)',
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncHex(h: string, chars = 8): string {
  if (!h || h.length <= chars * 2 + 2) return h
  return `${h.slice(0, chars + 2)}…${h.slice(-chars)}`
}

function formatUsdc(micro: bigint): string {
  const whole = micro / 1_000_000n
  const frac = micro % 1_000_000n
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '')
  return fracStr ? `$${whole.toLocaleString()}.${fracStr}` : `$${whole.toLocaleString()}`
}

// Age relative to a reference "now" in unix seconds. For on-chain events the reference is
// the CHAIN HEAD's timestamp (not the client wall clock): a local Anvil chain's block clock
// drifts from real time (instant mining / time warps), so `Date.now()` produced nonsense ages
// like "negative" or "hours ago" for a tx placed seconds earlier. Comparing block-time to
// block-time keeps ages correct regardless of that drift.
function formatAge(ts: number | null, nowSec?: number): string {
  if (ts === null) return '—'
  const ref = nowSec ?? Math.floor(Date.now() / 1000)
  const diff = Math.max(0, Math.floor(ref - ts))
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function getChainId(): number {
  const id = process.env.NEXT_PUBLIC_CHAIN_ID
  if (id) return parseInt(id, 10)
  return process.env.NEXT_PUBLIC_DEV_MODE === 'true' ? 31337 : 137
}

function blockExplorerTx(chainId: number, txHash: string): string {
  if (chainId === 80002) return `https://amoy.polygonscan.com/tx/${txHash}`
  if (chainId === 137) return `https://polygonscan.com/tx/${txHash}`
  return `#` // local dev — no explorer
}

// Use the configured RPC for mainnet/amoy (NOT viem's default chain RPC, which falls back to
// drpc/public endpoints with tight free-tier limits). Falls back to undefined => viem default.
const MAINNET_RPC = process.env.NEXT_PUBLIC_POLYGON_RPC || process.env.NEXT_PUBLIC_CHAIN_RPC || undefined
function buildClient(chainId: number) {
  const IS_DEV = process.env.NEXT_PUBLIC_DEV_MODE === 'true'
  const DEV_RPC = process.env.NEXT_PUBLIC_CHAIN_RPC ?? 'http://127.0.0.1:8545'

  if (IS_DEV || chainId === 31337) {
    const anvilChain = defineChain({
      id: 31337,
      name: 'Anvil Local',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [DEV_RPC] } },
    })
    return createPublicClient({ chain: anvilChain, transport: http(DEV_RPC) })
  }
  if (chainId === 80002) return createPublicClient({ chain: polygonAmoy, transport: http(MAINNET_RPC) })
  // Polygon mainnet reads go through the same-origin /api/rpc proxy in prod (server-only key); dev
  // keeps the direct public RPC. See lib/rpc.ts.
  return createPublicClient({ chain: polygon, transport: http(polygonReadRpc()) })
}

// ── Event fetchers (served from the backend index — see fetchBackendEvents) ───

// A single indexed event as served by the proof-relay /api/events (public, anonymous).
type BackendEvent = { type: string; blockNumber: number; logIndex: number; txHash: string; blockTs: number | null; args: Record<string, unknown> }

// Fetch all indexed Vault events from the BACKEND index (proof-relay), not the chain — so the
// Explorer works on a metered RPC (no per-client getLogs scan / 10-block cap).
async function fetchBackendEvents(limit = 2000): Promise<BackendEvent[]> {
  const res = await fetch(`/api/events?limit=${limit}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`events HTTP ${res.status}`)
  const data = (await res.json()) as { events?: BackendEvent[]; error?: string }
  if (data.error) throw new Error(data.error)
  return data.events ?? []
}

async function fetchVaultTxs(
  _vaultAddress: `0x${string}`,
  _chainId: number,
): Promise<VaultTx[]> {
  const events = await fetchBackendEvents(2000)
  const big = (v: unknown): bigint | null => (v == null ? null : BigInt(v as string))
  const nf = (e: BackendEvent) => (e.args.nullifier as string | undefined) ?? undefined

  const rows: VaultTx[] = []
  for (const e of events) {
    const base = { timestamp: e.blockTs ?? null, blockNumber: BigInt(e.blockNumber), txHash: e.txHash, status: 'Confirmed' as const }
    switch (e.type) {
      case 'Deposited': rows.push({ id: `dep-${e.txHash}-${e.logIndex}`, type: 'Deposit', amount: big(e.args.amount), ...base }); break
      case 'BetAuthorized': rows.push({ id: `bet-${e.txHash}-${e.logIndex}`, type: 'Bet Authorized', amount: big(e.args.bet_amount), nullifier: nf(e), ...base }); break
      case 'SettlementCredited': rows.push({ id: `settle-${e.txHash}-${e.logIndex}`, type: 'Settlement Credited', amount: null, nullifier: nf(e), ...base }); break
      case 'BetCancellationCredited': rows.push({ id: `betcancel-${e.txHash}-${e.logIndex}`, type: 'Bet Cancellation', amount: null, nullifier: nf(e), ...base }); break
      case 'NACancellationCredited': rows.push({ id: `nacancel-${e.txHash}-${e.logIndex}`, type: 'N/A Cancellation', amount: null, nullifier: nf(e), ...base }); break
      case 'Withdrawn': rows.push({ id: `wdraw-${e.txHash}-${e.logIndex}`, type: 'Withdrawal', amount: big(e.args.amount), nullifier: nf(e), ...base }); break
      case 'MarketResolved': rows.push({ id: `mktres-${e.txHash}-${e.logIndex}`, type: 'Market Resolved', amount: null, ...base }); break
      default: break // PartialFillCredited / BetSold / PositionClosed / Consolidated — not shown in the explorer
    }
  }
  rows.sort((a, b) => Number(b.blockNumber - a.blockNumber))
  return rows
}

// Chain head timestamp (unix seconds) — the reference "now" for event ages.
async function fetchChainNow(chainId: number): Promise<number | null> {
  try {
    const block = await buildClient(chainId).getBlock({ blockTag: 'latest' })
    return Number(block.timestamp)
  } catch {
    return null
  }
}

async function fetchUniqueDepositors(
  _vaultAddress: `0x${string}`,
  _chainId: number,
): Promise<number> {
  const events = await fetchBackendEvents(5000)
  const unique = new Set<string>()
  for (const e of events) {
    if (e.type === 'Deposited') {
      const d = (e.args.depositor as string | undefined)?.toLowerCase()
      if (d) unique.add(d)
    }
  }
  return unique.size
}

// ── Component ────────────────────────────────────────────────────────────────

const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS ?? '') as `0x${string}`
const CHAIN_ID = getChainId()

const TYPE_FILTERS: TxType[] = [
  'Deposit',
  'Bet Authorized',
  'Settlement Credited',
  'Bet Cancellation',
  'N/A Cancellation',
  'Withdrawal',
  'Market Resolved',
]

export default function ExplorerPage() {
  const [txs, setTxs] = useState<VaultTx[]>([])
  const [depositors, setDepositors] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<TxType | 'ALL'>('ALL')
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [chainNow, setChainNow] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    if (!VAULT_ADDRESS || VAULT_ADDRESS === '0x') {
      setError('Vault address not configured (NEXT_PUBLIC_VAULT_ADDRESS).')
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      const [rows, dep, now] = await Promise.all([
        fetchVaultTxs(VAULT_ADDRESS, CHAIN_ID),
        fetchUniqueDepositors(VAULT_ADDRESS, CHAIN_ID),
        fetchChainNow(CHAIN_ID),
      ])
      setTxs(rows)
      setDepositors(dep)
      setChainNow(now)
      setLastRefreshed(new Date())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch vault events.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => { void refresh() }, 15_000)
    return () => window.clearInterval(id)
  }, [refresh])

  const visible = filter === 'ALL' ? txs : txs.filter((t) => t.type === filter)
  const { pageItems, page, setPage, totalPages } = usePager(visible, 20)

  const stats = [
    { label: 'Total events', value: txs.length },
    { label: 'Deposits', value: txs.filter((t) => t.type === 'Deposit').length },
    { label: 'Bets authorized', value: txs.filter((t) => t.type === 'Bet Authorized').length },
    { label: 'Settlements', value: txs.filter((t) => t.type === 'Settlement Credited').length },
    { label: 'Withdrawals', value: txs.filter((t) => t.type === 'Withdrawal').length },
  ]

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-0)', fontFamily: 'JetBrains Mono, monospace' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 24px' }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
          <div>
            <div className="micro" style={{ marginBottom: 4 }}>VAULT EXPLORER</div>
            <h2 className="h3" style={{ margin: 0 }}>On-chain activity</h2>
            <div className="small mt-1" style={{ color: 'var(--text-3)', fontSize: 11 }}>
              Public data only · Nullifiers and commitments are shown as truncated hex
            </div>
          </div>
          <div className="row gap-3" style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {lastRefreshed && <span>Updated {formatAge(Math.floor(lastRefreshed.getTime() / 1000))}</span>}
            <button className="btn btn-sm btn-ghost" onClick={() => void refresh()} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* CRED-002: never surface a raw HTTP status / backend message to users. A 503
            "event index not ready" is the indexer still catching up (transient) — frame it
            as indexing, not failure; anything else is a soft "couldn't load · retry". */}
        {error && (() => {
          const indexing = /not ready|503|index/i.test(error)
          const misconfigured = /not configured/i.test(error)
          return (
            <div
              className="panel"
              style={{
                padding: 16,
                marginBottom: 24,
                borderColor: misconfigured ? 'oklch(0.70 0.18 25 / 0.4)' : 'var(--line-strong)',
              }}
            >
              <div className="row gap-3" style={{ alignItems: 'flex-start' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: indexing ? 'var(--amber)' : 'var(--red)', flexShrink: 0, marginTop: 5 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, color: 'var(--text)', fontSize: 13 }}>
                    {misconfigured ? 'Explorer unavailable' : indexing ? 'Indexing on-chain activity…' : 'Couldn’t load vault activity'}
                  </div>
                  <div className="small mt-1" style={{ fontSize: 12 }}>
                    {misconfigured
                      ? 'The vault address isn’t configured for this environment.'
                      : indexing
                        ? 'The public event index is still catching up to the chain. This view will populate automatically — no action needed.'
                        : 'We couldn’t reach the indexer. This is usually temporary.'}
                  </div>
                </div>
                {!misconfigured && (
                  <button className="btn btn-sm btn-ghost" onClick={() => void refresh()} disabled={loading}>
                    {loading ? 'Retrying…' : 'Retry'}
                  </button>
                )}
              </div>
            </div>
          )
        })()}

        {/* Stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 24 }}>
          {stats.map(({ label, value }) => (
            <div key={label} className="panel" style={{ padding: '12px 16px' }}>
              <div className="micro" style={{ fontSize: 9 }}>{label.toUpperCase()}</div>
              <div className="num mt-1" style={{ fontSize: 22 }}>{loading ? '—' : value}</div>
            </div>
          ))}
        </div>

        {/* Filter chips */}
        <div className="row gap-2" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
          {(['ALL', ...TYPE_FILTERS] as const).map((f) => (
            <button
              key={f}
              className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => { setFilter(f); setPage(0) }}
              style={{ fontSize: 10 }}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Transaction table */}
        <div className="panel" style={{ padding: 0, overflow: 'hidden', marginBottom: 40 }}>
          <div className="row hairline-b" style={{ padding: '12px 16px', justifyContent: 'space-between' }}>
            <div className="micro">TRANSACTIONS</div>
            <span className="pill pill-soft" style={{ fontSize: 10 }}>{visible.length} events</span>
          </div>
          {loading && txs.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
              Loading vault events…
            </div>
          ) : visible.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
              No events found.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Age</th>
                    <th>Block</th>
                    <th>TX Hash</th>
                    <th>Nullifier / ID</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((tx) => (
                    <tr key={tx.id}>
                      <td>
                        <span style={{ color: TYPE_COLOR[tx.type], fontWeight: 600, fontSize: 11 }}>
                          {tx.type.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ color: 'var(--text-3)', fontSize: 11 }}>
                        {formatAge(tx.timestamp, chainNow ?? undefined)}
                      </td>
                      <td style={{ color: 'var(--text-2)', fontSize: 11 }}>
                        {tx.blockNumber.toString()}
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: 11 }}>
                        {tx.txHash ? (
                          <a
                            href={blockExplorerTx(CHAIN_ID, tx.txHash)}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'var(--cyan)', textDecoration: 'none' }}
                          >
                            {truncHex(tx.txHash, 4)}
                          </a>
                        ) : '—'}
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-3)' }}>
                        {tx.nullifier ? truncHex(tx.nullifier, 4) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontSize: 11 }}>
                        {tx.amount != null ? formatUsdc(tx.amount) : '—'}
                      </td>
                      <td>
                        <span className="pill pill-soft" style={{ fontSize: 9, color: 'var(--green)' }}>
                          {tx.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                  <TablePagerRow page={page} totalPages={totalPages} onChange={setPage} colSpan={7} />
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Privacy Metrics section */}
        <div style={{ marginBottom: 40 }}>
          <div className="micro" style={{ marginBottom: 12 }}>PRIVACY METRICS</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <div className="panel" style={{ padding: 20 }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                <div className="micro" style={{ fontSize: 9 }}>UNIQUE DEPOSITORS</div>
                <span className="pill" style={{ background: 'oklch(0.25 0.08 85)', color: 'var(--cyan)', fontSize: 9 }}>
                  <span className="dot" style={{ background: 'var(--cyan)', boxShadow: '0 0 6px var(--cyan)' }}></span>
                  LIVE
                </span>
              </div>
              <div className="num" style={{ fontSize: 32 }}>
                {loading ? '—' : (depositors ?? '—')}
              </div>
              <div className="small mt-1" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                Wallets currently holding funds in the vault
              </div>
            </div>

            {[
              { label: 'Anonymity set size', note: 'Active depositors whose withdrawal cannot be linked to their deposit' },
              { label: 'Entropy score', note: 'Measure of indistinguishability across the depositor set' },
              { label: 'Median time in vault', note: 'Average duration funds remain deposited before withdrawal' },
            ].map(({ label, note }) => (
              <div key={label} className="panel" style={{ padding: 20, opacity: 0.45 }}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                  <div className="micro" style={{ fontSize: 9 }}>{label.toUpperCase()}</div>
                  <span className="pill pill-soft" style={{ fontSize: 9 }}>Coming soon</span>
                </div>
                <div className="num" style={{ fontSize: 32 }}>—</div>
                <div className="small mt-1" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {note}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
