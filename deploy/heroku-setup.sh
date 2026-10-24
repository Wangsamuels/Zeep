#!/usr/bin/env bash
# Creates one Zeep backend app on Heroku and sets every config var that can be set without
# your own accounts. Run it on YOUR computer after `heroku login`:
#
#   ./deploy/heroku-setup.sh testnet zeep-test
#   ./deploy/heroku-setup.sh mainnet zeep-main
#
# It never prints secrets. Afterwards it lists the steps and the few vars only you can fill.
# Safe to re-run: existing apps/add-ons are kept, generated secrets are not replaced.
set -euo pipefail

NET="${1:-}"; APP="${2:-}"
if [[ "$NET" != "testnet" && "$NET" != "mainnet" ]] || [[ -z "$APP" ]]; then
  echo "usage: $0 testnet|mainnet <heroku-app-name>"; exit 1
fi
command -v heroku >/dev/null || { echo "Install the Heroku CLI first: https://devcenter.heroku.com/articles/heroku-cli"; exit 1; }
command -v openssl >/dev/null || { echo "openssl is needed to generate secrets"; exit 1; }
heroku auth:whoami >/dev/null 2>&1 || { echo "Run 'heroku login' first."; exit 1; }

echo "==> App $APP ($NET)"
if ! heroku apps:info -a "$APP" >/dev/null 2>&1; then
  heroku create "$APP" --stack container
else
  heroku stack:set container -a "$APP" >/dev/null
fi

echo "==> Add-ons (own Postgres + Redis per network; never share them between apps)"
heroku addons -a "$APP" | grep -q heroku-postgresql || heroku addons:create heroku-postgresql:essential-0 -a "$APP"
heroku addons -a "$APP" | grep -q heroku-redis     || heroku addons:create heroku-redis:mini -a "$APP"

# Generate a secret only if the app doesn't have one yet (never printed).
secret() {
  if [[ -z "$(heroku config:get "$1" -a "$APP")" ]]; then
    heroku config:set "$1=$($2)" -a "$APP" >/dev/null
    echo "    generated $1"
  fi
}
echo "==> Secrets (generated here, stored only in Heroku)"
secret PAYOUT_ADDR_ENC_KEY "openssl rand -base64 32"
secret RELAY_SHARED_SECRET "openssl rand -hex 32"
secret INTERNAL_API_TOKEN  "openssl rand -hex 32"

if [[ "$NET" == "testnet" ]]; then
  ZN=test; LWD="https://testnet.zec.rocks:443"; RAILS=mock; MPP=mock; BUDGET=5; JWT_NOTE=""
else
  ZN=main; LWD="https://zec.rocks:443,https://na.zec.rocks:443,https://eu.zec.rocks:443"; RAILS=live; MPP=live; BUDGET=10; JWT_NOTE="; required on mainnet"
fi

echo "==> Config vars"
heroku config:set -a "$APP" \
  NODE_ENV=production \
  ZEEP_ENV="$NET" \
  ZCASH_NETWORK="$ZN" \
  CHAIN_BACKEND=lightclient \
  LIGHTWALLETD_URL="$LWD" \
  MIN_CONFIRMATIONS=3 \
  REQUIRE_RELAY=true \
  TREASURY_RAILS="$RAILS" \
  FLOAT_MODE=auto \
  MPP_MODE="$MPP" \
  MPP_DAILY_BUDGET_USD="$BUDGET" \
  ZEC_USD_FALLBACK=1150 \
  PRICE_REFRESH_SEC=60 \
  RESERVE_HOT_CAP_ZATS=50000000 \
  MAX_DEPOSIT_ZATS_PER_DAY=200000000 \
  SPEND_VKEY_PATH=circuits/zeep_spend_vkey.json \
  SPEND_VKEY_SHA256=bb3be7be84f4ab9dbb9700c1d796dd090a72e35bc42d67eaec457d9035231d0c \
  SPEND_ZKEY_SHA256=0ee27fd3e4e5b3ac609ae4f382fa02ee7ba7a9b0b9fb2411096b23705da4b98f \
  >/dev/null
echo "    done"

WEB_URL="$(heroku info -a "$APP" -s | sed -n 's/^web_url=//p')"
WEB_URL="${WEB_URL%/}"

echo
echo "==> Next steps for $APP   (Heroku URL: ${WEB_URL:-see the Heroku dashboard})"
echo
echo " 1. Cloudflare relay (docs/DEPLOY.md §5). In deploy/cloudflare-worker/wrangler.toml set ORIGIN for $NET to"
echo "      ${WEB_URL:-<your Heroku app URL>}"
echo "    then, without printing the secret:"
echo "      heroku config:get RELAY_SHARED_SECRET -a $APP | npx wrangler secret put RELAY_SHARED_SECRET --env $NET"
echo "      npx wrangler deploy --env $NET          # prints your Worker URL"
echo
echo " 2. Fill in (heroku config:set -a $APP KEY=value):"
echo "      PUBLIC_API_BASE_URL      the Worker URL from step 1 (mainnet won't start without it)"
echo "      CORS_ALLOWED_ORIGINS     your Vercel frontend URL for $NET"
echo "      NEAR_ONECLICK_JWT        your NEAR Intents 1Click API key (live ZEC price${JWT_NOTE})"
echo "      MODAL_LLM_BASE_URL, MODAL_PROXY_TOKEN   your Modal deployment (self-hosted models)"
if [[ "$NET" == "mainnet" ]]; then
  echo "      TEMPO_PRIVATE_KEY        EVM key of the treasury wallet (gas on Base + Tempo, USDC.e float)"
  echo "      TEMPO_RPC_URL, BASE_RPC_URL   RPC endpoints for Tempo and Base"
fi
echo
echo " 3. Deploy: Heroku dashboard → $APP → Deploy → GitHub → connect Wangsamuels/Zeep → Deploy branch main"
echo "    (or: heroku git:remote -a $APP && git push heroku main). The release phase migrates and stamps the database as $NET."
echo
echo " 4. Create the reserve wallet (prints the 24 words once; write them down offline):"
echo "      heroku run -a $APP --type=wallet --size=standard-2x -- /app/bin/zeep-wallet init"
echo "    and set the four lines it prints:"
echo "      heroku config:set -a $APP ZEEP_WALLET_SEED=\"<24 words>\" ZEEP_WALLET_BIRTHDAY_HEIGHT=<n> ZEEP_RECEIVE_UA=<u...> ZEEP_RESERVE_TADDR=<t...>"
echo
echo " 5. Start the processes:"
echo "      heroku ps:scale -a $APP web=1 treasury=1 wallet=1:standard-2x watcher=0 payouts=0"
echo
echo " 6. Check (docs/DEPLOY.md §9): <Worker URL>/v1/status shows network $NET and a moving block_height."
