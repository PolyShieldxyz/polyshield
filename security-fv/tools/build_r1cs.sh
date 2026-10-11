#!/usr/bin/env bash
# Compile every PolyShield circuit with circom into build/ :
#   build/r1cs/O0/<c>.{r1cs,sym}        un-simplified constraint system (what the SMT proofs analyse)
#   build/r1cs/live/<c>.{r1cs,sym}      the 3 circuits as DEPLOYED on Polygon (legacy-live/, commit e66b43c)
#   build/wasm/{O0,O2}/<c>_js/<c>.wasm  witness calculators for the differential tests; O2 == the pipeline's default build
#   build/wasm/live_{O0,O2}/...         same for the deployed-version circuits
# Requires circom 2.1.6 (the version pinned by packages/circuits/pipeline). Override with CIRCOM=/path/to/circom.
set -euo pipefail
FV="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$FV/.." && pwd)"
CIRCOM="${CIRCOM:-circom}"
ver="$("$CIRCOM" --version | awk '{print $NF}')"
if [ "$ver" != "2.1.6" ] && [ -z "${ALLOW_CIRCOM_VERSION_MISMATCH:-}" ]; then
  echo "circom $ver found, but packages/circuits/pipeline pins 2.1.6 (constraint systems differ between compiler versions)."
  echo "  cargo install --locked --git https://github.com/iden3/circom --tag v2.1.6 circom   # then CIRCOM=<path>"
  echo "  (or set ALLOW_CIRCOM_VERSION_MISMATCH=1 to continue anyway)"; exit 2
fi
[ -d "$FV/node_modules/circomlib" ] || { echo "run 'npm install' in security-fv/ first (circomlib@2.0.5)"; exit 2; }

W="$FV/build/work"; rm -rf "$W"; mkdir -p "$W/groth16"
cp -r "$REPO/packages/circuits/groth16/." "$W/groth16/"
ln -s "$FV/node_modules" "$W/node_modules"          # lib/*.circom include ../../node_modules/circomlib/...
L="$FV/build/work_live"; rm -rf "$L"; mkdir -p "$L/groth16"
cp -r "$REPO/packages/circuits/groth16/lib" "$L/groth16/lib"; cp "$FV"/legacy-live/*.circom "$L/groth16/"
ln -s "$FV/node_modules" "$L/node_modules"

CIRCUITS="deposit bet_auth withdrawal settlement_credit bet_cancel cancel_credit position_close partial_credit consolidate"
LIVE="bet_cancel cancel_credit partial_credit"
rm -rf "$FV/build/r1cs" "$FV/build/wasm"; mkdir -p "$FV/build/r1cs/O0" "$FV/build/r1cs/live" \
  "$FV/build/wasm/O0" "$FV/build/wasm/O2" "$FV/build/wasm/live_O0" "$FV/build/wasm/live_O2"
for c in $CIRCUITS; do
  ( cd "$W/groth16"
    "$CIRCOM" $c.circom --r1cs --sym --wasm --O0 -o "$FV/build/wasm/O0" >/dev/null
    "$CIRCOM" $c.circom --r1cs --sym --wasm       -o "$FV/build/wasm/O2" >/dev/null
    cp "$FV/build/wasm/O0/$c.r1cs" "$FV/build/wasm/O0/$c.sym" "$FV/build/r1cs/O0/" )
  echo "compiled $c"
done
for c in $LIVE; do
  ( cd "$L/groth16"
    "$CIRCOM" $c.circom --r1cs --sym --wasm --O0 -o "$FV/build/wasm/live_O0" >/dev/null
    "$CIRCOM" $c.circom --r1cs --sym --wasm       -o "$FV/build/wasm/live_O2" >/dev/null
    cp "$FV/build/wasm/live_O0/$c.r1cs" "$FV/build/wasm/live_O0/$c.sym" "$FV/build/r1cs/live/" )
  echo "compiled live/$c"
done
echo "circom $ver" > "$FV/build/circom.version"
