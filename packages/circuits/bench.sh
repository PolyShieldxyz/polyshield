#!/usr/bin/env bash
# ZK Proof Benchmark: UltraPLONK vs UltraHonk
# All 5 Polyshield circuits, N=5 runs each, averages computed.
# Usage: cd packages/circuits && bash bench.sh

set -e

CIRCUITS_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$CIRCUITS_DIR/target"
OUT="$CIRCUITS_DIR/bench_out"
N=5

mkdir -p "$OUT"

CIRCUITS=(bet_auth settlement_credit withdrawal bet_cancel cancel_credit)

# ─── timing helper ──────────────────────────────────────────────────────────
# Returns elapsed milliseconds for a command
time_ms() {
  python3 -c "
import subprocess, time, sys
start = time.time()
subprocess.run(sys.argv[1:], stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
print(int((time.time() - start) * 1000))
" "$@"
}

# ─── stats helper ────────────────────────────────────────────────────────────
# Reads N space-separated values from stdin and prints avg stddev
stats() {
  python3 -c "
import sys, math
vals = list(map(float, sys.stdin.read().split()))
n = len(vals)
avg = sum(vals)/n
var = sum((x-avg)**2 for x in vals)/n
print(f'{avg:.0f} {math.sqrt(var):.0f}')
"
}

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  Polyshield ZK Benchmark — bb $(/Users/aria/.bb/bb --version 2>&1 || echo 0.61.0)"
echo "  nargo $( nargo --version | head -1 | awk '{print $4}')"
echo "  N=$N runs per circuit × backend"
echo "═══════════════════════════════════════════════════════════════════════"
printf "\n"

# Header
printf "%-22s  %-12s  %-12s  %-12s  %-12s  %-12s\n" \
  "Circuit" "PLONK time(ms)" "PLONK ±" "Honk time(ms)" "Honk ±" "PLONK size(B)"
printf "%s\n" "──────────────────────────────────────────────────────────────────────────────────────────────────────"

declare -A PLONK_AVG PLONK_STD HONK_AVG HONK_STD PLONK_SIZE HONK_SIZE

for CIRCUIT in "${CIRCUITS[@]}"; do
  BYTECODE="$TARGET/${CIRCUIT}.json"
  WITNESS="$TARGET/${CIRCUIT}.gz"

  # ── UltraPLONK ─────────────────────────────────────────────────────────
  PLONK_TIMES=""
  for i in $(seq 1 $N); do
    PROOF_OUT="$OUT/${CIRCUIT}_plonk_${i}.proof"
    T=$(time_ms bb prove -b "$BYTECODE" -w "$WITNESS" -o "$PROOF_OUT")
    PLONK_TIMES="$PLONK_TIMES $T"
  done

  read PLONK_A PLONK_S <<< "$(echo $PLONK_TIMES | stats)"
  PLONK_AVG[$CIRCUIT]=$PLONK_A
  PLONK_STD[$CIRCUIT]=$PLONK_S
  # Proof size from last run
  PLONK_SIZE[$CIRCUIT]=$(wc -c < "$OUT/${CIRCUIT}_plonk_${N}.proof")

  # ── UltraHonk ──────────────────────────────────────────────────────────
  HONK_TIMES=""
  for i in $(seq 1 $N); do
    PROOF_OUT="$OUT/${CIRCUIT}_honk_${i}.proof"
    T=$(time_ms bb prove_ultra_keccak_honk -b "$BYTECODE" -w "$WITNESS" -o "$PROOF_OUT")
    HONK_TIMES="$HONK_TIMES $T"
  done

  read HONK_A HONK_S <<< "$(echo $HONK_TIMES | stats)"
  HONK_AVG[$CIRCUIT]=$HONK_A
  HONK_STD[$CIRCUIT]=$HONK_S
  HONK_SIZE[$CIRCUIT]=$(wc -c < "$OUT/${CIRCUIT}_honk_${N}.proof")

  printf "%-22s  %-12s  %-12s  %-12s  %-12s  %-12s\n" \
    "$CIRCUIT" \
    "${PLONK_AVG[$CIRCUIT]}" "${PLONK_STD[$CIRCUIT]}" \
    "${HONK_AVG[$CIRCUIT]}" "${HONK_STD[$CIRCUIT]}" \
    "${PLONK_SIZE[$CIRCUIT]}"
done

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  Generating UltraHonk verifier keys + Solidity contracts..."
echo "═══════════════════════════════════════════════════════════════════════"

for CIRCUIT in "${CIRCUITS[@]}"; do
  BYTECODE="$TARGET/${CIRCUIT}.json"
  VK_OUT="$OUT/${CIRCUIT}_honk.vk"
  SOL_OUT="$OUT/${CIRCUIT}_HonkVerifier.sol"

  echo -n "  $CIRCUIT ... vk "
  bb write_vk_ultra_keccak_honk -b "$BYTECODE" -o "$VK_OUT" 2>/dev/null && echo -n "ok  contract "
  bb contract_ultra_honk -k "$VK_OUT" -o "$SOL_OUT" 2>/dev/null && echo "ok" || echo "FAILED"
done

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  RESULTS SUMMARY"
echo "═══════════════════════════════════════════════════════════════════════"
printf "\n"
printf "  N=%d runs. All times in milliseconds. Proof sizes in bytes.\n" $N
printf "\n"
printf "  %-22s  %10s  %10s  %10s  %10s  %10s  %10s\n" \
  "Circuit" "PLONK avg" "PLONK ±" "Honk avg" "Honk ±" "PLONK sz" "Honk sz"
printf "  %s\n" "─────────────────────────────────────────────────────────────────────────────────────────────────"
for CIRCUIT in "${CIRCUITS[@]}"; do
  printf "  %-22s  %10s  %10s  %10s  %10s  %10s  %10s\n" \
    "$CIRCUIT" \
    "${PLONK_AVG[$CIRCUIT]}" "${PLONK_STD[$CIRCUIT]}" \
    "${HONK_AVG[$CIRCUIT]}" "${HONK_STD[$CIRCUIT]}" \
    "${PLONK_SIZE[$CIRCUIT]}" "${HONK_SIZE[$CIRCUIT]}"
done
printf "\n"
echo "  Notes:"
echo "  - UltraPLONK (bb prove): universal SRS, requires trusted setup"
echo "  - UltraHonk (bb prove_ultra_honk): transparent, no trusted setup"
echo "  - Groth16: NOT available in bb 0.61.0"
echo "  - On-chain verification: see packages/contracts/test/ZkGasBench.t.sol"
echo ""
echo "═══════════════════════════════════════════════════════════════════════"
