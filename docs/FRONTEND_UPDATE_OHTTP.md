# Frontend update: send every API call through Oblivious HTTP

For the agent working in `Zeep-front`.

## Why

Today the relay (Cloudflare) decrypts every request, so it sees the user's IP next to their chats, searches, mail, vault ids and payment proofs.

With Oblivious HTTP (OHTTP), the app encrypts each request to a key that only Zeep's server holds, then posts it through the relay:

| | Sees the IP | Sees the request or reply |
| --- | --- | --- |
| Relay (Cloudflare) | yes | no: an encrypted blob posted to `/ohttp`, padded to a fixed size |
| Zeep's server | no | yes |

The relay can't tell which route was called. Every request goes to `POST /ohttp` and is padded to the same size buckets. Streamed AI replies arrive in timed, padded batches, so the relay can't count tokens either.

## 1. Dependencies

```bash
npm i @noble/curves@^1.9.7 @noble/ciphers@^1.3.0
```

`@noble/hashes` is already installed.

## 2. Copy the SDK

Copy these files from the backend `sdk/` into `lib/zeep/`, replacing what's there and keeping your extra `fund()` method in `client.ts`:

- `ohttp.ts` (new)
- `ohttp-fetch.ts` (new)
- `index.ts`

## 3. The key: a build-time setting, never fetched

Add `NEXT_PUBLIC_OHTTP_KEY_CONFIG` to `lib/config.ts`, one value per network, like the API URLs:

```ts
ohttpKey: {
  testnet: process.env.NEXT_PUBLIC_OHTTP_KEY_CONFIG_TESTNET || "",
  mainnet: process.env.NEXT_PUBLIC_OHTTP_KEY_CONFIG || "",
},
```

**Never load the key from the API** (`/ohttp-keys`). That request goes through the relay, and a relay that hands out its own key could read everything. The key must come with the app's build, which Vercel serves and not Cloudflare.

If the key is missing on mainnet, show "This build is missing its privacy key" and make no API calls at all. Don't fall back to plain requests.

## 4. One fetch for every API call

Create `lib/api/zfetch.ts`:

```ts
import { ohttpFetch } from "@/lib/zeep";
import { apiBase, config, type Network } from "@/lib/config";

const cache = new Map<Network, typeof fetch>();
/** Use this for EVERY call to the Zeep API. Plain fetch() to the API is a bug. */
export function zeepFetch(network: Network): typeof fetch {
  let f = cache.get(network);
  if (!f) {
    const keyConfig = config.ohttpKey[network];
    if (!keyConfig) throw new Error("This build is missing its privacy key (NEXT_PUBLIC_OHTTP_KEY_CONFIG).");
    f = ohttpFetch({ baseUrl: apiBase(network), keyConfig });
    cache.set(network, f);
  }
  return f;
}
```

Then replace the API calls:

| File | Change |
| --- | --- |
| wherever `new ZeepClient({...})` is built | add `fetch: zeepFetch(network)` |
| `lib/api/client.ts` (line ~43) | `fetch(` → `zeepFetch(network)(` |
| `lib/chat/sync.ts` (5 calls) | same |
| `lib/zcash/birthday.ts` (2 calls) | same |
| `components/screens/SearchScreen.tsx` (the `/v1/jobs/` call) | same |

Leave these alone; they don't call the API:

- `workers/wallet.worker.ts`: the wallet module, plus the light-wallet traffic to `/lwd`;
- `workers/spend.worker.ts`: the proving files from the app's own site.

`zeepFetch` returns a normal `Response`: `.json()`, `.text()`, `.headers` and streaming `.body` all work as before. It refuses any URL outside the API base, so a mistake can't send data in plain text.

The SSE parser in `lib/api/sse.ts` already skips comment lines (`:`). The padding uses them, so keep that behaviour.

## 5. Errors

| Status | Code | Show |
| --- | --- | --- |
| 422 | `ohttp_key` | "Zeep updated its privacy key. Reload the page." |
| 400 | `ohttp_decrypt` | "The request was damaged on the way. Try again." |
| 403 | `ohttp_required` | Only if a plain `fetch()` slipped through: a bug, fix the call. |

If a reply is cut off in transit, reading its body throws instead of returning partial data. Treat it like a network error and retry the free calls. For paid calls, the SDK's existing refund and recovery path applies.

## Check

1. `npm run build` passes, and `grep -rn "fetch(\`\${apiBase" app lib components` finds nothing.
2. In the browser's network tab, the only requests to the relay are `POST /ohttp` and the wallet's `/lwd/...`. No `/v1/...` URL appears anywhere.
3. Chat streams token by token as before, the wallet balance loads, a search can be paid for, and the inbox opens.
4. Once this is live, the backend switches on `REQUIRE_OHTTP=true`, and everything above still works.
