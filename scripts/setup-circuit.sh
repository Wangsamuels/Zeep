#!/usr/bin/env bash
# Compile the Zeep spend circuit and run the Groth16 setup.
#   PTAU=/path/to/powersOfTau28_hez_final_14.ptau ./scripts/setup-circuit.sh
# Without PTAU a throwaway local "powers of tau" is generated: fine for dev and tests,
# NOT for production. For mainnet use the public Hermez/PSE ptau (phase 1) and run a
# phase-2 ceremony with several independent contributors (see README).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=circuits
mkdir -p "$OUT"
npx circom2 circuits-src/zeep_spend.circom --r1cs --wasm --O2 -o "$OUT" >/dev/null
cp "$OUT/zeep_spend_js/zeep_spend.wasm" "$OUT/zeep_spend.wasm"

if [ -z "${PTAU:-}" ]; then
  echo "!! No PTAU given: generating an insecure dev powers-of-tau (2^14)" >&2
  PTAU="$OUT/dev_pot14.ptau"
  if [ ! -f "$PTAU" ]; then
    npx snarkjs powersoftau new bn128 14 "$OUT/pot_0.ptau" >/dev/null
    npx snarkjs powersoftau contribute "$OUT/pot_0.ptau" "$OUT/pot_1.ptau" --name=dev -e="$(openssl rand -hex 32)" >/dev/null
    npx snarkjs powersoftau prepare phase2 "$OUT/pot_1.ptau" "$PTAU" >/dev/null
    rm -f "$OUT/pot_0.ptau" "$OUT/pot_1.ptau"
  fi
fi

npx snarkjs groth16 setup "$OUT/zeep_spend.r1cs" "$PTAU" "$OUT/zeep_spend_0.zkey" >/dev/null
npx snarkjs zkey contribute "$OUT/zeep_spend_0.zkey" "$OUT/zeep_spend.zkey" --name=zeep-dev -e="$(openssl rand -hex 32)" >/dev/null
rm -f "$OUT/zeep_spend_0.zkey"
npx snarkjs zkey export verificationkey "$OUT/zeep_spend.zkey" "$OUT/zeep_spend_vkey.json" >/dev/null
for f in zeep_spend.wasm zeep_spend.zkey zeep_spend_vkey.json; do
  printf '%s  %s\n' "$(sha256sum "$OUT/$f" | cut -d' ' -f1)" "$f"
done
echo "Serve zeep_spend.wasm + zeep_spend.zkey from Vercel /circuits/, zeep_spend_vkey.json at ZEEP_VKEY_URL; pin the hashes."
