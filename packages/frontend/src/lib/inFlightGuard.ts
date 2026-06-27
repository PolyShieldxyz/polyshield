/**
 * Shared "money operation in flight" flag.
 *
 * A deposit or withdrawal runs a multi-step money flow: derive key → generate proof → approve →
 * submit → wait for confirmation → persist the note locally. The USDC leaves the wallet (deposit) or
 * the note is spent on-chain (withdraw) well BEFORE the local note-cache update runs. If the wallet
 * flaps (mobile/WalletConnect sessions drop routinely) or the user switches accounts mid-flow,
 * WalletConnect's connected→disconnected handler would otherwise run the destructive
 * resetAllLocalState() wipe — destroying the deposit-index counter / encrypted note cache while the
 * note that depends on them is still in flight → silent fund loss (C3) and re-derivation of a spent
 * nullifier → locked funds (H7).
 *
 * The deposit and withdraw pages set this flag while a money op is running and clear it on
 * completion/abort. WalletConnect reads it and SKIPS the destructive wipe while a money op is in
 * flight (the encrypted cache + index counter must survive the flap). The flag lives in sessionStorage
 * so it's robust across a full page reload during the flow (a fresh tab reload re-mounts every
 * component) but is naturally scoped to the tab/session and cleared when the tab closes.
 */

const KEY = 'polyshield:money_op_in_flight'

export function setMoneyOpInFlight(): void {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    /* private mode / quota — non-fatal; the beforeunload guards still protect the active tab */
  }
}

export function clearMoneyOpInFlight(): void {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* non-fatal */
  }
}

export function isMoneyOpInFlight(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return sessionStorage.getItem(KEY) != null
  } catch {
    return false
  }
}
