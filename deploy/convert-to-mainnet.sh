#!/usr/bin/env bash
# Turns an existing TESTNET Zeep app on Heroku into a MAINNET app, same app and same add-on
# plans, so you don't pay for a second set. Run it on YOUR computer after `heroku login`:
#
#   ./deploy/convert-to-mainnet.sh zeep-test
#
# What it does (it asks before anything destructive):
#   1. maintenance on, all processes stopped
#   2. ERASES the testnet database and replaces the Redis add-on (every process refuses a
#      database or Redis that belongs to another network, by design)
#   3. new secrets (never printed), testnet-only vars removed, mainnet vars set
#   4. prints the remaining steps: relay, your keys, reserve wallet, deploy, start
#
# Testnet balances and history are gone afterwards. Testnet ZEC has no value, so that is fine.
set -euo pipefail

APP="${1:-}"
[[ -n "$APP" ]] || { echo "usage: $0 <heroku-app-name>"; exit 1; }
command -v heroku >/dev/null || { echo "Install the Heroku CLI first."; exit 1; }
command -v openssl >/dev/null || { echo "openssl is needed to generate secrets"; exit 1; }
heroku auth:whoami >/dev/null 2>&1 || { echo "Run 'heroku login' first."; exit 1; }

CUR="$(heroku config:get ZEEP_ENV -a "$APP")"
if [[ "$CUR" == "mainnet" ]]; then echo "$APP is already mainnet; nothing to convert."; exit 0; fi
echo "This ERASES all testnet data of $APP (database + Redis) and switches it to MAINNET."
read -r -p "Type the app name to continue: " CONFIRM
[[ "$CONFIRM" == "$APP" ]] || { echo "Cancelled."; exit 1; }

echo "==> Maintenance on, processes stopped"
heroku maintenance:on -a "$APP"
heroku ps:scale web=0 treasury=0 wallet=0 -a "$APP" >/dev/null

echo "==> Erasing the testnet database (same add-on, empty)"
heroku pg:reset DATABASE_URL -a "$APP" --confirm "$APP"

echo "==> Replacing Redis (a fresh, empty instance)"
heroku addons:destroy REDIS -a "$APP" --confirm "$APP"
heroku addons:create heroku-redis:mini -a "$APP" --wait

echo "==> New secrets (stored only in Heroku, never printed)"
heroku config:set -a "$APP" \
  PAYOUT_ADDR_ENC_KEY="$(openssl rand -base64 32)" \
  RELAY_SHARED_SECRET="$(openssl rand -hex 32)" \
  INTERNAL_API_TOKEN="$(openssl rand -hex 32)" >/dev/null
echo "    done"

echo "==> Removing testnet-only settings (the old testnet wallet included)"
heroku config:unset -a "$APP" \
  ZEEP_WALLET_SEED ZEEP_WALLET_BIRTHDAY_HEIGHT ZEEP_RECEIVE_UA ZEEP_RESERVE_TADDR TREASURY_REFUND_TO \
  TESTNET_LIVE_MPP TESTNET_MAX_DEPOSIT_ZATS_PER_DAY ALLOW_PRICE_FALLBACK ALLOW_NO_RELAY PUBLIC_API_BASE_URL >/dev/null 2>&1 || true
echo "    done"

echo "==> Mainnet settings"
heroku config:set -a "$APP" \
  NODE_ENV=production \
  ZEEP_ENV=mainnet \
  ZCASH_NETWORK=main \
  CHAIN_BACKEND=lightclient \
  LIGHTWALLETD_URL="https://zec.rocks:443,https://na.zec.rocks:443,https://eu.zec.rocks:443" \
  MIN_CONFIRMATIONS=3 \
  REQUIRE_RELAY=true \
  TREASURY_RAILS=live \
  FLOAT_MODE=auto \
  MPP_MODE=live \
  MPP_DAILY_BUDGET_USD=10 \
  PRICE_REFRESH_SEC=60 \
  RESERVE_HOT_CAP_ZATS=50000000 \
  MAX_DEPOSIT_ZATS_PER_DAY=200000000 \
  INBOX_PROVIDER=agentmail \
  SPEND_VKEY_PATH=circuits/zeep_spend_vkey.json \
  SPEND_VKEY_SHA256=bb3be7be84f4ab9dbb9700c1d796dd090a72e35bc42d67eaec457d9035231d0c \
  SPEND_ZKEY_SHA256=0ee27fd3e4e5b3ac609ae4f382fa02ee7ba7a9b0b9fb2411096b23705da4b98f \
  >/dev/null
echo "    done"

WEB_URL="$(heroku info -a "$APP" -s | sed -n 's/^web_url=//p')"; WEB_URL="${WEB_URL%/}"
cat <<EOF

==> $APP is now configured for MAINNET (still in maintenance, nothing running).
    Follow docs/MAINNET_CONVERSION.md from step 2:
      2. relay:   deploy the mainnet Worker (ORIGIN = $WEB_URL), delete the testnet one
      3. keys:    set your own vars (one heroku config:set)
      4. wallet:  heroku run -a $APP --type=wallet -- /app/bin/zeep-wallet init
      5. deploy:  push to GitHub / Deploy Branch (release migrates and stamps the DB as mainnet)
      6. start:   heroku ps:scale -a $APP web=1 treasury=1 wallet=1 && heroku maintenance:off -a $APP
      7. Vercel:  switch the frontend to mainnet and redeploy
EOF
