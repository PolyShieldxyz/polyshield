'use client'

import { useEffect, useState, useCallback } from 'react'
import { createPublicClient, http, parseAbiItem, type Log } from 'viem'
import { polygon, polygonAmoy } from 'viem/chains'
import { defineChain } from 'viem'

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
  'Bet Cancellation':     'oklch(0.80 0.15 70)',
  'N/A Cancellation':     'oklch(0.80 0.15 70)',
  'Withdrawal':           'var(--text-2)',
  'Market Resolved':      'oklch(0.75 0.15 40)',
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
  if (chainId === 80002) return createPublicClient({ chain: polygonAmoy, transport: http() })
  return createPublicClient({ chain: polygon, transport: http() })
}

// ── Event fetchers ───────────────────────────────────────────────────────────

async function fetchVaultTxs(
  vaultAddress: `0x${string}`,
  chainId: number,
): Promise<VaultTx[]> {
  const client = buildClient(chainId)

  const [
    deposited,
    betAuthorized,
    settlementCredited,
    betCancelled,
    naCancelled,
    withdrawn,
    marketResolved,
  ] = await Promise.all([
    client.getLogs({ address: vaultAddress, event: parseAbiItem('event Deposited(address indexed depositor, bytes32 commitment, uint256 amount)'), fromBlock: 0n }),
    client.getLogs({ address: vaultAddress, event: parseAbiItem('event BetAuthorized(bytes32 indexed nullifier, bytes32 market_id, bytes32 position_id, uint64 expected_shares, uint256 bet_amount, uint64 price, uint8 outcome_side, bytes32 new_commitment)'), fromBlock: 0n }),
    client.getLogs({ address: vaultAddress, event: parseAbiItem('event SettlementCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment)'), fromBlock: 0n }),
    client.getLogs({ address: vaultAddress, event: parseAbiItem('event BetCancellationCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment)'), fromBlock: 0n }),
    client.getLogs({ address: vaultAddress, event: parseAbiItem('event NACancellationCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment)'), fromBlock: 0n }),
    client.getLogs({ address: vaultAddress, event: parseAbiItem('event Withdrawn(bytes32 indexed nullifier, address recipient, uint256 amount, bytes32 new_commitment)'), fromBlock: 0n }),
    client.getLogs({ address: vaultAddress, event: parseAbiItem('event MarketResolved(bytes32 indexed market_id, uint64 resolvedAt)'), fromBlock: 0n }),
  ])

  const blockNums = new Set<bigint>()
  const allLogs = [...deposited, ...betAuthorized, ...settlementCredited, ...betCancelled, ...naCancelled, ...withdrawn, ...marketResolved]
  allLogs.forEach((l) => { if (l.blockNumber != null) blockNums.add(l.blockNumber) })

  const blockTimestamps = new Map<bigint, number>()
  await Promise.all(
    [...blockNums].map(async (bn) => {
      try {
        const block = await client.getBlock({ blockNumber: bn })
        blockTimestamps.set(bn, Number(block.timestamp))
      } catch {
        // leave undefined — will show as '—'
      }
    }),
  )

  const ts = (log: Log) => (log.blockNumber != null ? (blockTimestamps.get(log.blockNumber) ?? null) : null)

  const rows: VaultTx[] = [
    ...deposited.map((l) => ({
      id: `dep-${l.transactionHash}-${l.logIndex}`,
      type: 'Deposit' as TxType,
      timestamp: ts(l),
      blockNumber: l.blockNumber ?? 0n,
      txHash: l.transactionHash ?? '',
      amount: (l.args as { amount?: bigint }).amount ?? null,
      status: 'Confirmed' as const,
    })),
    ...betAuthorized.map((l) => ({
      id: `bet-${l.transactionHash}-${l.logIndex}`,
      type: 'Bet Authorized' as TxType,
      timestamp: ts(l),
      blockNumber: l.blockNumber ?? 0n,
      txHash: l.transactionHash ?? '',
      amount: (l.args as { bet_amount?: bigint }).bet_amount ?? null,
      nullifier: (l.args as { nullifier?: string }).nullifier ?? undefined,
      status: 'Confirmed' as const,
    })),
    ...settlementCredited.map((l) => ({
      id: `settle-${l.transactionHash}-${l.logIndex}`,
      type: 'Settlement Credited' as TxType,
      timestamp: ts(l),
      blockNumber: l.blockNumber ?? 0n,
      txHash: l.transactionHash ?? '',
      amount: null,
      nullifier: (l.args as { nullifier?: string }).nullifier ?? undefined,
      status: 'Confirmed' as const,
    })),
    ...betCancelled.map((l) => ({
      id: `betcancel-${l.transactionHash}-${l.logIndex}`,
      type: 'Bet Cancellation' as TxType,
      timestamp: ts(l),
      blockNumber: l.blockNumber ?? 0n,
      txHash: l.transactionHash ?? '',
      amount: null,
      nullifier: (l.args as { nullifier?: string }).nullifier ?? undefined,
      status: 'Confirmed' as const,
    })),
    ...naCancelled.map((l) => ({
      id: `nacancel-${l.transactionHash}-${l.logIndex}`,
      type: 'N/A Cancellation' as TxType,
      timestamp: ts(l),
      blockNumber: l.blockNumber ?? 0n,
      txHash: l.transactionHash ?? '',
      amount: null,
      nullifier: (l.args as { nullifier?: string }).nullifier ?? undefined,
      status: 'Confirmed' as const,
    })),
    ...withdrawn.map((l) => ({
      id: `wdraw-${l.transactionHash}-${l.logIndex}`,
      type: 'Withdrawal' as TxType,
      timestamp: ts(l),
      blockNumber: l.blockNumber ?? 0n,
      txHash: l.transactionHash ?? '',
      amount: (l.args as { amount?: bigint }).amount ?? null,
      nullifier: (l.args as { nullifier?: string }).nullifier ?? undefined,
      status: 'Confirmed' as const,
    })),
    ...marketResolved.map((l) => ({
      id: `mktres-${l.transactionHash}-${l.logIndex}`,
      type: 'Market Resolved' as TxType,
      timestamp: ts(l),
      blockNumber: l.blockNumber ?? 0n,
      txHash: l.transactionHash ?? '',
      amount: null,
      status: 'Confirmed' as const,
    })),
  ]

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
  vaultAddress: `0x${string}`,
  chainId: number,
): Promise<number> {
  const client = buildClient(chainId)
  const logs = await client.getLogs({
    address: vaultAddress,
    event: parseAbiItem('event Deposited(address indexed depositor, bytes32 commitment, uint256 amount)'),
    fromBlock: 0n,
  })
  const unique = new Set(logs.map((l) => (l.args as { depositor?: string }).depositor?.toLowerCase()))
  unique.delete(undefined as unknown as string)
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

        {error && (
          <div className="panel" style={{ padding: 16, marginBottom: 24, borderColor: 'var(--red)', color: 'var(--red)' }}>
            {error}
          </div>
        )}

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
              onClick={() => setFilter(f)}
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
                  {visible.map((tx) => (
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
                <span className="pill" style={{ background: 'oklch(0.25 0.08 210)', color: 'var(--cyan)', fontSize: 9 }}>
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
