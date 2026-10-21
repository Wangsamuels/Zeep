# zeep-api

The backend for Zeep. Users deposit **any amount of ZEC**, and it becomes **two private balances**:

- **ZEC balance.** Half of each deposit (`ZEC_SHARE_BPS`) stays as the user's own **shielded ZEC**. The user carries ZEC's price moves, and withdrawing it is instant (no conversion, no conversion fee).
- **Dollar balance.** The other half is credited as **fixed dollars** at the price when it confirms, minus a 1.5% conversion fee. The treasury holds it as USDC.e on Tempo, which pays the services.

Each request is paid from the dollar balance with one zero-knowledge proof. The server sees what a request costs, but never anyone's balances, and it can't link one request to another. "Credits" are how the app shows everything a user owns: dollars + ZEC at the live price (default 1 credit = $1). When the dollars run low, the client converts ZEC to dollars in stages (below).

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
| `watcher` | `rust/src/bin/zeep-watcher.rs` | Keeps fresh deposit addresses ready and records payments to them |
| `payouts` | `rust/src/bin/zeep-payouts.rs` | Sends withdrawal tranches and float conversions, and shields ZEC that comes back (one sender, Redis lease) |
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
docs/FRONTEND_BRIEF.md           what the frontend must change, and the config files it needs
```

## Money flows

- **Deposit (any amount of ZEC).**
  1. The client sends `POST /v1/deposits` with two owner tags (`d`, `d_zec`) and gets a **fresh diversified address**.
  2. The user sends any amount from any wallet. No memo is needed.
  3. On confirmation it becomes two notes: a **ZEC note** of `ZEC_SHARE_BPS` (50%) of the zats, and a **dollar note** of `rest × price − DEPOSIT_FEE_BPS`.
  4. The treasury converts only the dollar half to USDC.e. The ZEC half stays shielded in the reserve.
- **Pay.** Route prices are in USD plus **4.5%** (`PRICE_MARKUP_BPS`), charged from dollar notes. If an upstream fails, the cost comes back as a new note.
- **Refill (client-side schedule).** When the dollar balance would fall to `REFILL_AT_BPS` (5%) of its last top-up, the SDK converts `REFILL_BPS` (50%) of the ZEC balance; then 50% of the rest; stage `REFILL_FINAL_STAGE` (3) converts all of it. A deposit resets the stages. `POST /v1/convert/to-usd` burns the ZEC note and mints a dollar note at the live price minus 1.5%. The client proposes the exact amount so its encrypted backup can hold it; the server accepts it within `CONVERT_QUOTE_TOLERANCE_BPS` of its own quote.
- **Withdraw.**
  1. If the ZEC balance covers it, one ZEC proof pays it straight from the shielded reserve. No conversion fee; it is scheduled at once.
  2. If the user wants more, the app shows a prompt and re-authenticates, then sends a second proof from dollar notes. Those dollars go USDC.e → Base → ZEC (`converting`, about 20–60 minutes, 1.5% fee), the ZEC is **shielded on arrival**, and everything is paid together.
  3. Payouts go to a shielded address, or a transparent one with `allow_transparent: true`, in two tranches 10 minutes apart.

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

## Run and test locally

```bash
npm ci
npm run circuits            # compiles the circuit, runs a DEV trusted setup, prints hashes
npm run migrate:dev && npm run dev
(cd rust && CHAIN_BACKEND=dev cargo run --bin zeep-watcher)
(cd rust && CHAIN_BACKEND=dev PAYOUT_ADDR_ENC_KEY=... cargo run --bin zeep-payouts)

npm test                    # 11 unit tests: real proofs, asset and tag forgeries failing, fees, float
npm run test:e2e            # 8 end-to-end tests with the Rust workers on the dev chain + mock rails
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

## Before mainnet

- **Trusted setup.** `npm run circuits` without `PTAU=` creates an **insecure dev setup**. For mainnet:
  - use the public Hermez/PSE `powersOfTau28_hez_final_14.ptau`;
  - run a phase-2 ceremony with several independent contributors;
  - publish the transcript and pin `SPEND_VKEY_SHA256`.
- **Chain backend.** `CHAIN_BACKEND=rpc` (Zallet on the VPS) and `dev` work. The in-dyno light client is still a trait to implement once an Ironwood-capable librustzcash is available.
- **Provider paths.** StableEmail, RxAtlas, TrialBase, Parallel and the RPC URL templates are best guesses. Confirm them during your day-1 endpoint checks (`PROVIDERS` in `src/routes/services.ts`).
- **Fee levels.** The 1.5% deposit and withdrawal fees assume each conversion costs about 1%. Watch `profit.conversion_costs_micro_usd` against `profit.conversion_fees_micro_usd` in `/v1/reserve` during testnet. If real slippage runs higher (the cap is `TREASURY_SLIPPAGE_BPS`, 1%), raise the fees.
- **Credit-to-conversion gap.** A deposit's dollar half (and a refill) is credited at the price when it confirms and converted a minute or so later. The fee absorbs small moves in between.
- **Profit floor.** With a 1% mock conversion cost, the 1.5% fees leave about 0.5% per conversion, so profit is below 1% of dollar volume in the tests and covered network fees pause on their own. If you want the 1% floor met from conversions alone, raise `DEPOSIT_FEE_BPS` / `WITHDRAWAL_FEE_BPS` or watch the real costs on testnet first.
- **Privacy trade-offs:**
  - `/v1/nullifiers/check` tells the server the caller holds some of the queried notes. It's used only on restore and sync, mixed with decoys.
  - Deposits link a deposit address to an amount, just as any payment does. Spends stay unlinkable.
