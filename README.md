# zeep-api

The backend for Zeep. Users deposit **any amount of ZEC**, and it becomes **two private balances**:

- **ZEC balance.** Half of each deposit (`ZEC_SHARE_BPS`) stays as the user's own **shielded ZEC**. The user carries ZEC's price moves, and withdrawing it is instant (no conversion, no conversion fee).
- **Dollar balance.** The other half is credited as **fixed dollars** at the price when it confirms, minus a 1.5% conversion fee. The treasury holds it as USDC.e on Tempo, which pays the services.

Each request is paid from the dollar balance with one zero-knowledge proof. The server sees what a request costs, but never anyone's balances, and it can't link one request to another. "Credits" are how the app shows everything a user owns: dollars + ZEC at the live price (default 1 credit = $1). When the dollars run low, the client converts ZEC to dollars in stages (below).

## Live services

Every request is paid with one spend proof. Zeep pays the provider over MPP (Tempo USDC.e) from its float, so providers see Zeep, never the user. Prices are in `/v1/prices`.

| Service | Route | Provider | User price (credits) |
| --- | --- | --- | --- |
| Private AI (10 frontier models) | `POST /v1/ai/chat/completions` | OpenRouter MPP gateway | per reply, from the gateway's own quote + 4.5% |
| Web search | `POST /v1/search` | Exa | 0.0104 |
| Research (cited answer / multi-hop) | `POST /v1/research` | Parallel | 0.031 / 0.063 / 0.209 (base / core / pro) |
| Health lookup (drugs, trials) | `POST /v1/health/lookup` | RxAtlas, TrialBase | 0.1045 |
| Send-only email (no inbox needed) | `POST /v1/email/send` | StableEmail (shared relay address) | 0.026 |
| Anonymous inbox (own address, 30 days) | `POST /v1/inbox` (+ list, read, send, reply, delete) | AgentMail | 2.09, then 0.0105 per send |
| Encrypted vault (chats, settings) | `/v1/vault/*` | Zeep (Postgres) | free |

**No service can cost the treasury more than the user paid:**

- AI replies are priced from the gateway's 402 quote for the exact request (fetched without paying), never below it. The SDK pays that exact price once if its own estimate was low.
- `mppFetch` refuses to sign any provider payment above what the user paid for that request, and free routes can't pay anything. The user is refunded.
- The config refuses any route price below the provider's price (`PROVIDER_COST_USD` in `src/config.ts`).
- `node dist/rails-check.js` compares every provider's live price with Zeep's.

## Network privacy: relay + Oblivious HTTP

```
browser ──OHTTP (encrypted, padded)──▶ Cloudflare Worker relay ──▶ Heroku /ohttp ──▶ the normal routes, in-process
in-app wallet ──gRPC-web──▶ relay /lwd ──▶ ChainSafe gRPC-web proxy ──▶ zec.rocks
```

- **The relay** (`deploy/cloudflare-worker/`) forwards only an allowlist of headers, adds the relay secret, and strips query strings plus Heroku's error-report headers. Heroku refuses anything that didn't come through it (`REQUIRE_RELAY`), so its router never logs a user's IP.
- **OHTTP** (RFC 9458 + chunked OHTTP, HPKE X25519 / HKDF-SHA256 / AES-128-GCM; `src/lib/ohttp.ts` = `sdk/ohttp.ts`):
  - every API call is encrypted to Zeep's key and posted to `POST /ohttp`;
  - the relay sees the user's IP but only ciphertext: no route, headers, ids, proofs or content;
  - Zeep's server sees the request but never the IP;
  - requests and replies are padded to size buckets, and streamed AI replies are sent in timed, padded batches, so lengths and token counts don't show;
  - a cut or tampered message fails closed.
- **The OHTTP key ships with the frontend build** (`NEXT_PUBLIC_OHTTP_KEY_CONFIG`), never fetched through the relay. `REQUIRE_OHTTP=true` refuses every plain API call.
- **Light-wallet traffic** goes through the relay's `/lwd` path, so the light-wallet server never sees the user's IP.
- **Still visible:** Cloudflare sees that an IP uses Zeep and when, plus the wallet's sync traffic; Vercel sees page loads. Zeep runs the relay, so an independent relay operator would be the next step.

## How the private balances work

Balances are sets of **notes**, which work like Zcash's own shielded notes. Each note has an `asset` (0 = dollars in micro-USD, 1 = ZEC in zats) and is defined as follows:

```
pk = Poseidon(sk)     d = Poseidon(pk, rho)     leaf = Poseidon(d, amount, asset)     nullifier = Poseidon(sk, rho)
```

A spend (`circuits-src/zeep_spend.circom`, Groth16) does five things:

- uses up to **2 notes**, all of one public `asset`;
- reveals their nullifiers;
- charges a public `cost` in that asset;
- creates **2 new notes** of the same asset that hold the remainder (change, or a transfer to an agent);
- binds itself to one exact request.

Value is conserved per asset, so a dollar note can never be spent as ZEC or the other way round. Only the server converts between them: it burns one and mints the other at the live price.

One circuit covers these operations:

- **Paying for a service:** dollars, cost = price.
- **Refill (ZEC → dollars):** ZEC, cost = zats converted; the server mints a dollar note.
- **Withdrawing:** ZEC first, plus dollars converted back if needed; the proofs bind the payout address.
- **Merging or splitting notes:** cost = 0.
- **Funding an agent:** cost = 0, and output 2 goes to the agent's key.

What the server stores:

- note commitments;
- encrypted note backups (only the owner can read them);
- nullifiers;
- daily totals.

It does not store balances, IPs or request bodies.

## Processes

| Process | Code | Job |
| --- | --- | --- |
| `web` | `src/server.ts` | Public API, spend verification, service proxy, SSE streaming, deposit activator |
| `treasury` | `src/workers/treasury.ts` | Converts ZEC not owed to ZEC notes into USDC.e, and credits back to ZEC for withdrawals (NEAR Intents + Relay); raises reserve alerts; applies retention rules |
| `wallet` | `rust/src/bin/zeep-wallet.rs` | **The Zcash light client (`CHAIN_BACKEND=lightclient`):** syncs from lightwalletd (zec.rocks, with failover), keeps deposit addresses ready, records deposits, sends payouts and conversions, and shields returned ZEC. Exactly 1 dyno (Standard-2X); its state is saved in Postgres. |
| `watcher` / `payouts` | `rust/src/bin/zeep-watcher.rs`, `zeep-payouts.rs` | The same two jobs as separate processes, for `CHAIN_BACKEND=rpc` (Zallet on a VPS) or `dev` (simulated chain, tests) |
| `release` | `src/migrate.ts` | Migrations; opens the first note tree |

```
circuits-src/zeep_spend.circom   the spend circuit
scripts/setup-circuit.sh         compile + Groth16 setup → circuits/
src/notes/                       note trees (registry), spend verification
src/routes/money.ts              deposits, refills (convert/to-usd), withdrawals, note management
src/routes/vault.ts              encrypted per-user storage (chat history, settings)
src/services/prices.ts           USD prices (+ 4.5%) in micro-USD; ZEC price for conversions
src/services/fees.ts             deposit / withdrawal fees, covered-fee budget, profit floor
src/treasury/                    Tempo float: conversions and the NEAR Intents / Relay rails
sdk/                             client SDK (browser + Node): keys, notes, proving, pay, refill, deposit, withdraw, restore
src/lib/ohttp.ts, src/routes/ohttp.ts   Oblivious HTTP gateway (shared crypto with sdk/ohttp.ts)
src/rails-check.ts               live dry run of rails and provider prices (nothing is sent)
deploy/cloudflare-worker/        the relay (API + /lwd)
docs/DEPLOY.md, docs/MAINNET_CONVERSION.md   deployment and the testnet → mainnet conversion
```

## Money flows

- **Deposit (any amount of ZEC).**
  1. The client sends `POST /v1/deposits` with two owner tags (`d`, `d_zec`) and gets a **fresh diversified address**.
  2. The user sends any amount from any wallet. No memo is needed.
  3. On confirmation it becomes two notes: a **ZEC note** of `ZEC_SHARE_BPS` (50%) of the zats, and a **dollar note** of `rest × price − DEPOSIT_FEE_BPS`.
  4. The treasury converts only the dollar half to USDC.e. The ZEC half stays shielded in the reserve.
  5. **Small deposits become credits only.** A deposit worth less than `ALL_CREDITS_BELOW_MICRO_USD` ($10) has no ZEC half: all of it becomes credits (minus 1.5%), ready for services. Split 50/50, its dollar half would sit under the $5 convert-back minimum.
- **Pay.** Route prices are in USD plus **4.5%** (`PRICE_MARKUP_BPS`), charged from dollar notes. If an upstream fails, the cost comes back as a new note.
- **Refill (client-side schedule).** When the dollar balance would fall to `REFILL_AT_BPS` (5%) of its last top-up, the SDK converts `REFILL_BPS` (50%) of the ZEC balance; then 50% of the rest; stage `REFILL_FINAL_STAGE` (3) converts all of it. A deposit resets the stages. `POST /v1/convert/to-usd` burns the ZEC note and mints a dollar note at the live price minus 1.5%. The client proposes the exact amount so its encrypted backup can hold it; the server accepts it within `CONVERT_QUOTE_TOLERANCE_BPS` of its own quote.
- **Withdraw.**
  1. If the ZEC balance covers it, one ZEC proof pays it straight from the shielded reserve. No conversion fee; it is scheduled at once.
  2. If the user wants more, the app shows a prompt and re-authenticates, then sends a second proof from dollar notes. Those dollars go USDC.e → Base → ZEC (`converting`, about 20–60 minutes, 1.5% fee), the ZEC is **shielded on arrival**, and everything is paid together.
  3. Payouts go to a shielded address, or a transparent one with `allow_transparent: true`, in two tranches 10 minutes apart.
  4. Credits converted back must be at least `MIN_CONVERT_BACK_MICRO_USD` ($5). NEAR Intents refuses Base → ZEC swaps under about $1.70 and keeps a fixed ~0.003 ZEC to deliver ZEC, so smaller conversions would fail or lose most of their value. "Withdraw all" leaves credits under the minimum as credits. Before bridging, the treasury asks NEAR Intents (dry quote) whether it will accept the amount; if not, nothing moves and an ALERT asks for a manual payout.

## Fees: who pays

Fees apply only to what is actually converted.

| | Fee | First one of the user's UTC day |
| --- | --- | --- |
| Service request | upstream price + **4.5%** | — |
| Deposit | ZEC half: free. Dollar half: **1.5%** (`DEPOSIT_FEE_BPS`), paying ZEC → USDC → Tempo | The user's own network fee is credited back |
| Refill (ZEC → dollars) | **1.5%** of what's converted | — |
| Withdrawal | From ZEC: no conversion fee. Credits converted back: **1.5%** (`WITHDRAWAL_FEE_BPS`), paying Tempo → USDC → ZEC. Plus the two payout network fees (20,000 zats) | Zeep pays the network fees |

Each conversion fee is set above the real cost of its route, so every conversion leaves a margin for the treasury. `/v1/reserve` shows each fee next to the real cost it paid for:
- **Conversion costs** are what the swaps actually lost: NEAR Intents spread and slippage, Relay, and gas.
- **Profit** = 4.5% service margin + conversion fees − covered network fees − conversion costs.

"Per user per day" is enforced privately with a **daily tag**, `Poseidon(sk, day, purpose)`, proven in the spend circuit. Tags from different days can't be linked, and ordinary spends use a random tag.

Covered network fees are paid only from profit above `PROFIT_FLOOR_BPS` (1%) of dollar volume, plus a $2.50 launch allowance. When that budget is spent, everyone pays their own network fees until profit builds up. `GET /v1/fees` shows the current rules.

## Tempo float and the reserve

The reserve holds each asset against its own notes, so neither side depends on ZEC's price:

- **ZEC notes → shielded ZEC** in the reserve wallet, plus a small fee buffer (`ZEC_FLOOR_ZATS`, 0.002 ZEC) that pays the network fees Zeep covers. It refills itself from the next deposits.
- **Dollar notes → USDC.e on Tempo.** Each `FLOAT_TICK_SEC`, ZEC that no ZEC note needs (dollar halves of deposits, refills) is converted. MPP providers are paid straight from it.
- **Withdrawals that convert credits** convert their own dollars back: USDC.e → Relay → USDC on Base → NEAR Intents → ZEC at the reserve's transparent address. That ZEC is shielded automatically, then paid out.

`/v1/reserve` reports `zec` and `usd` separately (owed, held, coverage), plus a combined total at the live price.

**Routes.**
- NEAR Intents doesn't support Tempo, so conversions pass through **USDC on Base**, and **Relay** bridges Base ⇄ Tempo (chain 4217).
- NEAR Intents only accepts **transparent** Zcash addresses, so ZEC goes out to, and comes back at, t-addresses. The payouts worker shields what comes back.
- `TREASURY_RAILS=live` runs real conversions; `mock` is for tests and testnet.

## Testnet and mainnet never mix

Each network gets its **own Postgres and Redis**. The live deployment is one Heroku app converted from testnet to mainnet (`deploy/convert-to-mainnet.sh` erases the testnet data). Every process checks this at boot and refuses to start otherwise:

- **Config.**
  - `ZEEP_ENV` and `ZCASH_NETWORK` must match (`testnet`/`test`, `mainnet`/`main`).
  - `ZEEP_RECEIVE_UA`, `ZEEP_RESERVE_UA`, `ZEEP_RESERVE_TADDR` and `TREASURY_REFUND_TO` must be addresses of that network.
- **Mainnet** additionally needs:
  - `TREASURY_RAILS=live` and `MPP_MODE=live`;
  - a pinned `SPEND_VKEY_SHA256`;
  - a live ZEC price (no fallback);
  - `REQUIRE_RELAY=true`;
  - `OHTTP_PRIVATE_KEY` (and, once the frontend sends OHTTP, `REQUIRE_OHTTP=true`).
- **Testnet** can never move real money:
  - the rails are always simulated;
  - live paid services need `TESTNET_LIVE_MPP=true`.
- **Database.** The first migrate stamps it with its network. The web, treasury, wallet, watcher and payouts processes all refuse a database stamped for the other network.
- **Redis.** Every key, lock, queue and channel is prefixed `zeep:<network>:`, and the Redis is stamped with its network too.
- **Zcash server.** The light client asks each lightwalletd server which chain it serves and refuses one on the other network. It also refuses a `ZEEP_RESERVE_TADDR` that doesn't belong to its seed, so NEAR Intents can't send ZEC to the wrong place. With Zallet (`rpc`), the workers check `getblockchaininfo` and fail closed on mainnet unless `ALLOW_UNVERIFIED_NODE_NETWORK=1`.
- **User keys.** The SDK derives every key with the network in it, so one recovery phrase gives unrelated keys, vault ids and deposit ids on testnet and mainnet. The client refuses to talk to a server on the other network before sending anything key-derived.

## Safety rules in the money path

- **Prices.** Money moves only at a live price no older than `PRICE_MAX_AGE_SEC`, and never at the fallback price on mainnet. Without one, deposits wait and refills/withdrawals return 503 `price_unavailable`.
- **Deposits.**
  - One intent becomes exactly one ZEC note + one dollar note. A second payment to the same address is held and claimed as one combined deposit.
  - ZEC still confirming counts as owed, so the float never converts it. The reserve wallet's spendable balance is read at `MIN_CONFIRMATIONS`.
- **Refunds.** A failed request is refunded as a new note, except when Zeep already paid the upstream (an MPP payment was signed). The service margin is booked in the same transaction and reversed on a refund.
- **Treasury conversions** record each step before moving money.
  - If a step is interrupted while money may already have moved, the conversion is marked `failed` and raised as an `ALERT` for a manual check. It is never retried blindly.
  - Withdrawals converting credits wait in `converting` until someone resolves it.
  - Housekeeping never touches a withdrawal that is still converting.
- **Payouts.** One bad lookup doesn't block the others. An RPC outage doesn't count as "unconfirmed". A payout still unconfirmed after 2 hours becomes `stuck` and is checked again later.

**Operations: what an ALERT means.**

| Log line | What to do |
| --- | --- |
| `conversion interrupted mid-payment` / `bridge back delivered too little` | Check the EVM wallet, Relay and 1Click for that conversion; finish or refund it by hand. Then set the conversion `done` and schedule the withdrawal's tranches (or refund the user). |
| `withdrawal conversion refunded` | 1Click refunded the swap: the USDC is back on Base. Re-run the swap by hand for that withdrawal. |
| `payouts stuck` / `payout unconfirmed after 2 hours` | Look the txid up in the wallet. If it never broadcast, set the payout back to `scheduled`. |
| `reserve below coverage floor` | Compare `/v1/reserve` with the wallet and the float before anything else. |

## Privacy rules

- **No IPs anywhere.** The server deletes IP headers before any handler runs, logs only route, status and latency (`logger: false`, `trustProxy: false`), and has no IP or user-agent column. The tests check all three.
- **Spent-note checks** go by bucket (`/v1/nullifiers/buckets`). Clients never send their exact nullifiers.
- **Bearer ids stay out of URLs.** Deposit intent ids, withdrawal ids and the vault id travel in request bodies or headers, never in URL paths, which Heroku's router logs.
- **`/v1/reserve`** is published hourly and rounded to $1 and 0.01 ZEC.
- **Stored timestamps and hashes.** Notes and nullifiers keep only the day. Deposit hashes are salted with a per-database secret.
- **Payouts on-chain.** They try `FullPrivacy` first and fall back to revealing amounts only when a send must cross pools. Tranches are split around 50% with ±10% jitter.

## Known limits before mainnet

- **Deposit spam.** Each deposit intent takes an address. The light client scans every block once for the whole account, so watched addresses cost nothing extra. The `MAX_OPEN_INTENTS` cap still lets a determined attacker block new deposits for a day; the proof of work (`INTENT_POW_BITS`) makes that cost them CPU. With the Zallet backend, each watched address also costs one RPC call per tick.
- **Late payments.** An address is watched until 7 days after its intent expires. Later payments aren't credited automatically: they show up as surplus ZEC (refund by hand).
- **Restore links deposits.** Restoring asks for each deposit slot's status, which shows the server those deposits belong together (as creating them did).
- **Free tags.** The daily free tag is per key. Someone who spreads money over fresh keys can claim more than one covered fee a day; the profit floor caps the total.
- **Migrations.** `001_init.sql` was edited in place because nothing is deployed yet. After the first deploy, every schema change goes in a new `00N_*.sql`.

## Run and test locally

```bash
npm ci
npm run circuits            # compiles the circuit, runs a DEV trusted setup, prints hashes
npm run migrate:dev && npm run dev
(cd rust && CHAIN_BACKEND=dev cargo run --bin zeep-watcher)
(cd rust && CHAIN_BACKEND=dev PAYOUT_ADDR_ENC_KEY=... cargo run --bin zeep-payouts)

npm test                                        # 23 unit tests
npm run test:e2e                                # 36 end-to-end tests, testnet settings
ZEEP_E2E_NETWORK=mainnet npm run test:e2e       # the same 36 with mainnet settings (own DB zeep_mainnet_test, Redis db 1)
ZEEP_E2E_OHTTP=1 npm run test:e2e               # every call through OHTTP, with plain calls refused (combine with the line above)
(cd rust && cargo test)
```

The end-to-end tests run the SDK the same way the app will:

1. deposit 0.5 ZEC and 0.1234567 ZEC: each splits into a ZEC note and a dollar note (1.5% only on the converted half), only the first gets its network fee back, and only the dollar halves are converted to USDC.e;
2. pay for search ($0.01045) and a streamed AI reply from dollars; ZEC is untouched;
3. check that a replayed proof is refused (409) and underpaying is refused (402) without losing money;
4. trigger a staged refill: 50% of the ZEC becomes dollars, and the float converts it;
5. withdraw from ZEC (scheduled at once, network fees covered as the first of the day); withdraw ZEC to a transparent address (needs the opt-in, pays its own fees); then withdraw more than the ZEC balance, converting credits back (`converting`, then paid with the ZEC part);
6. restore both exact balances from the 24 words;
7. check that ZEC held covers ZEC owed, dollars held cover dollars owed, and the fees leave a profit after real conversion costs;
8. check that vault items expire after the 30-day auto-delete.

They also cover these safety cases:

- **attacks on the money path:** the same proof sent twice at once, a captured proof reused for another route or body, under- and overpaying, a failed provider (refunded exactly once), two devices spending the same notes at once; the books balance after each;
- **privacy:** no IP, user agent or smuggled header reaches a handler, a log or the database; OHTTP sizes are padded, and tampering, an unknown key or a cut reply fail closed;
- **services:** metered AI pricing and its one-time correction, model switching mid-chat, the daily spending limit, research, health, the full inbox and send-only email;
- housekeeping never touches a converting withdrawal;
- two payments to one address are credited once each, with no duplicate notes;
- confirming deposits count as owed;
- every process, Node and Rust, refuses a database, Redis or config from the other network.

The mainnet run uses `u1`/`zs1`/`t1` addresses, the mainnet model list and no testnet caps. Only the chain and rails are simulated: `ZEEP_TEST_SIMULATION=1`, which works only with `NODE_ENV=test` and never on Heroku.

## Before mainnet

- **Trusted setup.** `npm run circuits` without `PTAU=` creates an **insecure dev setup**. For mainnet:
  - use the public Hermez/PSE `powersOfTau28_hez_final_14.ptau`;
  - run a phase-2 ceremony with several independent contributors;
  - publish the transcript and pin `SPEND_VKEY_SHA256`.
- **Chain backend.** `lightclient` (recommended, no VPS), `rpc` (Zallet) and `dev` all work.
  - The light client is built on `zcash_client_backend` 0.25 and `zcash_client_sqlite` 0.23, which are Ironwood-ready. It receives in Sapling, Orchard and Ironwood, and sends change into Ironwood from NU6.3 on.
  - **Tested live on testnet** against zec.rocks: wallet creation, failover, sync, deposit addresses, saving and restoring through Postgres, and network/address checks.
  - **Tested on testnet with real testnet ZEC:** receiving a deposit and claiming it, and withdrawals coming back to Zeep's own addresses.
  - **Live on mainnet:** sync, deposit addresses, NEAR Intents and Relay quotes both ways (`rails-check`). A real mainnet deposit, conversion and payout haven't run yet: do a small one first.
- **Provider paths and prices** were checked against each provider's live 402 challenge (Oct 2026). Re-check any time with `heroku run -a <app> -- node dist/rails-check.js`.
- **Fee levels.** The 1.5% deposit and withdrawal fees assume each conversion costs about 1%. Watch `profit.conversion_costs_micro_usd` against `profit.conversion_fees_micro_usd` in `/v1/reserve` during testnet. If real slippage runs higher (the cap is `TREASURY_SLIPPAGE_BPS`, 1%), raise the fees.
- **Credit-to-conversion gap.** A deposit's dollar half (and a refill) is credited at the price when it confirms and converted a minute or so later. The fee absorbs small moves in between.
- **Profit floor.** With a 1% mock conversion cost, the 1.5% fees leave about 0.5% per conversion, so profit is below 1% of dollar volume in the tests and covered network fees pause on their own. If you want the 1% floor met from conversions alone, raise `DEPOSIT_FEE_BPS` / `WITHDRAWAL_FEE_BPS` or watch the real costs on testnet first.
- **Privacy trade-offs:**
  - `/v1/nullifiers/check` tells the server the caller holds some of the queried notes. It's used only on restore and sync, mixed with decoys.
  - Deposits link a deposit address to an amount, just as any payment does. Spends stay unlinkable.
