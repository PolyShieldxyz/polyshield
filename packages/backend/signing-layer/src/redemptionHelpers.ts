export function computePayoutPerShare(numerators: bigint[], denominator: bigint): number {
  const maxNumerator = numerators.reduce((a, b) => (b > a ? b : a), 0n);
  return Number((maxNumerator * 1_000_000n) / denominator);
}
