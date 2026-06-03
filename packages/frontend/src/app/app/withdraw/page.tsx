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
  deriveSecret,
  formatUsdc,
  markNoteSpent,
  recordWalletActivity,
  selectNotesForAmount,
  type Note,
} from '@/lib/notes'
import { consolidateNotes } from '@/lib/consolidate'
import { usePortfolioState } from '@/lib/accountState'
import {
  fetchMerklePath,
  relayWithdrawal,
  waitForTransactionConfirmation,
  type RelayWithdrawalInputs,
} from '@/lib/api'
import { USDC_ABI } from '@/lib/vaultAbi'

const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`
const USDC_ADDRESS  = (process.env.NEXT_PUBLIC_USDC_ADDRESS  ?? '0x0000000000000000000000000000000000000000') as `0x${string}`
import { generateProofInWorker } from '@/lib/prover'
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

  const cashNote = state?.cashNote ?? null
  const cashBalance = state?.cashBalance ?? 0n
  const requestedAmount = useMemo(() => parseUsdcToMicro(amountInput), [amountInput])

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

  const invalidAmount =
    requestedAmount === null ||
    requestedAmount <= 0n ||
    requestedAmount > cashBalance

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
    if (!address || !cashNote || invalidAmount || requestedAmount === null) return

    setStatus('running')
    setStatusMsg('Preparing withdrawal proof...')
    setTxHash('')

    try {
      // FC-8: a single note need not cover the amount — merge up to 4 notes first.
      let spendNote = cashNote
      if (requestedAmount > spendNote.balance) {
        const sel = selectNotesForAmount(address, requestedAmount)
        if (!sel.ok) throw new Error(sel.error)
        setStatusMsg('Step 1 of 2: merging notes…')
        spendNote = await consolidateNotes({
          wallet: address,
          signMessageAsync,
          notes: sel.selection.notes,
          onProgress: setStatusMsg,
        })
      }

      const recipient = address
      const recipientField = `0x${BigInt(recipient).toString(16).padStart(64, '0')}` as `0x${string}`
      const recipientHash = computeRecipientHash(recipient)

      const secret = await deriveSecret(signMessageAsync, address, spendNote.depositIndex)
      setStatusMsg('Fetching Merkle path...')
      let merkle
      try {
        merkle = await fetchMerklePath(spendNote.commitment)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('not found')) {
          throw new Error('Your note is not in the current chain tree. The chain may have been reset — please refresh the page and deposit again.')
        }
        throw e
      }

      const remainingBalance = spendNote.balance - requestedAmount
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
          withdrawal_amount: requestedAmount,
          recipient_hash: recipientHash,
          new_commitment: newCommitment,
        },
      })

      const inputs: RelayWithdrawalInputs = {
        merkle_root: merkle.root,
        nullifier: spendNote.nullifier,
        withdrawal_amount: requestedAmount.toString(),
        recipient_hash: recipientHash,
        new_commitment: newCommitment,
      }

      log('withdraw_relay_start', {
        ...proofSummary(proof),
        inputs: { ...inputs },
        recipient,
        amount_usdc: requestedAmount.toString(),
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
        amount: requestedAmount,
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
        }
        addNote(nextNote)
      }

      await refresh()
      setStatus('success')
      setStatusMsg('Withdrawal confirmed.')
      log('withdraw_relay_success', { txHash: nextTxHash, recipient, amount_usdc: requestedAmount.toString() })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus('error')
      setStatusMsg(message)
      log('withdraw_relay_error', { error: message, recipient: address, amountInput })
    }
  }

  return (
    <div>
      <div className="row hairline-b" style={{ padding: '14px 24px', justifyContent: 'space-between' }}>
        <div className="row gap-4">
          <div className="micro">WITHDRAW</div>
          <span className="pill pill-soft" style={{ fontSize: 10 }}>WALLET DESTINATION ONLY</span>
        </div>
        <Link href="/app/portfolio" className="btn btn-sm btn-ghost" style={{ textDecoration: 'none' }}>
          Back to portfolio
        </Link>
      </div>

      <div style={{ padding: 24, maxWidth: 740 }}>
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
                Enter an amount greater than 0 and less than or equal to your cash balance.
              </div>
            )}
            {!invalidAmount && fundsDeployed && (
              <div className="small mt-1" style={{ color: 'var(--yellow, #f0a500)', fontSize: 11 }}>
                Vault funds are currently deployed to Polymarket. Check back after open markets settle.
              </div>
            )}
          </div>

          <div className="hairline-t mt-4" style={{ paddingTop: 12 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small">Destination</span>
              <span className="mono" style={{ fontSize: 12 }}>{address ? `${address.slice(0, 8)}...${address.slice(-6)}` : '—'}</span>
            </div>
          </div>

          <button
            className="btn btn-primary mt-4"
            style={{ width: '100%', justifyContent: 'center', opacity: invalidAmount || fundsDeployed || !cashNote ? 0.5 : 1 }}
            disabled={status === 'running' || invalidAmount || fundsDeployed || !cashNote || loading}
            onClick={() => void submit()}
          >
            Confirm Withdrawal
          </button>

          {status !== 'idle' && (
            <div className="panel mt-4" style={{ padding: 14, borderColor: status === 'error' ? 'var(--red)' : 'var(--line)' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="small" style={{ color: status === 'error' ? 'var(--red)' : 'var(--text-1)' }}>
                  {statusMsg}
                </span>
                {status === 'running' && <span className="mono" style={{ fontSize: 11 }}>processing...</span>}
                {status === 'success' && <Icon d={ICONS.check} size={14} className="text-green" />}
              </div>
              {txHash && (
                <div className="mono mt-2" style={{ fontSize: 10, color: 'var(--text-2)' }}>
                  tx: {txHash.slice(0, 10)}...{txHash.slice(-8)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
