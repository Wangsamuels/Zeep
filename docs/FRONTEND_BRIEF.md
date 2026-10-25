# Zeep frontend: changes for the new backend

Give this to the agent working in `Zeep-front`. The backend moved from **fixed plans and one RLN proof per credit** to **two private balances**:

- **ZEC balance** (ZEC notes, in zats). Half of every deposit stays as the user's own shielded ZEC. Its dollar value moves with ZEC's price; that's the user's.
- **Dollar balance** (dollar notes, in micro-USD). The other half is converted to fixed dollars (minus 1.5%). Services are paid from it, one zero-knowledge proof per request.

**Credits are how the app shows everything the user owns**: dollars + ZEC at the live price (1 credit = $1 by default). The user never sees the split unless they open the balance details.

The treasury side (USDC.e on Tempo, the EVM wallet, bridges) is run by Zeep. **Nothing EVM-related goes in the frontend.**

The reference client is in the backend repo at `sdk/`. It is plain TypeScript that works in the browser, so copy it into the frontend; don't rewrite it. The backend end-to-end tests drive it through deposit → pay → withdraw → restore, so it is known to work against the API.

## 0. Do this first: re-sync `lib/zeep/` with the backend `sdk/` (the live testnet needs it)

The copy in `Zeep-front/lib/zeep/` is an **older SDK version**, and the deployed testnet backend rejects it. The deposit page shows `missing or insufficient proof of work (pow)` (HTTP 400 from `POST /v1/deposits`). Paid requests, conversions and status polling will fail next.

**What's out of date in the old copy**

| Old copy in `lib/zeep/` | Backend `sdk/` (current) |
| --- | --- |
| `POST /v1/deposits` sends no `pow` | Reads `deposits.pow_bits` from `GET /v1/config`, solves `solvePow(intentId, bits)` (about 1 s at 16 bits) and sends `pow` |
| `GET /v1/deposits/:id` (removed from the API) | `POST /v1/deposits/status` with `{ intent_id }`; withdrawals use `POST /v1/withdrawals/status` likewise |
| `requestSignal` uses `zeep-req-v1` | `zeep-req-v2`, which also binds `refundD`; otherwise every paid request fails proof verification |
| `convertSignal` uses `zeep-convert-v1` (id, mintD) | `zeep-convert-v2`, which also binds the amount; on `price_moved` it re-proves |
| Keys don't depend on the network | `deriveKeys(seed, network)`, so `ZeepKeys.network` is set and the client refuses a server on the other network |
| Spent check per nullifier | Bucketed check: `POST /v1/nullifiers/buckets`, using `nullifier_bucket_bits` from config |
| Withdrawal tag | Goes on the larger of the two proofs, which must move at least `FREE_FEE_MIN` |

**How to sync**

1. Copy **every file** from the backend `sdk/` over `lib/zeep/`: `client.ts`, `field.ts`, `index.ts`, `keys.ts`, `notes.ts`, `spend.ts`, `tree.ts`, `units.ts`.
2. Keep the frontend-only files (`pay.ts`, `prices.ts`, `prove.ts`). Fix their imports or types if the copied files changed them. Don't edit the copied SDK files to suit them.
3. Pass the active network into `deriveKeys`/`ZeepClient` (see §2c). Existing 24-word phrases still work, but they now give different keys. That's fine on testnet because no funds are on it yet; users just sign in again.
4. Check that all of these pass:
   - `grep -rn "zeep-req-v1\|zeep-convert-v1\|/v1/deposits/\${" lib/` finds nothing;
   - `npm run build` passes;
   - the deposit page creates an address on the testnet relay.

After this, re-copy `sdk/` whenever the backend changes it (the backend commit message will say "SDK").

---

## 1. Remove the old model

Delete or replace everything built around plans, slots and RLN:

- `lib/proof/*` and `workers/proof.worker.ts`: replace with the new spend prover (section 4).
- `PLANS`, `MODELS`, `SERVICE_COST` and `planById` in `lib/catalog.ts`: plans are gone, and prices come from `GET /v1/prices`.
- `components/SlotGrid.tsx`, plus the slot, plan and series fields in `lib/vault/types.ts` (`seriesId`, `creditLimit`, `planId`, `priceZec`, `slots`, `slotsReliable`, `activated`, `preview`).
- The plan picker in `GetFlow.tsx`. Onboarding is now: create phrase → PIN/passkey → (optional) deposit.
- Every `withCredits({ cost: N })` call. Replace it with `client.pay(...)` (section 5).

## 2. One phrase for everything

- Change the recovery phrase to **24 words** (`NEXT_PUBLIC_RECOVERY_WORDS=24`), which WebZjs expects. Keep the existing PIN, Argon2id and passkey wrapping, and store the phrase itself encrypted in the vault record. Signing a Zcash transaction needs it.
- From the phrase:
  - `seedFromPhrase(phrase)` → `deriveKeys(seed, network)` gives the Zeep spend key, the note-backup key, the vault id, auth and key, and the deposit-intent key. `network` is `"testnet"` or `"mainnet"`: **set it in the app build per deployment** (`NEXT_PUBLIC_ZEEP_NETWORK`), never from user input. The same phrase gives unrelated keys on each network. `ZeepClient` checks `/v1/config` and refuses a server on the other network before sending anything.
  - The **same phrase** creates the in-app Zcash wallet (WebZjs account 0).
  - Restoring on a new device means entering the 24 words. That one step restores the wallet, the balance (`client.restore()`) and the chat history (vault).

## 2b. Sign out, and sign in with the 24 words

Users can sign out, and sign in to the same or another account with its 24 words. One account is open on a device at a time.

**Sign out** (Settings → Account → "Sign out", shown only while unlocked):

1. Open a warning dialog (Radix AlertDialog):
   - Title: "Have you saved your 24-word recovery phrase?"
   - Body: "Signing out removes this account from this device. The only way back in is your 24 words. Zeep can't recover them for you, and without them your balance and wallet are lost for good."
   - If chat sync is off: "Your chats are stored only on this device and will be deleted. Turn on 'Sync chats across devices' first to keep them."
   - Always, if there are any: "Your images and files (N) are stored only on this device and will be deleted. Download any you want to keep." Add a **Download all** button that saves them as one .zip.
   - If a withdrawal is still `converting` or `paying`, or a deposit is `confirming`: "You have a payment in progress. It will finish, and you'll see it after signing back in."
   - A **"Show my phrase"** button that asks for the PIN or passkey, then shows the words.
   - A required checkbox: "I've written down my 24 words."
   - **Sign out** (disabled until the box is ticked) and **Cancel**.
2. On confirm, clear this account from the device:
   - drop the keys and the `ZeepClient` from memory, and stop the proof and wallet workers;
   - delete the IndexedDB data: the vault record (encrypted phrase, PIN/passkey wrapping), the note book, local chats, settings, and the WebZjs wallet database;
   - remove the passkey link for this account;
   - go to the welcome screen.
   - Nothing is sent to the server, and nothing is deleted there: notes, deposit records and synced chats stay, encrypted, for the next sign-in.

**Welcome screen (signed out)** has two choices:

- **Create a new account**: the current onboarding (new 24 words → PIN/passkey → optional deposit).
- **Sign in with 24 words**: one input with 24 word fields; paste should split them across the fields.
  1. Validate with `seedFromPhrase` (checksum and wordlist). Show "Those words are not a valid recovery phrase" on failure.
  2. Set a new PIN/passkey for this device.
  3. Restore, with a progress screen:
     - `client.restore(onProgress)` finds both balances (ZEC and dollars);
     - `create_account("zeep", phrase, 0, birthday)` then `sync()` restores the in-app wallet;
     - if sync was on, pull chats from the vault.
  4. **Wallet birthday.** When an account is created, save the wallet's birthday height in the vault as item `wallet-meta` (`{ birthday }`), encrypted like chats. On sign-in, read it from the vault first so the wallet scan starts there and doesn't take long. If it's missing, use the Zcash Sapling activation height (the slowest option) and say "Restoring your wallet can take a few minutes".

To switch accounts, the user signs out and signs in with the other account's 24 words.

## 2c. Testnet and mainnet in the app

- **One deployment per network.** Each build sets `NEXT_PUBLIC_ZEEP_NETWORK` and points at that network's API. Don't put a network switch in the UI.
- **Namespace stored data.** Everything stored on the device goes under keys that include the network, e.g. `zeep:mainnet:notes`:
  - the encrypted note book;
  - chats and files;
  - settings;
  - the WebZjs wallet database (`new WebWallet("main" | "test", …)`).
- **Keep the networks apart.** Testnet data must never load on mainnet: different keys, different notes, different wallet.
- **Testnet banner.** Show a clear "Testnet: test ZEC only" banner on testnet.

## 3. In-app Zcash wallet (WebZjs)

- **SDK.** Use ChainSafe **WebZjs** (listed on zechub.wiki/developers as the web SDK). ChainSafe publishes only `@chainsafe/webzjs-keys` to npm. Build `webzjs-wallet` from the ChainSafe/WebZjs repo at a pinned commit and vendor the output. Don't depend on unofficial forks on npm such as `@bytezhang/webzjs-wallet`.
- **API used:**
  - `new WebWallet(network, lightwalletdUrl, 1, 1)`
  - `create_account("zeep", phrase, 0, birthday)`
  - `sync()`
  - `get_wallet_summary()` for the wallet balance
  - `get_current_address(0)` for receiving
  - `pczt_create` → `pczt_sign` (needs the USK from `derive_from_seed`) → `pczt_prove` → `pczt_send` to pay
- **Threads.** WebZjs uses `initThreadPool`, which needs `SharedArrayBuffer`, so the app must be **cross-origin isolated**. See the COOP/COEP headers in section 9.
- **gRPC-web.** WebZjs talks to lightwalletd over gRPC-web. The VPS needs a gRPC-web proxy (for example Envoy) in front of lightwalletd or Zaino, and its URL goes in `NEXT_PUBLIC_LIGHTWALLETD_URL_*`.
- **Auto-shield (required).** NEAR Intents and many exchanges only use transparent addresses, so ZEC can land on the wallet's transparent address. After every `sync()`:
  1. Read the transparent balance from `get_wallet_summary()`.
  2. If it is at least `NEXT_PUBLIC_AUTOSHIELD_MIN_ZATS` (default 100,000 zats, so the fee stays small next to it), run `pczt_shield(0)` → `pczt_sign` → `pczt_prove` → `pczt_send`. That moves it into the shielded pool.
  3. Show "Shielding 0.0x ZEC…" in the wallet card until the next sync shows it shielded. Do it silently otherwise; no prompt.
  - Never spend from the transparent pool. Deposits to Zeep and all wallet sends go from shielded funds (`pczt_create` from the shielded balance only), so they don't link the user's addresses.
  - The Receive screen shows the **unified address** (`get_current_address(0)`). Show the transparent address (`get_current_address_transparent()`) only behind "My exchange can't send to this address", with the note "ZEC sent here is shielded automatically".
- **Three amounts, shown in two places:**
  - **Wallet** (wallet card only): ZEC in the user's own in-app Zcash wallet, before it is deposited.
  - **Zeep balance** (header, in credits): dollar notes + ZEC notes at the live price. See section 7.

## 4. Proof worker (replaces `workers/proof.worker.ts`)

- In a module Web Worker, run `snarkjs.groth16.fullProve(input, wasmUrl, zkeyUrl)` and return `{ proof, publicSignals }`.
- Fetch `zeep_spend.wasm` and `zeep_spend.zkey` once, check their SHA-256 against `NEXT_PUBLIC_SPEND_*_SHA256`, and refuse to prove on a mismatch.
- Expose it as the SDK's `ProveFn`. One proof takes about 1–2 s. Every request needs one proof (an automatic refill adds one more, occasionally).

## 5. Using the SDK

```ts
import { deriveKeys, seedFromPhrase, NoteBook, ZeepClient, formatCredits, USD, ZEC } from "@/lib/zeep";

const keys = deriveKeys(seedFromPhrase(phrase), process.env.NEXT_PUBLIC_ZEEP_NETWORK as "testnet" | "mainnet");
const book = NoteBook.from(await loadEncrypted("notes"));        // IndexedDB, existing vault crypto
const client = new ZeepClient({
  baseUrl: apiBase(network), keys, book, prove: workerProve,
  onChange: (b) => saveEncrypted("notes", b.toJSON()),
});

// Pay for any request: body must be the exact string sent.
const prices = await client.prices();                            // refresh every refresh_sec
const body = JSON.stringify({ query });
const res = await client.pay("POST", "/v1/search", body, BigInt(prices.routes.search.micro_usd)); // $0.01045
```

- Before showing the balance after unlock, call `client.refreshSpent()`, so notes spent on another device drop out.
- `pay()` handles everything: merging notes, change, replays and network errors (it looks for its own outputs in the tree), putting money back if an upstream fails, and **refilling the dollar balance from ZEC** when it runs low (below).

**Staged refill (automatic, inside `pay()`).** The server never sees balances, so the schedule runs in the SDK, using `config.split.refill`:

- When the dollar balance would fall to **5%** (`at_bps`) of its last top-up, the SDK converts **50%** (`convert_bps`) of the ZEC balance to dollars (minus 1.5%), at the live price.
- The next time, it converts 50% of what's left. The **3rd** stage (`final_stage`) converts all remaining ZEC.
- A new deposit resets the stages. If the dollars can't cover a payment, it runs further stages right away.
- It costs one extra proof (about 1–2 s) before that payment. Show nothing special; the credits total barely moves (only the 1.5% fee).
- `book.refill` (`{ base, stage }`) is part of `book.toJSON()`, so it's saved with the notes.
- The settings screen can offer a manual "Convert ZEC to credits" using `client.convertToUsd(zats)`. Not required.

## 6. Deposits: any ZEC amount, split 50/50

- On the Deposit screen the user types an amount in ZEC. Show live what it adds, using `estimateDeposit(zats, prices.zec_usd, config.split.zec_share_bps, config.deposits.fee_bps)`:
  - "≈ 24.81 credits": `totalMicro` in credits.
  - Small print: "0.25 ZEC kept as ZEC · 0.25 ZEC → $12.31 (1.5% conversion fee)". Mark it as an estimate: the dollar half is fixed when the deposit confirms.
- `client.startDeposit(parseZec(amount))` returns a **fresh address for this deposit**. No memo is needed, so any wallet works.
- Then:
  - **Pay from the in-app wallet** (default when it has funds): build a PCZT from the **shielded** balance to that address for that amount, sign, prove, send. If the shielded balance is short but transparent funds exist, auto-shield first (section 3), then pay.
  - **Or pay from another wallet**: show a ZIP-321 QR with the address and amount (`lib/zcash/zip321.ts`, minus the memo).
- Poll `client.depositStatus(slot)` and show *waiting → confirming n/3 → credited*.
- When credited, show the breakdown from `credited`:
  - ZEC received (`zec_zats`) at `zec_usd`;
  - **kept as ZEC**: `zec.amount_zats`;
  - **converted**: `usd.converted_zats` → `usd.value_micro_usd`, minus the fee `usd.fee_micro_usd`, plus the network fee back if it was the first deposit today (`usd.rebate_micro_usd`) = `usd.amount_micro_usd`.
  - Whatever ZEC actually arrives is what's credited.

## 6b. Fees, withdrawals and the processing state

- **Fees** (`GET /v1/fees`). Fees apply only to what is converted:
  - Services: the price already includes 4.5%.
  - Deposits: the ZEC half is free; 1.5% on the converted half. The first deposit of the user's UTC day also gets its network fee back.
  - Refills (ZEC → dollars): 1.5% of what's converted.
  - Withdrawals: ZEC paid from the ZEC balance has **no conversion fee**. Credits converted back to ZEC pay 1.5%. The two payout network fees (`withdrawal.network_fee_zats`, about $0.01) are the user's, except on the first withdrawal of the day when Zeep pays them. Show "Network fees: covered (first today)" or the amount. Use `free_network_fees_available`, and remember the last free day locally.
- **Withdraw screen.** The user enters an amount in **ZEC** (with its credit value shown beside it), or taps **Max**.
  1. Call `client.planWithdrawal(parseZec(amount))` (or `planWithdrawal("all")` for Max).
  2. **`needsConversion: false`** (the ZEC balance covers it): show the amount and network fee, then send. Status is `scheduled` straight away.
  3. **`needsConversion: true`** (more than the ZEC balance): show a **confirmation prompt** before anything is sent:
     - "Your ZEC balance covers X ZEC. To withdraw the rest, Y credits will be converted back to ZEC (fee Z credits, 1.5%). This takes 20–60 minutes; the ZEC arrives shielded and is sent automatically."
     - Buttons: **Convert and withdraw** / Cancel.
     - On confirm, **re-authenticate** with whatever the user unlocks the app with (PIN, passkey, or the recovery phrase). Only after that succeeds, call `client.withdraw(plan, address, opts)`.
  4. Show `estimatedZats` as "≈ … ZEC"; with a conversion, the final amount depends on the conversion rate.
  - The total must be worth at least `config.withdrawals.min_micro_usd` ($1); a converted part is at least $1 too (the plan rounds up).
  - The address field accepts shielded addresses (u1/zs, or utest/ztestsapling on testnet).
  - A **transparent address** (t1/t3, or tm/t2 on testnet) needs an explicit checkbox: "I understand the amount and recipient will be public". Pass `{ allowTransparent: true }` to `client.withdraw` and show the `warning` text from the response.
- **Processing message (withdrawals that convert credits):**
  - The response has `status: "converting"` and `processing.message`: "Processing: converting your credits back to ZEC (Tempo → Base → Zcash). This usually takes 20–60 minutes; the ZEC is shielded on arrival and sent to you automatically."
  - Show it with a spinner and poll `GET /v1/withdrawals/:id` every 30 s. The status goes `converting` → `scheduled` (shows `zec_received_zats`) → `paying` → `done`, with a txid on each of the two tranches.
  - ZEC-only withdrawals skip `converting` (`processing.converting` is false).

## 7. Credits: everything the user owns

- `client.balances()` returns `{ usd, zec }`: micro-USD and zats.
- **Header:** `formatCredits(client.totalMicroUsd(prices.zec_usd), config.units.micro_usd_per_credit)` followed by `cr`, up to 4 decimals. Refresh it when prices refresh. The total moves a little with ZEC's price because half of it is ZEC.
- **Tooltip / balance details:**
  - "Credits (dollars): $12.31" → `formatUsd(usd)`
  - "ZEC: 0.25 ZEC ≈ $12.50" → `formatZec(zec)` and its value
  - "Total: 24.81 cr"
  - Don't mention Tempo, USDC.e, bridges or EVM anywhere.
- Prices from `/v1/prices` come in `micro_usd` and `credits`, so they can be fractional (for example `0.0105 cr` for a search). Every amount sent to the API is in micro-USD (services) or zats (withdrawals). Convert only for display.

## 8. Chat section redesign

The current `AiScreen.tsx` is a single column. Rebuild it as `components/chat/*` with a Claude-style layout.

**Layout (responsive at every width)**

- **≥ 1024 px:** a fixed **left sidebar**, 272 px wide:
  - "New chat" button
  - search field
  - chat history grouped Today / Yesterday / Previous 7 days / Older
  - settings gear at the bottom
- **Main column** (max 768 px, centered): message thread, with the **composer pinned to the bottom**.
- **640–1023 px:** the sidebar collapses to an icon rail, and a toggle expands it as an overlay.
- **< 640 px:** the sidebar is a full-height drawer opened from the menu button in the chat header. The composer stays fixed to the bottom above the safe area (`env(safe-area-inset-bottom)`), and the message list scrolls behind it.
- Use the existing tokens (`--bg`, `--surface`, `--raised`, `--line`, `--gold`) and Radix Dialog for the drawer. No horizontal scroll at 320 px.

**Composer**

- Auto-growing textarea. Enter sends, Shift+Enter makes a new line.
- **Paperclip button** with drag-and-drop and paste. It shows attachment chips (name, size, remove).
- **Model picker** button to the left of Send. It shows the current model name **without a price**.
- **Model label under each reply.** Below every AI reply, outside the message bubble, show a small muted line with the model that wrote it, for example "GPT-OSS 20B". Store the model id on each assistant message (`{ role, content, model }`) so the label stays right after the user switches models, and when old chats are reopened. Show no price here.
- **Send** button with **no price on it**.

**Model picker (the only place prices appear)**

- Radix Dropdown or Popover listing `prices.models`. Each row shows name, one-line detail, a "reads images" badge if `vision`, and the **price per response in credits** (with the ZEC value in a tooltip).
- At the bottom, a note: "Attachments over 64 KB add X cr per MB".
- After a model is chosen, the price is **not repeated** anywhere in the chat. The balance in the header simply drops after each response.

**Uploads**

- **Images** (png, jpeg, webp, gif) can **always** be uploaded: from the paperclip, by drag-and-drop, by pasting a screenshot, and on phones from the camera or photo library (`<input type="file" accept="image/*" multiple>`).
  - Show a thumbnail chip for each image, with a remove button.
  - Send each image as an OpenAI `image_url` part with a `data:` URL. Downscale it in a canvas first, to 2048 px on the longest side, as JPEG or WebP.
  - If the selected model can't read images (no `vision`), switch the picker to the cheapest model with `vision` (on testnet that's Qwen3 VL 30B), and show the toast "Switched to Qwen3 VL 30B to read your image". The user can switch back once the image is removed. Never send an image to a model without `vision`; the server rejects it with 400.
- **Text and code** (txt, md, csv, json, js/ts/py and similar): read in the browser and send as a `text` part prefixed with `File: name`.
- **PDF:** extract the text in the browser with `pdfjs-dist` (in its worker) and send it as a text part.
- Total request body must be ≤ `prices.attachments.max_body_mb` (20 MB). Downscale large images in a canvas first.
- Files never go anywhere except inside the paid request. Nothing is uploaded separately.

**Images and files live on the user's device only**

This covers everything the user attaches (images, PDFs, text, code) and everything the AI produces as a file: generated images, code blocks the user saves, exports, and similar.

- **Storage.** Keep each file as its own encrypted record in IndexedDB: AES-GCM with `keys.vaultKey`, in an `attachments` store keyed by a random id. Store the original bytes plus a small encrypted thumbnail for images. Messages hold only a reference: `{ type: "file", id, name, mime, size }`.
- **Never synced, never stored on the server.** Chat sync sends the message text and file references only, never file bytes or thumbnails. The server receives a file only inside the one paid request that needs it, and forwards it to the model without saving it.
- **On another device**, or after signing back in, a reference whose file isn't on this device shows a placeholder: "Image (photo.jpg) is on another device".
- **Sending again.** When a chat continues, the app re-reads earlier files from IndexedDB for the request, if they're still in the context it sends.
- **Every file chip and AI-made file** has **Download** (and **Share** on phones, via the Web Share API) so the user can save it outside the app.
- **Limits.** Call `navigator.storage.persist()` once after sign-in so the browser doesn't evict the files. Show storage used in Settings (`navigator.storage.estimate()`), with **Delete all files** and a per-chat delete.
- **Deleting a chat** deletes its files. The 30-day auto-delete removes files with their chats. Sign-out deletes them all, after the warning in section 2b.
- **Cost of a message:** `model.micro_usd + ceil(max(0, bodyBytes − 65536) / 1 MiB) × attachments.micro_usd_per_mb`. Pass this as the cost to `client.pay`.

**Streaming**

- Send `stream: true`. The response is OpenAI-style SSE: lines starting with `:` are heartbeats, so ignore them, and read text from `choices[0].delta.content`.
- Update `lib/api/sse.ts` to match.
- On 402 with code `insufficient`, show "Add funds" linking to Deposit.

**History: private, untraceable**

- Each chat is one object `{ id, title, model, createdAt, updatedAt, messages }`, encrypted with **AES-GCM using `keys.vaultKey`** and stored in IndexedDB. Titles come from the first user message, made on the device. No server call is used to generate titles.
- **Optional sync** (settings toggle "Sync chats across devices", off by default):
  - `PUT /v1/vault/items/chat-{id}` with headers `x-vault-id: keys.vaultId` and `x-vault-auth: keys.vaultAuth`, and body `{ blob: base64(ciphertext), expires_at }`. The vault id goes **only** in the header, never in the URL (router logs would link every request).
  - On restore, pull them with `GET /v1/vault/items` and then `GET /v1/vault/items/{item}` (same two headers).
  - The server only ever sees ciphertext, and never images or files (they stay on the device; see "Images and files" above).
- **Settings panel** (gear in the sidebar):
  - **"Auto-delete chats after 30 days"** toggle (`NEXT_PUBLIC_CHAT_AUTODELETE_DEFAULT`). When it is on:
    - on load and every hour, delete local chats with `updatedAt < now − 30 days`;
    - set `expires_at = updatedAt + 30 days` on every synced item, which the server purges hourly and hides immediately once expired.
  - "Delete all chats": clears IndexedDB and calls `DELETE /v1/vault` (same two headers).
  - "Sync across devices" toggle.
- Locking the vault clears decrypted chats from memory.

## 9. Config files you need

| File | Change |
| --- | --- |
| `next.config.ts` | Add `Cross-Origin-Opener-Policy: same-origin` (already there) **and `Cross-Origin-Embedder-Policy: require-corp`** for WebZjs threads. In the CSP: `connect-src` adds both API URLs and both lightwalletd gRPC-web URLs; `worker-src 'self' blob:`; `script-src 'self' 'wasm-unsafe-eval'`; `img-src 'self' data: blob:` (attachment previews). Add long-cache headers for `/circuits/*`. |
| `.env.example` / `.env.local` / Vercel env | Add `NEXT_PUBLIC_ZEEP_NETWORK=testnet` (or `mainnet`; one Vercel deployment per network), `NEXT_PUBLIC_AUTOSHIELD_MIN_ZATS=100000`, `NEXT_PUBLIC_SPEND_WASM_URL=/circuits/zeep_spend.wasm`, `NEXT_PUBLIC_SPEND_WASM_SHA256`, `NEXT_PUBLIC_SPEND_ZKEY_URL=/circuits/zeep_spend.zkey`, `NEXT_PUBLIC_SPEND_ZKEY_SHA256`, `NEXT_PUBLIC_LIGHTWALLETD_URL_TESTNET`, `NEXT_PUBLIC_LIGHTWALLETD_URL_MAINNET`, `NEXT_PUBLIC_RECOVERY_WORDS=24`, `NEXT_PUBLIC_MAX_UPLOAD_MB=20`, `NEXT_PUBLIC_CHAT_AUTODELETE_DEFAULT=false`, `NEXT_PUBLIC_CHAT_SYNC_DEFAULT=false`. Remove `NEXT_PUBLIC_RLN_*`, `NEXT_PUBLIC_PAY_ADDRESS_*` and `NEXT_PUBLIC_ACTIVATION_POLL_SEC`. |
| `public/circuits/` | `zeep_spend.wasm` and `zeep_spend.zkey` from the backend's `npm run circuits`. Pin their hashes in the env vars above. **The circuit changed** (it now has an `asset` input), so replace any older copies. |
| `public/webzjs/` (or the vendored package) | The WebZjs wallet build (`webzjs_wallet.js`, `.wasm`, `snippets/`). |
| `package.json` | Add `snarkjs`, `poseidon-lite`, `pdfjs-dist`. Keep `@noble/hashes`, `@scure/bip39` and `idb`. Add the vendored WebZjs wallet. |
| `tsconfig.json` | Add `"webworker"` to `lib` for the worker files. Add a `snarkjs` type shim (see the backend's `src/types.d.ts`). |
| `workers/spend.worker.ts` | The new prover (section 4). |
| `workers/wallet.worker.ts` | Hosts WebZjs (sync and proving run off the main thread). |
| `lib/zeep/` | Copy of the backend `sdk/` folder. |
| `vercel.json` (optional) | Only needed if headers aren't set in `next.config.ts`. Same COOP/COEP and `/circuits` cache rules. |

## 10. API changes (old → new)

| Old frontend call | New endpoint |
| --- | --- |
| `GET /v1/series/:id/leaves`, `/tags` | `GET /v1/trees/:id/leaves?from=` (SDK handles it) |
| `POST /v1/ai/chat` | `POST /v1/ai/chat/completions` (OpenAI format, `stream`, content parts) |
| `POST /v1/refund` | `POST /v1/withdrawals` via `client.planWithdrawal(zats)` + `client.withdraw(plan, address, { allowTransparent })`: from the ZEC balance first (scheduled at once); beyond it, credits are converted back after the prompt (`converting`, 20–60 min). Paid as ZEC to a shielded or (opt-in) transparent address in two tranches 10 minutes apart |
| `GET /v1/refund/:id` | `POST /v1/withdrawals/status` `{ withdrawal_id }` via `client.withdrawalStatus(id)` (ids stay out of URLs) |
| `POST /v1/agents` | `POST /v1/notes/spend` with a transfer output to the agent's key (see `SpendPlan.transfer` in `sdk/spend.ts`) |
| `POST /v1/inbox` (`{action}`) | `POST /v1/inbox` (empty body), `GET /v1/inbox/:inbox_id/messages` |
| `GET /v1/chain` / `chain/call` | `POST /v1/rpc/:chain` (JSON-RPC) |
| (new) | `GET /v1/prices`, `GET /v1/fees`, `POST /v1/deposits` (the SDK adds the anti-spam `pow`), `POST /v1/deposits/status` `{ intent_id }`, `POST /v1/convert/to-usd` (refills; the SDK calls it), `POST /v1/nullifiers/buckets`, `/v1/vault/*` |

**Never put an intent id, withdrawal id or vault id in a URL path or query string.** Always go through the SDK methods above.

Every paid response carries `X-Zeep-Notes: tree:i0,i1` and `X-Zeep-Cost`. The SDK reads them.
