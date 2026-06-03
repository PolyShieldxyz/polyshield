/**
 * ZK prover Web Worker.
 *
 * Runs exactly one proof per worker lifetime, then the caller terminates it.
 * Termination releases the snarkjs WASM heap back to the OS, preventing idle
 * memory accumulation that occurs when the WASM lives on the main thread or in
 * a long-lived worker.
 *
 * Message protocol:
 *   in:  { type: ProofType, inputs: <type-specific inputs object> }
 *   out: { type: 'done', result: ProofResult }
 *     | { type: 'error', message: string }
 */

import type {
  BetAuthInputs,
  WithdrawalInputs,
  SettlementInputs,
  BetCancelInputs,
  CancelCreditInputs,
  DepositInputs,
  PositionCloseInputs,
  PartialCreditInputs,
  ConsolidateInputs,
  ProofResult,
} from '../lib/prover'

export type ProofType = 'bet_auth' | 'withdrawal' | 'settlement' | 'bet_cancel' | 'cancel_credit' | 'deposit' | 'position_close' | 'partial_credit' | 'consolidate'

export type ProverWorkerMessage =
  | { type: 'bet_auth';     inputs: BetAuthInputs }
  | { type: 'withdrawal';   inputs: WithdrawalInputs }
  | { type: 'settlement';   inputs: SettlementInputs }
  | { type: 'bet_cancel';   inputs: BetCancelInputs }
  | { type: 'cancel_credit'; inputs: CancelCreditInputs }
  | { type: 'deposit';      inputs: DepositInputs }
  | { type: 'position_close'; inputs: PositionCloseInputs }
  | { type: 'partial_credit'; inputs: PartialCreditInputs }
  | { type: 'consolidate';  inputs: ConsolidateInputs }

export type ProverWorkerResult =
  | { type: 'done';  result: ProofResult }
  | { type: 'error'; message: string }

self.onmessage = async (event: MessageEvent<ProverWorkerMessage>) => {
  try {
    const { generateBetAuthProof, generateWithdrawalProof, generateSettlementProof, generateBetCancelProof, generateCancelCreditProof, generateDepositProof, generatePositionCloseProof, generatePartialCreditProof, generateConsolidateProof } =
      await import('../lib/prover')

    let result: ProofResult

    switch (event.data.type) {
      case 'bet_auth':
        result = await generateBetAuthProof(event.data.inputs)
        break
      case 'withdrawal':
        result = await generateWithdrawalProof(event.data.inputs)
        break
      case 'settlement':
        result = await generateSettlementProof(event.data.inputs)
        break
      case 'bet_cancel':
        result = await generateBetCancelProof(event.data.inputs)
        break
      case 'cancel_credit':
        result = await generateCancelCreditProof(event.data.inputs)
        break
      case 'deposit':
        result = await generateDepositProof(event.data.inputs)
        break
      case 'position_close':
        result = await generatePositionCloseProof(event.data.inputs)
        break
      case 'partial_credit':
        result = await generatePartialCreditProof(event.data.inputs)
        break
      case 'consolidate':
        result = await generateConsolidateProof(event.data.inputs)
        break
      default:
        throw new Error(`Unknown proof type: ${(event.data as { type: string }).type}`)
    }

    self.postMessage({ type: 'done', result } satisfies ProverWorkerResult)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    self.postMessage({ type: 'error', message } satisfies ProverWorkerResult)
  }
}
