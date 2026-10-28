# Converting the testnet app to mainnet

This keeps the **same Heroku app** (`zeep-test`), the same add-on plans and the **same Vercel frontend**. Only the data, the secrets and the settings change.

Testnet data is erased, by design. A database or Redis that has held testnet data is refused by every mainnet process.

**Before you start**, finish anything you still want to see on testnet. Testnet balances are gone afterwards.

## 1. Convert the app (one script)

```bash
cd ~/Zeep/zeep-backend
bash ./deploy/convert-to-mainnet.sh zeep-test
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

## 3. Your own keys and settings

The app **refuses to start on mainnet if any of these is missing**. That check is deliberate, so a missing key is caught before a user pays.

**Already set:** `TEMPO_PRIVATE_KEY`, `RELAY_API_KEY` and `NEAR_ONECLICK_JWT`.

**a) Relay URL, frontend, RPCs and a funding limit that suits a small float:**

```bash
heroku config:set -a zeep-test \
  PUBLIC_API_BASE_URL="https://zeep-relay-mainnet.<you>.workers.dev" \
  CORS_ALLOWED_ORIGINS="https://zeep-frontend.vercel.app" \
  TEMPO_RPC_URL="https://rpc.tempo.xyz" \
  BASE_RPC_URL="https://base.drpc.org" \
  MPP_SESSION_MAX_USD=1 \
  MPP_DAILY_BUDGET_USD=5
```

| Var | Value |
| --- | --- |
| `TEMPO_RPC_URL` | Tempo's official RPC (chain 4217). |
| `BASE_RPC_URL` | a public Base RPC that doesn't log, from chainlist (chain 8453). |
| `MPP_SESSION_MAX_USD=1` | The most Zeep locks into one payment session with a provider. Keep it at or below the USDC.e on Tempo. Raise it once the float grows. |
| `MPP_DAILY_BUDGET_USD=5` | The most Zeep spends on paid services per day, for all users together. Users pay it back, but it also caps how much the service can be used in a day. |

Raise both as deposits grow the float. A long GPT-6 Astra chat can cost more than $1 for one request, so it needs `MPP_SESSION_MAX_USD` and the float above that.

**b) AI models: 10 frontier models (6 American, 4 Chinese), all through the MPP OpenRouter gateway (no Modal needed):**

```bash
heroku config:set -a zeep-test DEFAULT_MODEL="anthropic/claude-sonnet-5.5" MODELS_JSON='[{"id":"anthropic/claude-sonnet-5.5","name":"Claude Sonnet 5.5","host":"mpp","usd":0,"vision":true,"detail":"Anthropic · frontier","testnet":false,"gateway":"openrouter","in_usd_per_m":2,"out_usd_per_m":10,"context":1000000},{"id":"openai/gpt-6.1-sol","name":"GPT-6.1 Sol","host":"mpp","usd":0,"vision":true,"detail":"OpenAI · frontier","testnet":false,"gateway":"openrouter","in_usd_per_m":2,"out_usd_per_m":10,"context":1050000},{"id":"anthropic/claude-opus-5.5","name":"Claude Opus 5.5","host":"mpp","usd":0,"vision":true,"detail":"Anthropic · frontier, top tier","testnet":false,"gateway":"openrouter","in_usd_per_m":4,"out_usd_per_m":20,"context":1000000},{"id":"openai/gpt-6-astra","name":"GPT-6 Astra","host":"mpp","usd":0,"vision":true,"detail":"OpenAI · frontier, top tier","testnet":false,"gateway":"openrouter","in_usd_per_m":10,"out_usd_per_m":50,"context":1050000},{"id":"google/gemini-4-argon","name":"Gemini 4 Argon","host":"mpp","usd":0,"vision":true,"detail":"Google · frontier","testnet":false,"gateway":"openrouter","in_usd_per_m":2,"out_usd_per_m":10,"context":1048576},{"id":"x-ai/grok-4.7","name":"Grok 4.7","host":"mpp","usd":0,"vision":true,"detail":"xAI · frontier","testnet":false,"gateway":"openrouter","in_usd_per_m":2,"out_usd_per_m":6,"context":500000},{"id":"deepseek/deepseek-v4-pro-0813","name":"DeepSeek V4 Pro","host":"mpp","usd":0,"vision":false,"detail":"DeepSeek · frontier","testnet":false,"gateway":"openrouter","in_usd_per_m":1.32,"out_usd_per_m":3.96,"context":1048576},{"id":"qwen/qwen3.8-max-0902","name":"Qwen 3.8 Max","host":"mpp","usd":0,"vision":true,"detail":"Alibaba · frontier","testnet":false,"gateway":"openrouter","in_usd_per_m":2,"out_usd_per_m":6,"context":1000000},{"id":"moonshotai/kimi-k3.1-pro","name":"Kimi K3.1 Pro","host":"mpp","usd":0,"vision":true,"detail":"Moonshot · frontier","testnet":false,"gateway":"openrouter","in_usd_per_m":2,"out_usd_per_m":10,"context":1048576},{"id":"z-ai/glm-5.3-prime","name":"GLM 5.3 Prime","host":"mpp","usd":0,"vision":false,"detail":"Zhipu · frontier","testnet":false,"gateway":"openrouter","in_usd_per_m":2.8,"out_usd_per_m":8.8,"context":1000000}]'
```

The gateway charges Zeep per request, upfront: input tokens × input rate plus the output cap × output rate, with a $0.012 minimum. Zeep charges the user with the same formula plus 4.5%, before the request runs. It also enforces the output cap, so no reply can cost Zeep more than the user paid.

With the default 4,096-token cap, a short question costs about:

| Model | Price per reply |
| --- | --- |
| GPT-6 Astra | $0.214 |
| Claude Opus 5.5 | $0.086 |
| Claude Sonnet 5.5, GPT-6.1 Sol, Gemini 4 Argon, Kimi K3.1 Pro | $0.043 |
| GLM 5.3 Prime | $0.038 |
| Grok 4.7, Qwen 3.8 Max | $0.026 |
| DeepSeek V4 Pro | $0.017 |

**c) How much USDC.e the treasury needs.** You don't need $50; $1 works.

**Users always pay for every reply from their own balance, from the first one.** The USDC.e on Tempo is only Zeep's working float. Zeep pays the AI provider from it the moment a request runs, and gets that back from the user's payment, which is converted to USDC.e along with the dollar half of every deposit, about 20–60 minutes after it confirms. So the float refills itself.

A small float can only run short for a moment:

- **Paid services (AI, search, inbox):** if the float is momentarily empty, the request returns "busy" and the user's payment comes straight back to them as a new note. Nobody is charged for a reply they didn't get.
- **Withdrawals that convert credits back to ZEC** wait (with an ALERT in the logs) until the float covers them. ZEC-only withdrawals always work.
- **Base gas:** about 0.0002 ETH covers many bridge transactions. Top it up if the logs show `insufficient funds`.

### Check your config at any time

```bash
heroku run -a zeep-test -- node dist/doctor.js
```

This prints every missing or wrong setting in plain text, never the values. The release step only needs the database and network settings, so you can set variables in any order. Until everything is set, the web and treasury dynos refuse to start; `doctor.js`, and each release's output, list what's still missing.

## 4. A new reserve wallet (mainnet)

```bash
heroku run -a zeep-test --type=wallet -e "ZCASH_NETWORK=main;LIGHTWALLETD_URL=https://zec.rocks:443" -- /app/bin/zeep-wallet init
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
| `NEXT_PUBLIC_LIGHTWALLETD_URL_MAINNET` | the mainnet Worker URL followed by `/lwd`, e.g. `https://zeep-relay-mainnet.<you>.workers.dev/lwd` |

Then **Redeploy**.

The in-app wallet reaches its light-wallet server through the relay's `/lwd` path. Browsers can't speak raw gRPC, so `zec.rocks` doesn't work from the app directly. Going through the relay also means the light-wallet server never sees a user's IP next to their transparent address or the transactions they send.

## 8. Tell Claude: dry run

Once steps 1–7 are done, Claude checks the live mainnet without spending money:

- the network, block height and live price;
- the relay, including that it strips client IPs, and the refusal of direct calls;
- CORS;
- that the reserve is empty and balanced;
- the frontend build points at mainnet;
- account creation and a fresh `u1…` deposit address.

## 9. Oblivious HTTP (end-to-end encryption through the relay)

Without it, Cloudflare sees each user's IP next to what they do. With it, Cloudflare sees only the IP and an encrypted, padded blob, and Zeep's server sees the request but never the IP.

1. **Set the key before pushing the code** (mainnet refuses to start without it):

   ```bash
   heroku config:set -a zeep-test OHTTP_PRIVATE_KEY="$(openssl rand -base64 32)"
   ```

2. Push the code and wait for the release to finish.
3. Print the public half for the frontend:

   ```bash
   heroku run -a zeep-test -- node dist/ohttp-config.js
   ```

   It prints `NEXT_PUBLIC_OHTTP_KEY_CONFIG=...`. Add that to Vercel (Production), then have the frontend agent apply `docs/FRONTEND_UPDATE_OHTTP.md` and redeploy.
4. Once the new frontend works, refuse anything that isn't OHTTP:

   ```bash
   heroku config:set -a zeep-test REQUIRE_OHTTP=true
   ```

**Rotating the key:**

- move the current key to `OHTTP_PREVIOUS_PRIVATE_KEY` with `OHTTP_PREVIOUS_KEY_ID=1`;
- set a new `OHTTP_PRIVATE_KEY` with `OHTTP_KEY_ID=2`;
- update Vercel and redeploy;
- remove the previous key a day later.

## 10. Live dry run of the money rails and providers

```bash
heroku run -a zeep-test -- node dist/rails-check.js
```

Nothing is signed or sent. It checks:

- the ZEC price feed, the float on Tempo, USDC on Base, and Base gas;
- NEAR Intents quotes both ways, using your reserve address;
- Relay quotes both ways, plus a simulated bridge-back transaction from the treasury;
- that the reserve wallet is synced, and that no payout or conversion is stuck;
- each paid provider's live price against what Zeep charges.

Every line is `PASS`, `WARN` or `FAIL`. Run it after any config change, and before you announce the app.

**What protects the treasury from provider prices:**

- AI replies are priced from the gateway's own quote for the exact request, never below it.
- Zeep never pays a provider more than the user paid for that request. Free routes never pay anything.
- The config refuses any route price below the provider's price.

## Safety limits (already set)

| Setting | Value |
| --- | --- |
| Deposits | 2 ZEC a day |
| Hot wallet alert | above 0.5 ZEC |
| Paid services | $10 a day |

The spend circuit comes from a single-contributor setup, so keep these limits low until a multi-party setup is done.
