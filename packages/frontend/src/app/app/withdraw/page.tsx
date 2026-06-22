'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAccount, useSignMessage, useReadContract } from 'wagmi'
import { Icon, ICONS } from '@/components/ui/Icon'
import {
  addNote,
  computeCommitment,
  computeNullifier,
  computeRecipientHash,
  formatUsdc,
  getFreeNotes,
  markNoteSpent,
  MAX_CONSOLIDATE_INPUTS,
  reconcileSpentStatus,
  recordWalletActivity,
  selectNotesForAmount,
  type Note,
} from '@/lib/notes'
import { getNoteSecret } from '@/lib/secretSession'
import { consolidateNotes } from '@/lib/consolidate'
import { usePortfolioState } from '@/lib/accountState'
import {
  fetchMerklePath,
  relayWithdrawal,
  waitForTransactionConfirmation,
  type RelayWithdrawalInputs,
} from '@/lib/api'
import { USDC_ABI, VAULT_ABI } from '@/lib/vaultAbi'
import { LiveRegion } from '@/components/app/LiveRegion'
import { SettleWithdrawModal } from '@/components/app/SettleWithdrawModal'

const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`
const USDC_ADDRESS  = (process.env.NEXT_PUBLIC_USDC_ADDRESS  ?? '0x0000000000000000000000000000000000000000') as `0x${string}`
import { generateProofInWorker, type AssetProgress } from '@/lib/prover'
import { LowMemoryNotice } from '@/components/app/LowMemoryNotice'
import { log, proofSummary } from '@/lib/logger'

const ZERO_COMMITMENT = `0x${'00'.repeat(32)}` as `0x${string}`

function parseUsdcToMicro(value: string): bigint | null {
  const normalized = value.trim()
  if (!normalized) return null
  if (!/^\d*(\.\d{0,6})?$/.test(normalized)) return null

  const [wholeRaw, fracRaw = ''] = normalized.split('.')
  const whole = wholeRaw.length === 0 ? 0n : BigInt(wholeRaw)
  const frac = BigInt((fracRaw + '000000').slice(0, 6))
  return whole * 1_000_000n + frac
}

function formatUsdcInput(micro: bigint): string {
  const whole = micro / 1_000_000n
  const frac = micro % 1_000_000n
  const fracText = frac.toString().padStart(6, '0').replace(/0+$/, '')
  return fracText ? `${whole.toString()}.${fracText}` : whole.toString()
}

export default function WithdrawPage() {
  const router = useRouter()
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const { state, loading, refresh } = usePortfolioState(address)

  const [amountInput, setAmountInput] = useState('')
  const [status, setStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const [txHash, setTxHash] = useState('')
  // Determinate download progress (0–100) for the proving-key fetch; null when not downloading.
  const [downloadPct, setDownloadPct] = useState<number | null>(null)
  const [settleWithdrawOpen, setSettleWithdrawOpen] = useState(false)

  const cashNote = state?.cashNote ?? null
  const cashBalance = state?.cashBalance ?? 0n
  const requestedAmount = useMemo(() => parseUsdcToMicro(amountInput), [amountInput])

  // A single withdrawal can merge at most MAX_CONSOLIDATE_INPUTS notes. When cash is spread across
  // more notes than that, the displayed balance isn't withdrawable in one step — surface this BEFORE
  // submit instead of throwing deep inside the proof (selectNotesForAmount) after a sign + merge.
  const maxSingleStep = useMemo(() => {
    if (!address) return 0n
    return getFreeNotes(address)
      .sort((a, b) => (a.balance > b.balance ? -1 : 1))
      .slice(0, MAX_CONSOLIDATE_INPUTS)
      .reduce((sum, n) => sum + n.balance, 0n)
  }, [address, state])
  const fragmented =
    requestedAmount !== null &&
    requestedAmount > 0n &&
    requestedAmount <= cashBalance &&
    requestedAmount > maxSingleStep

  // Option A (stranding-safety): an open position's payout (close OR settlement) can only be credited
  // into a note from its OWN deposit lineage, so a withdrawal must never empty or merge-away that
  // lineage. We make this SAFE rather than forbidden: a withdrawal may drain an open-position lineage
  // down to a 1-unit DUST note (kept alive to receive the later credit), and a consolidation forces the
  // open lineage to slot 0 so it survives the merge (see selectNotesForAmount). `safeMax` is the most
  // withdrawable in ONE step under those rules; `hardBlocked` gates the button above it and routes the
  // user to "Settle & Withdraw" (which clears positions, then withdraws everything).
  const openPositionDeposits = useMemo(
    () => new Set((state?.openReceipts ?? []).map((r) => r.depositIndex)),
    [state],
  )
  const balanceClearOfPositions = useMemo(() => {
    if (!address) return 0n
    return getFreeNotes(address)
      .filter((n) => !openPositionDeposits.has(n.depositIndex))
      .reduce((sum, n) => sum + n.balance, 0n)
  }, [address, openPositionDeposits, state])
  // The most withdrawable in one step without stranding: a single merge spans <= MAX_CONSOLIDATE_INPUTS
  // notes and continues exactly ONE lineage, so it can keep at most one open-position lineage alive (as
  // dust). safeMax = best of {touch no open lineage: 4 largest clear notes} and {drain one open lineage:
  // that lineage's tip + the 3 largest clear notes}. Mirrors selectNotesForAmount's selection exactly.
  const safeMax = useMemo(() => {
    if (!address) return 0n
    const free = getFreeNotes(address)
    const topNsum = (notes: Note[], k: number) =>
      notes
        .slice()
        .sort((a, b) => (a.balance > b.balance ? -1 : 1))
        .slice(0, k)
        .reduce((s, n) => s + n.balance, 0n)
    const clear = free.filter((n) => !openPositionDeposits.has(n.depositIndex))
    let best = topNsum(clear, MAX_CONSOLIDATE_INPUTS) // clear-only (no open lineage touched)
    for (const d of openPositionDeposits) {
      const dBalance = free.filter((n) => n.depositIndex === d).reduce((s, n) => s + n.balance, 0n)
      const withOpen = dBalance + topNsum(clear, MAX_CONSOLIDATE_INPUTS - 1)
      if (withOpen > best) best = withOpen
    }
    return best
  }, [address, openPositionDeposits, state])
  // Dips into an open-position lineage but is SAFE (<= safeMax): drain-to-dust handles it → show an
  // informational note (the ~$0.000001 dust kept), NOT a block.
  const dipsIntoOpenPosition =
    openPositionDeposits.size > 0 &&
    requestedAmount !== null &&
    requestedAmount > 0n &&
    requestedAmount <= cashBalance &&
    requestedAmount > balanceClearOfPositions
  // Can't be satisfied in one step without stranding (would need >=2 open lineages, or exceeds the safe
  // single-step max). Hard-block the button and route to Settle & Withdraw.
  const hardBlocked =
    requestedAmount !== null &&
    requestedAmount > 0n &&
    requestedAmount <= cashBalance &&
    requestedAmount > safeMax

  // H1: check that the vault actually holds enough USDC — it may be deployed to Polymarket.
  const { data: vaultUsdcBalance = 0n } = useReadContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: 'balanceOf',
    args: [VAULT_ADDRESS],
    query: { enabled: VAULT_ADDRESS !== '0x0000000000000000000000000000000000000000' },
  })

  const fundsDeployed =
    requestedAmount !== null &&
    requestedAmount > 0n &&
    vaultUsdcBalance < requestedAmount

  // FEE (P4): a flat USDC fee is skimmed from the payout and a minimum withdrawal is enforced
  // on-chain. Read both from the Vault so the UI matches the contract (the note still burns the
  // full requested amount; the recipient receives requested - withdrawalFeeUSDC).
  const { data: feeConfigData } = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: 'feeConfig',
    query: { enabled: VAULT_ADDRESS !== '0x0000000000000000000000000000000000000000' },
  })
  const withdrawalFeeUSDC = feeConfigData ? BigInt(feeConfigData[3]) : 0n
  const minWithdrawal = feeConfigData ? BigInt(feeConfigData[4]) : 0n
  const netReceive =
    requestedAmount !== null && requestedAmount > withdrawalFeeUSDC
      ? requestedAmount - withdrawalFeeUSDC
      : 0n

  const belowMin =
    requestedAmount !== null && requestedAmount > 0n && requestedAmount < minWithdrawal

  const invalidAmount =
    requestedAmount === null ||
    requestedAmount <= 0n ||
    requestedAmount > cashBalance ||
    belowMin

  useEffect(() => {
    log('page_view', { route: '/app/withdraw' })
  }, [])

  useEffect(() => {
    if (status !== 'success') return
    const id = window.setTimeout(() => {
      router.push('/app/portfolio')
    }, 1200)
    return () => window.clearTimeout(id)
  }, [status, router])

  const submit = async () => {
    if (!address || !cashNote || invalidAmount || fragmented || hardBlocked || requestedAmount === null) return

    setStatus('running')
    setStatusMsg('Preparing withdrawal proof...')
    setTxHash('')
    setDownloadPct(null)

    // Determinate progress for the (sometimes large) proving-key download. The first proof of a
    // session pulls the circuit artifacts; on a slow link this is the longest single step, so show
    // a real percentage instead of a generic "Generating proof…" that looks like a hang.
    const onProverProgress = (p: AssetProgress) => {
      if (p.phase === 'download' && p.total > 0) {
        const pct = Math.min(100, Math.round((p.loaded / p.total) * 100))
        setDownloadPct(pct)
        setStatusMsg(`Downloading proving key… ${pct}%`)
      } else {
        setDownloadPct(null)
        setStatusMsg('Generating proof…')
      }
    }

    try {
      // Chain-authoritative spent check: heal any locally-stale notes (already spent on-chain) before
      // selecting what to spend, so neither the merge nor the withdraw picks a spent note.
      await reconcileSpentStatus(address)
      // FC-8: a single note need not cover the amount — merge up to 4 notes first.
      let spendNote = cashNote
      if (requestedAmount > spendNote.balance) {
        const sel = selectNotesForAmount(address, requestedAmount, {
          openPositionDeposits,
          preferredSlot0DepositIndex: spendNote.depositIndex,
        })
        if (!sel.ok) throw new Error(sel.error)
        setStatusMsg('Step 1 of 2: merging notes…')
        spendNote = await consolidateNotes({
          wallet: address,
          signMessageAsync,
          notes: sel.selection.notes,
          onProgress: setStatusMsg,
          onDownloadProgress: onProverProgress,
        })
        setDownloadPct(null)
      }

      const recipient = address
      const recipientField = `0x${BigInt(recipient).toString(16).padStart(64, '0')}` as `0x${string}`
      const recipientHash = computeRecipientHash(recipient)

      const secret = await getNoteSecret(signMessageAsync, address, spendNote.depositIndex, spendNote.derivationVersion ?? 1)
      setStatusMsg('Fetching Merkle path...')
      let merkle
      try {
        merkle = await fetchMerklePath(spendNote.commitment, {
          // After a note-merge the merged leaf was just inserted on-chain; the backend index needs a
          // few seconds to ingest it. Poll with a clear message instead of hanging or erroring out.
          onWait: (n) => setStatusMsg(`Waiting for the network to index your note… (${n})`),
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/not found|not yet indexed/i.test(msg)) {
          throw new Error('Your note isn’t in the chain tree yet. If you just merged notes, wait a few seconds and retry; if the chain was reset, refresh and deposit again.')
        }
        throw e
      }

      // Drain-to-dust (Option A): a FULL drain of a tip whose lineage still holds an OPEN POSITION
      // would strand that position's payout (the withdrawal circuit forces new_commitment=0 on a full
      // drain, leaving no note to credit into). Leave 1 micro-USDC behind instead, so the lineage stays
      // alive to receive the later settlement/close credit. `hardBlocked` already guarantees
      // balance-1 >= minWithdrawal, so the Vault never reverts BelowMinimum on the reduced amount.
      const lineageHasOpenPosition = openPositionDeposits.has(spendNote.depositIndex)
      const wouldFullyDrain = requestedAmount >= spendNote.balance
      const effectiveWithdrawal =
        lineageHasOpenPosition && wouldFullyDrain && spendNote.balance > 1n
          ? spendNote.balance - 1n
          : requestedAmount
      const remainingBalance = spendNote.balance - effectiveWithdrawal
      const nextNonce = spendNote.nonce + 1n
      const newCommitment =
        remainingBalance > 0n
          ? computeCommitment(secret, remainingBalance, nextNonce, address)
          : ZERO_COMMITMENT

      setStatusMsg('Generating proof...')
      const { proof } = await generateProofInWorker({
        type: 'withdrawal',
        inputs: {
          secret,
          final_balance: spendNote.balance,
          nonce: spendNote.nonce,
          merkle_path: merkle.path,
          merkle_path_indices: merkle.pathIndices,
          owner_address: address,
          recipient_address: recipientField,
          merkle_root: merkle.root,
          nullifier: spendNote.nullifier,
          withdrawal_amount: effectiveWithdrawal,
          recipient_hash: recipientHash,
          new_commitment: newCommitment,
        },
      }, onProverProgress)
      setDownloadPct(null)

      const inputs: RelayWithdrawalInputs = {
        merkle_root: merkle.root,
        nullifier: spendNote.nullifier,
        withdrawal_amount: effectiveWithdrawal.toString(),
        recipient_hash: recipientHash,
        new_commitment: newCommitment,
      }

      log('withdraw_relay_start', {
        ...proofSummary(proof),
        inputs: { ...inputs },
        recipient,
        amount_usdc: effectiveWithdrawal.toString(),
      })

      setStatusMsg('Submitting withdrawal to relay...')
      const { txHash: nextTxHash } = await relayWithdrawal(proof, inputs, recipient)
      setTxHash(nextTxHash)

      setStatusMsg('Waiting for on-chain confirmation...')
      await waitForTransactionConfirmation(nextTxHash as `0x${string}`)

      // Mark the spent note (the merged note, if we consolidated) and materialize the remainder.
      markNoteSpent(spendNote.commitment)
      recordWalletActivity({
        id: `withdrawal-${nextTxHash}`,
        wallet: address,
        kind: 'withdrawal',
        amount: effectiveWithdrawal,
        createdAt: Date.now(),
        txHash: nextTxHash,
        destination: recipient,
      })

      if (remainingBalance > 0n) {
        const nextNote: Note = {
          id: newCommitment,
          kind: 'BET_OUTPUT',
          owner_address: address,
          depositIndex: spendNote.depositIndex,
          balance: remainingBalance,
          nonce: nextNonce,
          commitment: newCommitment,
          nullifier: computeNullifier(secret, nextNonce),
          spent: false,
          createdAt: Date.now(),
          txHash: nextTxHash,
          derivationVersion: spendNote.derivationVersion ?? 1, // FC-13: inherit lineage version
        }
        addNote(nextNote)
      }

      await refresh()
      setStatus('success')
      setStatusMsg('Withdrawal confirmed.')
      log('withdraw_relay_success', { txHash: nextTxHash, recipient, amount_usdc: effectiveWithdrawal.toString() })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus('error')
      setStatusMsg(message)
      setDownloadPct(null)
      log('withdraw_relay_error', { error: message, recipient: address, amountInput })
    }
  }

  return (
    <div>
      {/* WCAG 4.1.3 — announce the long proof/submit status + result to assistive tech. */}
      <LiveRegion message={status === 'idle' ? '' : statusMsg} assertive={status === 'error'} />
      <div className="row hairline-b" style={{ padding: '14px 24px', justifyContent: 'space-between' }}>
        <div className="row gap-4">
          <div className="micro">WITHDRAW</div>
          <span className="pill pill-soft" style={{ fontSize: 10 }}>WALLET DESTINATION ONLY</span>
        </div>
        <Link href="/app/portfolio" className="btn btn-sm btn-ghost" style={{ textDecoration: 'none' }}>
          Back to portfolio
        </Link>
      </div>

      {/* LAYOUT-001: center the focused form instead of hugging the left edge. */}
      <div style={{ padding: 24, maxWidth: 600, margin: '0 auto' }}>
        <div className="panel" style={{ padding: 20 }}>
          <div className="micro">AVAILABLE TO WITHDRAW</div>
          <div className="num mt-2" style={{ fontSize: 34, color: 'var(--green)' }}>
            ${formatUsdc(cashBalance)}
          </div>
          <div className="small mt-1" style={{ fontSize: 11 }}>
            Destination is fixed to your connected wallet address.
          </div>
          {!loading && cashBalance === 0n && (
            <div className="small mt-2" style={{ fontSize: 11, color: 'var(--text-3)' }}>
              No funds available. Deposit USDC first.
            </div>
          )}

          <div className="mt-4">
            <div className="micro">Amount (USDC)</div>
            <div className="row mt-2" style={{ gap: 8 }}>
              <input
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
                placeholder="0.00"
                aria-label="Withdrawal amount in USDC"
                disabled={status === 'running' || loading || !cashNote}
                style={{
                  flex: 1,
                  background: 'var(--bg-1)',
                  border: '1px solid var(--line-strong)',
                  borderRadius: 6,
                  padding: '12px 14px',
                  color: 'var(--text)',
                  fontFamily: 'var(--mono)',
                  fontSize: 15,
                }}
              />
              <button
                className="btn"
                disabled={status === 'running' || cashBalance === 0n || !cashNote}
                onClick={() => setAmountInput(formatUsdcInput(cashBalance))}
              >
                Max
              </button>
            </div>
            {amountInput.length > 0 && invalidAmount && (
              <div className="small mt-1" style={{ color: 'var(--red)', fontSize: 11 }}>
                {belowMin
                  ? `Minimum withdrawal is $${formatUsdc(minWithdrawal)}.`
                  : 'Enter an amount greater than 0 and less than or equal to your cash balance.'}
              </div>
            )}
            {!invalidAmount && fundsDeployed && (
              <div className="small mt-1" style={{ color: 'var(--amber)', fontSize: 11 }}>
                Vault funds are currently deployed to Polymarket. Check back after open markets settle.
              </div>
            )}
            {!invalidAmount && !fundsDeployed && fragmented && (
              <div className="small mt-1" style={{ color: 'var(--amber)', fontSize: 11 }}>
                Your balance is spread across more than {MAX_CONSOLIDATE_INPUTS} notes, so it can&apos;t all be
                withdrawn at once. The most you can withdraw in one step is ${formatUsdc(maxSingleStep)} —
                withdraw that first, then repeat for the rest.
              </div>
            )}
            {!invalidAmount && !fundsDeployed && !fragmented && hardBlocked && (
              <div className="small mt-1" style={{ color: 'var(--red)', fontSize: 11 }}>
                This amount can&apos;t be withdrawn in one step without permanently losing an{' '}
                <strong>open position</strong>&apos;s payout. The most you can safely withdraw now is{' '}
                <strong>${formatUsdc(safeMax)}</strong> — or use <strong>Settle &amp; Withdraw</strong>{' '}
                below to close your positions and cash out everything.
              </div>
            )}
            {!invalidAmount && !fundsDeployed && !fragmented && !hardBlocked && dipsIntoOpenPosition && (
              <div className="small mt-1" style={{ color: 'var(--text-2)', fontSize: 11 }}>
                This draws from a deposit that still holds an <strong>open position</strong>. To keep that
                payout claimable, we&apos;ll leave a fraction of a cent behind and withdraw the rest. To take
                it out in full, settle or close the position first (or use Settle &amp; Withdraw below).
              </div>
            )}
          </div>

          <div className="hairline-t mt-4" style={{ paddingTop: 12 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small">Destination</span>
              <span className="mono" style={{ fontSize: 12 }}>{address ? `${address.slice(0, 8)}...${address.slice(-6)}` : '—'}</span>
            </div>
            {/* FEE: the flat withdrawal fee is skimmed from the payout; the recipient nets the rest. */}
            <div className="row mt-2" style={{ justifyContent: 'space-between' }}>
              <span className="small">Withdrawal fee</span>
              <span className="mono" style={{ fontSize: 12 }}>${formatUsdc(withdrawalFeeUSDC)}</span>
            </div>
            <div className="row mt-2" style={{ justifyContent: 'space-between' }}>
              <span className="small">You receive</span>
              <span className="mono" style={{ fontSize: 12, color: 'var(--green)' }}>${formatUsdc(netReceive)}</span>
            </div>
          </div>

          <LowMemoryNotice />

          <button
            className="btn btn-primary mt-4"
            style={{ width: '100%', justifyContent: 'center', opacity: invalidAmount || fundsDeployed || fragmented || hardBlocked || !cashNote ? 0.5 : 1 }}
            disabled={status === 'running' || invalidAmount || fundsDeployed || fragmented || hardBlocked || !cashNote || loading}
            onClick={() => void submit()}
          >
            Confirm Withdrawal
          </button>

          {openPositionDeposits.size > 0 && (
            <button
              className="btn mt-2"
              style={{ width: '100%', justifyContent: 'center' }}
              disabled={status === 'running' || loading}
              onClick={() => setSettleWithdrawOpen(true)}
              title="Settle every resolved bet, sell every open position at market, reclaim unfilled orders, then withdraw your full balance to your wallet."
            >
              <Icon d={ICONS.settle} size={12} /> Settle &amp; Withdraw everything
            </button>
          )}

          {status !== 'idle' && (
            <div className="panel mt-4" style={{ padding: 14, borderColor: status === 'error' ? 'var(--red)' : 'var(--line)' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="small" style={{ color: status === 'error' ? 'var(--red)' : 'var(--text-1)' }}>
                  {statusMsg}
                </span>
                {status === 'running' && (
                  <span className="mono" style={{ fontSize: 11 }}>
                    {downloadPct !== null ? `${downloadPct}%` : 'processing...'}
                  </span>
                )}
                {status === 'success' && <Icon d={ICONS.check} size={14} className="text-green" />}
              </div>
              {downloadPct !== null && (
                <div
                  className="mt-2"
                  style={{ height: 4, borderRadius: 4, background: 'var(--bg-1)', overflow: 'hidden' }}
                >
                  <div
                    style={{
                      width: `${downloadPct}%`,
                      height: '100%',
                      background: 'var(--green)',
                      transition: 'width 120ms linear',
                    }}
                  />
                </div>
              )}
              {txHash && (
                <div className="mono mt-2" style={{ fontSize: 10, color: 'var(--text-2)' }}>
                  tx: {txHash.slice(0, 10)}...{txHash.slice(-8)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {address && settleWithdrawOpen && (
        <SettleWithdrawModal
          open={settleWithdrawOpen}
          address={address}
          vaultAddress={VAULT_ADDRESS}
          openCount={state?.openReceipts.length ?? 0}
          readyCount={state?.readyToSettle.length ?? 0}
          onClose={() => setSettleWithdrawOpen(false)}
          onComplete={refresh}
        />
      )}
    </div>
  )
}
