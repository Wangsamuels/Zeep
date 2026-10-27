#!/usr/bin/env bash
# Sets every mainnet config var in ONE release (the release step refuses partial mainnet config).
# It asks for each value, so nothing has to be quoted or pasted into a long command.
#   bash ./deploy/set-mainnet-config.sh zeep-test
set -euo pipefail
APP="${1:-zeep-test}"
cd "$(dirname "$0")/.."
[[ -f deploy/models-mainnet.json ]] || { echo "deploy/models-mainnet.json is missing"; exit 1; }

clean() { printf '%s' "$1" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["“”]//' -e 's/["“”]$//'; }

read -r -p "Mainnet Worker URL (https://zeep-relay-mainnet....workers.dev): " URL; URL="$(clean "$URL")"; URL="${URL%/}"
read -r -p "ZEEP_WALLET_BIRTHDAY_HEIGHT (number): " BH; BH="$(clean "$BH")"
read -r -p "ZEEP_RECEIVE_UA (starts u1): " UA; UA="$(clean "$UA")"
read -r -p "ZEEP_RESERVE_TADDR (starts t1): " TADDR; TADDR="$(clean "$TADDR")"
read -r -s -p "ZEEP_WALLET_SEED (24 words, hidden): " SEED; echo; SEED="$(clean "$SEED" | tr -s ' ')"

# Catch mistakes before Heroku does.
[[ "$URL" == https://* ]] || { echo "The Worker URL must start with https://"; exit 1; }
[[ "$URL" != *testnet* ]] || { echo "That is the testnet Worker; deploy the mainnet one (step 2)"; exit 1; }
[[ "$BH" =~ ^[0-9]+$ ]] || { echo "The birthday height must be a number"; exit 1; }
[[ "$UA" == u1* ]] || { echo "ZEEP_RECEIVE_UA must start with u1 (utest1 is a testnet wallet)"; exit 1; }
[[ "$TADDR" == t1* ]] || { echo "ZEEP_RESERVE_TADDR must start with t1 (tm is a testnet wallet)"; exit 1; }
[[ "$(wc -w <<<"$SEED" | tr -d ' ')" == 24 ]] || { echo "The seed must be exactly 24 words"; exit 1; }

echo "==> Setting mainnet config on $APP (one release)"
heroku config:set -a "$APP" \
  ZEEP_ENV=mainnet \
  ZCASH_NETWORK=main \
  "LIGHTWALLETD_URL=https://zec.rocks:443,https://na.zec.rocks:443,https://eu.zec.rocks:443" \
  TREASURY_RAILS=live \
  MPP_MODE=live \
  INBOX_PROVIDER=agentmail \
  "MODELS_JSON=$(cat deploy/models-mainnet.json)" \
  DEFAULT_MODEL=anthropic/claude-sonnet-5.5 \
  "PUBLIC_API_BASE_URL=$URL" \
  MPP_SESSION_MAX_USD=1 \
  MPP_DAILY_BUDGET_USD=5 \
  "ZEEP_WALLET_BIRTHDAY_HEIGHT=$BH" \
  "ZEEP_RECEIVE_UA=$UA" \
  "ZEEP_RESERVE_TADDR=$TADDR" \
  "ZEEP_WALLET_SEED=$SEED" >/dev/null
echo "    sent. Waiting for the release step..."
sleep 45
heroku releases -a "$APP" -n 1
echo
echo "If the line above says 'release command failed', run: heroku releases:output -a $APP"
