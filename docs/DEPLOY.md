# Deploying Zeep (testnet and mainnet)

Everything runs on hosted services. There's **no VPS**:

- **Heroku:** the backend, including the Zcash light-client wallet.
- **Cloudflare Workers:** the relay (free).
- **zec.rocks:** Zcash blocks (free).
- **Vercel:** the frontend.

```
browser ──HTTPS──▶ Cloudflare Worker (relay: strips IPs, adds secret) ──▶ Heroku app
                                                                          ├─ web       (API)
                                                                          ├─ treasury  (float, prices, alerts, cleanup)
                                                                          ├─ wallet    (light client: deposits + payouts + shielding)
                                                                          ├─ Postgres  (everything durable, incl. the wallet's state)
                                                                          └─ Redis     (caches, locks, queue)
wallet dyno ──gRPC──▶ zec.rocks (failover: zec.rocks → na → eu)    in-app wallets (WebZjs) ──gRPC-web──▶ zec.rocks
```

Do **testnet first**, end to end, then the same for mainnet. Each network is its **own Heroku app with its own Postgres and Redis**. Every process refuses to run against the other network's database, Redis or Zcash server.

## 0. Accounts and tools

| Need | For |
| --- | --- |
| Heroku account + [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli), logged in with `heroku login` | backend |
| Cloudflare account + Node 20+ (`npx wrangler`) | relay (free) |
| Vercel account | frontend |
| GitHub repo `Wangsamuels/Zeep` | source |
| NEAR Intents **1Click API key (JWT)** | live ZEC price (and, on mainnet, treasury swaps) |
| **Mainnet only:** an EVM wallet key with a little gas on Base and Tempo, plus some USDC.e on Tempo | treasury float, paying MPP providers |

## 1. Create the app and its config (one command)

```bash
./deploy/heroku-setup.sh testnet zeep-test      # later: ./deploy/heroku-setup.sh mainnet zeep-main
```

The script does the following:

- creates the app on the container stack;
- adds Postgres and Redis;
- **generates the secrets inside Heroku without printing them** (`PAYOUT_ADDR_ENC_KEY`, `RELAY_SHARED_SECRET`);
- sets every config var that doesn't need your own accounts (table in §6);
- prints the remaining steps with your app's URL filled in.

It's safe to run again.

## 2. Cloudflare relay (free)

```bash
cd deploy/cloudflare-worker
# wrangler.toml: set ORIGIN for testnet/mainnet to the Heroku URL the script printed
npx wrangler login
heroku config:get RELAY_SHARED_SECRET -a zeep-test | npx wrangler secret put RELAY_SHARED_SECRET --env testnet
npx wrangler deploy --env testnet               # prints https://zeep-relay-testnet.<you>.workers.dev
```

Then `heroku config:set -a zeep-test PUBLIC_API_BASE_URL=<that Worker URL>`.

The Worker forwards only the headers Zeep needs. No visitor IP, browser type or language reaches Heroku. The free plan allows 100,000 requests/day, streamed replies and 100 MB per request.

**Header check (once per network).** This proves no visitor IP reaches Heroku's logs:

1. Run `heroku logs --tail -a zeep-test`.
2. Open `<Worker URL>/v1/status` in your browser.
3. Look up your own IP (e.g. search "what is my ip").
4. In the router log line for that request, `fwd=` must show **Cloudflare's** address, never yours.

If your IP appears, stop and use a VPS relay instead (`deploy/vps/Caddyfile`).

Also check that the Heroku URL called directly answers **403 `relay_required`**.

## 3. Fill in your own values

`heroku config:set -a zeep-test KEY=value ...`

| Var | What |
| --- | --- |
| `PUBLIC_API_BASE_URL` | the Worker URL from §2 (mainnet refuses to start without it) |
| `CORS_ALLOWED_ORIGINS` | your Vercel URL for this network |
| `NEAR_ONECLICK_JWT` | your 1Click key: live ZEC price (required on mainnet) |
| `MODAL_LLM_BASE_URL`, `MODAL_PROXY_TOKEN` | your Modal deployment (self-hosted models) |
| **Mainnet only:** `TEMPO_PRIVATE_KEY`, `TEMPO_RPC_URL`, `BASE_RPC_URL` | the treasury's EVM key and RPC endpoints |
| **Mainnet only:** `RELAY_API_KEY` | Relay.link key (Relay dashboard → Apps): bridge quotes need it since 2 Oct 2026. Not the same as `RELAY_SHARED_SECRET` (your Cloudflare relay). |
| *Optional:* `MPP_MODE=live` + `TESTNET_LIVE_MPP=true` | real AI answers on testnet, paid by you |

## 4. Deploy the code

Heroku dashboard → app → **Deploy** → GitHub → connect **Wangsamuels/Zeep** → **Deploy Branch** `main`. You can also turn on automatic deploys. (Or use `heroku git:remote -a zeep-test && git push heroku main`.)

The release phase migrates the database and stamps it with the network. The first build compiles the Rust wallet in release mode, which takes **10–20 minutes**.

## 5. Create the reserve wallet

```bash
heroku run -a zeep-test --type=wallet --size=standard-2x -- /app/bin/zeep-wallet init
```

It prints four lines, once. **Write the 24 words down offline**: anyone with them controls the reserve. Then set them:

```bash
heroku config:set -a zeep-test ZEEP_WALLET_SEED="<24 words>" ZEEP_WALLET_BIRTHDAY_HEIGHT=<n> ZEEP_RECEIVE_UA=<u...> ZEEP_RESERVE_TADDR=<t...>
```

Use a **different wallet for mainnet**: run `init` on the mainnet app. `zeep-wallet address` re-prints the public addresses for the seed that's set, if you ever need them.

Then start everything:

```bash
heroku ps:scale -a zeep-test web=1 treasury=1 wallet=1:standard-2x watcher=0 payouts=0
```

`wallet` must be exactly **one** dyno. It holds a lock, so a second one just waits.

**How the wallet survives restarts.** Its state is saved to Postgres after every change and restored when the dyno starts, so a restart resumes where it stopped. If that copy were ever lost, the wallet rebuilds itself from the seed and the chain.

## 6. Config vars reference (set by the script)

| Var | Testnet | Mainnet |
| --- | --- | --- |
| `NODE_ENV` | `production` | `production` |
| `ZEEP_ENV` / `ZCASH_NETWORK` | `testnet` / `test` | `mainnet` / `main` |
| `CHAIN_BACKEND` | `lightclient` | `lightclient` |
| `LIGHTWALLETD_URL` | `https://testnet.zec.rocks:443` | `https://zec.rocks:443,https://na.zec.rocks:443,https://eu.zec.rocks:443` (failover, in order) |
| `MIN_CONFIRMATIONS` | `3` | `3` |
| `REQUIRE_RELAY` | `true` | `true` |
| `TREASURY_RAILS` | `mock` (testnet never moves real money) | `live` |
| `FLOAT_MODE` | `auto` | `auto` |
| `MPP_MODE` / `MPP_DAILY_BUDGET_USD` | `mock` / `5` | `live` / `10` |
| `ZEC_USD_FALLBACK` | `1150` (used only before the first live price; afterwards the last live price is used automatically) | same |
| `PRICE_REFRESH_SEC` | `60` (the treasury refreshes the price every minute) | `60` |
| `RESERVE_HOT_CAP_ZATS` | `50000000` (0.5 ZEC) | `50000000` |
| `MAX_DEPOSIT_ZATS_PER_DAY` | `200000000` (2 ZEC/day) | `200000000` |
| `SPEND_VKEY_PATH` / `SPEND_VKEY_SHA256` / `SPEND_ZKEY_SHA256` | `circuits/zeep_spend_vkey.json` + the pinned hashes | same |
| `PAYOUT_ADDR_ENC_KEY`, `RELAY_SHARED_SECRET` | generated | generated (different values) |

> ⚠️ The circuit files come from a single-contributor setup: whoever ran it could forge proofs. That's acceptable for a capped hackathon deployment (see §8), **not for a real launch**. Run a multi-party ceremony first (README, "Before mainnet").

## 7. Frontend (Vercel), one project per network

Set these in Vercel (the `docs/FRONTEND_UPDATE_*.md` notes cover the frontend code). The key values:

| Var | Testnet | Mainnet |
| --- | --- | --- |
| `NEXT_PUBLIC_ZEEP_NETWORK` | `testnet` | `mainnet` |
| API base URL | testnet Worker URL | mainnet Worker URL |
| `NEXT_PUBLIC_LIGHTWALLETD_URL_TESTNET` / `_MAINNET` | testnet Worker URL + `/lwd` | mainnet Worker URL + `/lwd` |
| `NEXT_PUBLIC_OHTTP_KEY_CONFIG` | from `node dist/ohttp-config.js` | same, on the mainnet app |
| `NEXT_PUBLIC_SPEND_*` | circuit URLs + the same hashes | same |

## 8. Hot cap and hackathon safety limits

The `wallet` dyno holds the reserve seed. That makes **everything in the hot wallet only as safe as your Heroku account**, including the ZEC half of every user's deposit.

- **`RESERVE_HOT_CAP_ZATS=50000000` (0.5 ZEC, about $575 at ~$1,150/ZEC).** Above this the treasury logs an ALERT. Move the excess to a cold wallet you control; send some back if ZEC withdrawals need it.
- **`MAX_DEPOSIT_ZATS_PER_DAY=200000000` (2 ZEC/day).** Later deposits are credited the next day.
- **`MPP_DAILY_BUDGET_USD=10`** limits what paid services can spend per day.
- **Keep only a working float of USDC.e on Tempo** (e.g. $50).
- **Lock down Heroku access:** 2FA on, no other collaborators on the mainnet app. Anyone who can read its config vars can take the hot wallet.

## 9. Go-live checklist (per network)

1. `<Worker URL>/v1/status` shows `ok: true`, the right `network`, and a `block_height` that moves every couple of minutes.
2. `<Worker URL>/v1/prices` shows `zec_price_source: near-intents`.
3. The header check from §2 passes, and calling Heroku directly is refused.
4. `heroku logs -a <app> --ps wallet` shows `connected to lightwalletd`, then scanning reaching the tip.
5. Deposit a little ZEC (e.g. 0.01) from the in-app wallet. It goes *confirming → credited* as a ZEC note plus a dollar note.
6. Pay for one search and one AI reply.
7. Withdraw a little ZEC (no conversion), then more than the ZEC balance (conversion prompt, `converting`, then paid).
8. Restore the account from its 24 words in a private window; both balances should match.
9. `heroku logs -a <app> | grep ALERT` shows nothing.

## 10. When an ALERT shows up

See the operations table in the README ("Safety rules in the money path"). Specific to the wallet:

- **`lightwalletd tip has not moved`:** the wallet already switched to the next server; check zec.rocks.
- **`could not save the wallet to Postgres`:** check the database add-on.
- **`lost the wallet lease`:** two wallet dynos were running. Scale `wallet` back to 1.
