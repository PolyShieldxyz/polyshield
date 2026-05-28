#!/usr/bin/env bash
# Regenerate all 5 Solidity verifier contracts from compiled circuit artifacts.
# Run after any circuit source change: pnpm circuits:verifiers
# Requires bb at ~/.bb/bb (barretenberg CLI, matching the nargo version).
set -euo pipefail

BB=~/.bb/bb
CIRCUITS_DIR="$(cd "$(dirname "$0")" && pwd)"
VERIFIERS_DIR="$CIRCUITS_DIR/../contracts/src/verifiers"

declare -A MAP=(
  [bet_auth]=BetAuth
  [withdrawal]=Withdrawal
  [settlement_credit]=SettlementCredit
  [bet_cancel]=BetCancel
  [cancel_credit]=CancelCredit
)

cd "$CIRCUITS_DIR"

for circuit in bet_auth withdrawal settlement_credit bet_cancel cancel_credit; do
  name="${MAP[$circuit]}"
  echo "[$circuit] writing VK..."
  "$BB" write_vk -b "./target/${circuit}.json" -o "./target/${circuit}_vk" --oracle_hash keccak

  echo "[$circuit] generating ${name}Verifier.sol..."
  "$BB" contract -k "./target/${circuit}_vk" -o "./target/${name}Verifier.sol" --oracle_hash keccak

  # Rename generic UltraVerifier contract to the expected name
  sed -i '' \
    "s/BaseUltraVerifier/Base${name}Verifier/g; s/UltraVerifier/${name}Verifier/g" \
    "./target/${name}Verifier.sol"

  cp "./target/${name}Verifier.sol" "$VERIFIERS_DIR/${name}Verifier.sol"
  echo "[$circuit] → $VERIFIERS_DIR/${name}Verifier.sol"
done

echo "Done. Run: cd packages/contracts && forge build"
