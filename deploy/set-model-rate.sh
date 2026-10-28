#!/usr/bin/env bash
# Change one model's per-million-token rates in MODELS_JSON without retyping the whole list.
#
#   bash ./deploy/set-model-rate.sh zeep-test deepseek/deepseek-v4-pro-0813 0.66 1.98
#
# Reads MODELS_JSON from Heroku, changes only that model's in_usd_per_m / out_usd_per_m, shows
# the change and asks before setting it (one release).
set -euo pipefail
APP="${1:?usage: $0 <app> <model-id> <in-usd-per-million> <out-usd-per-million>}"
MODEL="${2:?model id}"; IN="${3:?input rate}"; OUT="${4:?output rate}"
command -v heroku >/dev/null || { echo "Install the Heroku CLI first."; exit 1; }
command -v node >/dev/null || { echo "Node.js is needed."; exit 1; }

CURRENT="$(heroku config:get MODELS_JSON -a "$APP")"
[[ -n "$CURRENT" ]] || { echo "MODELS_JSON is not set on $APP."; exit 1; }
UPDATED="$(CURRENT="$CURRENT" MODEL="$MODEL" IN="$IN" OUT="$OUT" node -e '
  const list = JSON.parse(process.env.CURRENT);
  const m = list.find((x) => x.id === process.env.MODEL);
  if (!m) { console.error("No model " + process.env.MODEL + " in MODELS_JSON"); process.exit(1); }
  const inR = Number(process.env.IN), outR = Number(process.env.OUT);
  if (!(inR > 0 && outR > 0)) { console.error("Rates must be positive numbers"); process.exit(1); }
  console.error(m.id + ": input " + m.in_usd_per_m + " -> " + inR + ", output " + m.out_usd_per_m + " -> " + outR + " (USD per million tokens)");
  m.in_usd_per_m = inR; m.out_usd_per_m = outR;
  process.stdout.write(JSON.stringify(list));
')"
read -r -p "Set this on $APP? (y/N) " OK
[[ "$OK" == "y" || "$OK" == "Y" ]] || { echo "Cancelled."; exit 1; }
heroku config:set -a "$APP" MODELS_JSON="$UPDATED" >/dev/null
echo "Done. Model prices update within a minute."
