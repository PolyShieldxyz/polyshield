/**
 * User-facing order-type model.
 *
 * Polyshield's bet UI exposes the same two order types Polymarket's own UI does — Market and
 * Limit — rather than the four CLOB primitives (FOK/FAK/GTC/GTD). The mapping to those primitives
 * is purely a signing-layer concern; order type never reaches the chain (circuits, Vault, and
 * proof-relay are order-type-agnostic).
 *
 *   Market order → FAK (fill-and-kill): sweeps what the book offers now at a committed price
 *                  ceiling; any unfilled remainder is refunded via the L3 partial-fill-credit path.
 *                  Registered as NO intent — the signing layer's default route submits FAK.
 *   Limit order  → GTC, or GTD when the user sets an optional expiry. Rests at the user's price.
 *
 * See docs/future-changes.md FC-4 and lib/pricing.ts.
 */
export type OrderKind = 'MARKET' | 'LIMIT'

export const ORDER_KIND_LABEL: Record<OrderKind, string> = {
  MARKET: 'Market order',
  LIMIT: 'Limit order',
}
