# Converting the testnet app to mainnet

This keeps the **same Heroku app** (`zeep-test`), the same add-on plans and the **same Vercel frontend**. Only the data, the secrets and the settings change.

Testnet data is erased, by design. A database or Redis that has held testnet data is refused by every mainnet process.

**Before you start**, finish anything you still want to see on testnet. Testnet balances are gone afterwards.

## 1. Convert the app (one script)

```bash
cd ~/Zeep/zeep-backend
./deploy/convert-to-mainnet.sh zeep-test
```

It asks you to type the app name, then:

- turns maintenance on and stops all processes;
- erases the database and replaces Redis;
- creates new secrets without printing them;
- removes the testnet wallet and other testnet-only settings;
- sets every mainnet setting that doesn't need your own accounts.

## 2. Relay (Cloudflare)

`deploy/cloudflare-worker/wrangler.toml` already points the mainnet Worker at your Heroku app. Run these one line at a time:

```bash
cd ~/Zeep/zeep-backend/deploy/cloudflare-worker
heroku config:get RELAY_SHARED_SECRET -a zeep-test | npx wrangler secret put RELAY_SHARED_SECRET --env mainnet
npx wrangler deploy --env mainnet
npx wrangler delete --name zeep-relay-testnet
```

- The `deploy` command prints `https://zeep-relay-mainnet.<you>.workers.dev`. That is your new API URL.
- Deleting the testnet Worker is safe: it now points at a mainnet app.

## 3. Your own keys (one command)

The app **refuses to start on mainnet if any of these is missing**. That check is deliberate, so a missing key is caught before a user pays.

```bash
heroku config:set -a zeep-test \
  PUBLIC_API_BASE_URL="https://zeep-relay-mainnet.<you>.workers.dev" \
  CORS_ALLOWED_ORIGINS="https://zeep-frontend.vercel.app" \
  TEMPO_PRIVATE_KEY="0x..." \
  TEMPO_RPC_URL="https://..." \
  BASE_RPC_URL="https://..." \
  RELAY_API_KEY="..." \
  MODAL_LLM_BASE_URL="https://..." \
  MODAL_PROXY_TOKEN="..."
```

| Var | What it is |
| --- | --- |
| `PUBLIC_API_BASE_URL` | The mainnet Worker URL from step 2. |
| `CORS_ALLOWED_ORIGINS` | Your Vercel URL. |
| `TEMPO_PRIVATE_KEY` | The treasury's EVM key. Fund it with a little gas on Base and Tempo, and about $50 of USDC.e on Tempo. It pays for AI, search and email, and moves the dollar float. |
| `TEMPO_RPC_URL`, `BASE_RPC_URL` | RPC endpoints for Tempo and Base. `BASE_RPC_URL` defaults to the public `https://mainnet.base.org`. |
| `RELAY_API_KEY` | Relay.link API key, from the Relay dashboard → Apps. |
| `MODAL_LLM_BASE_URL`, `MODAL_PROXY_TOKEN` | Your Modal deployment for the open-weight models. **No Modal yet?** See the option below the table. |
| `NEAR_ONECLICK_JWT` | **Already set** on testnet, so keep it. It's checked again on mainnet. |

**No Modal yet?** Offer only the frontier models (GPT-5, Claude, Gemini, paid over MPP) by replacing the model list:

```bash
heroku config:set -a zeep-test DEFAULT_MODEL="anthropic/claude-sonnet-4.5" MODELS_JSON='[{"id":"openai/gpt-5","name":"GPT-5","host":"mpp","usd":0.04,"vision":true,"detail":"Frontier, via MPP","testnet":false},{"id":"anthropic/claude-sonnet-4.5","name":"Claude Sonnet 4.5","host":"mpp","usd":0.03,"vision":true,"detail":"Frontier, via MPP","testnet":false},{"id":"google/gemini-2.5-pro","name":"Gemini 2.5 Pro","host":"mpp","usd":0.03,"vision":true,"detail":"Frontier, via MPP","testnet":false}]'
```

## 4. A new reserve wallet (mainnet)

```bash
heroku run -a zeep-test --type=wallet -- /app/bin/zeep-wallet init
```

It prints four lines once. **Write the 24 words down offline**: they control real money. Then set the four values it printed:

```bash
heroku config:set -a zeep-test ZEEP_WALLET_SEED="<24 words>" ZEEP_WALLET_BIRTHDAY_HEIGHT=<n> ZEEP_RECEIVE_UA=<u1...> ZEEP_RESERVE_TADDR=<t1...>
```

## 5. Deploy

```bash
cd ~/Zeep/zeep-backend && git add -A && git commit -m "Mainnet" && git push
```

Heroku builds from GitHub. If automatic deploys are off, go to Deploy → **Deploy Branch** `main`.

The release phase creates the tables and stamps the database as mainnet. If it fails, `heroku releases:output -a zeep-test` names the missing variable.

## 6. Start

```bash
heroku ps:scale -a zeep-test web=1 treasury=1 wallet=1
heroku maintenance:off -a zeep-test
heroku logs --tail -a zeep-test --ps wallet
```

Wait for the logs to show `connected to lightwalletd`, then scanning reaching the tip.

## 7. Frontend (same Vercel project)

Vercel → Settings → Environment Variables:

| Var | Value |
| --- | --- |
| `NEXT_PUBLIC_ZEEP_NETWORK` | `mainnet` |
| `NEXT_PUBLIC_API_BASE_URL_MAINNET` | the mainnet Worker URL, with no trailing slash |
| `NEXT_PUBLIC_LIGHTWALLETD_URL_MAINNET` | `https://zec.rocks:443` |

Then **Redeploy**.

## 8. Tell Claude: dry run

Once steps 1–7 are done, Claude checks the live mainnet without spending money:

- the network, block height and live price;
- the relay, including that it strips client IPs, and the refusal of direct calls;
- CORS;
- that the reserve is empty and balanced;
- the frontend build points at mainnet;
- account creation and a fresh `u1…` deposit address.

## Safety limits (already set)

| Setting | Value |
| --- | --- |
| Deposits | 2 ZEC a day |
| Hot wallet alert | above 0.5 ZEC |
| Paid services | $10 a day |

The spend circuit comes from a single-contributor setup, so keep these limits low until a multi-party setup is done.
