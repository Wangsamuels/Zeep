# Frontend update: frontier models priced per request

For the agent working in `Zeep-front`. **Needed before mainnet AI works:** without it, most chat requests are refused with `402 underpaid`.

Mainnet now offers 10 frontier models through the MPP OpenRouter gateway:

| Company | Model |
| --- | --- |
| Anthropic | Claude Sonnet 5.5, Claude Opus 5.5 |
| OpenAI | GPT-6.1 Sol, GPT-6 Astra |
| Google | Gemini 4 Argon |
| xAI | Grok 4.7 |
| DeepSeek | DeepSeek V4 Pro (no images) |
| Alibaba | Qwen 3.8 Max |
| Moonshot | Kimi K3.1 Pro |
| Zhipu | GLM 5.3 Prime (no images) |

Users pay for every reply from their own balance, from the first one.

These models have no single per-reply price any more. A reply costs the input size times the input rate, plus the output cap times the output rate, with a minimum. That's how the gateway charges Zeep, so long chats cost more and short ones less.

## 1. Re-copy the SDK

Copy the backend `sdk/client.ts` over `lib/zeep/client.ts`, and keep your extra `fund()` method. It adds `chatCostMicro(sheet, modelId, rawBody)`.

## 2. Pay the exact price for each chat request

```ts
const sheet = await client.prices();            // cache it; refresh every minute
const raw = JSON.stringify(body);               // the exact string you send
const cost = chatCostMicro(sheet, body.model, raw);
const res = await client.pay("POST", "/v1/ai/chat/completions", raw, cost);
```

- Compute the cost from **the same `raw` string** you send. It covers every message in the history you include.
- Works for both kinds of model: models with `metered: null` keep the old flat price plus attachment MB.
- Images don't add per-byte cost (each counts as a fixed allowance), so attaching photos stays cheap.

## 3. Show prices only in the model options

- **Model options:** when the user opens the model options to pick a model, show each model's price next to its name. Use `model.micro_usd`, the price of a short question at the default output cap, as "from 0.043 cr". For example, GPT-6 Astra is "from 0.214 cr" and DeepSeek V4 Pro "from 0.017 cr".
- **While chatting: no price on screen.** Once a model is selected and the user is chatting, don't show the price next to Send, under messages or anywhere else. Compute the exact cost with `chatCostMicro(...)` and pay it silently. The charge still shows in the wallet's history.
- **Optional:** a "Longer answers" toggle in the model options that sends `max_tokens: 16000`. It costs more, and the server caps it at `metered.max_output`. If you add it, show its price in the model options too.

## 4. Other notes

- On a model without `vision` (DeepSeek, GLM), disable image upload. The server refuses images for these models.
- A `503 upstream payment was not accepted` means Zeep's provider float is empty. The user's payment comes back as a new note automatically (`compensation` in the error). Show "Busy, try again in a few minutes; you were not charged."

## 5. Daily spending limit (user setting)

Each user has their own daily limit on paid services (AI, search, research, inbox, health). It's **$5 by default**. The limit lives on the user's device, saved with their note book, because Zeep has no accounts and the server can't link a user's payments together.

```ts
client.dailySpending();                 // { limit, spent, left }  micro-USD; left = null when there's no limit
await client.setDailyLimit(20_000_000n); // $20 a day;  0n = no limit
```

- **Settings → "Daily spending limit":** an amount field, default $5, with "No limit" as an option. Show "Spent today: $x of $y" there, and only there.
- When a request would go over the limit, `pay()` throws `ZeepApiError` code `daily_limit` before anything is spent. Show "You've reached your daily limit ($y). Raise it in Settings or try again after midnight UTC."
- Only payments that went through count: a refunded or refused request doesn't.
- The limit applies per device. When the user signs in with their 24 words on a new device, it starts at $5 again unless the app restores it from the encrypted vault settings. Store it there with the other settings if you sync settings.

## 6. Switching models mid-chat

The app already keeps the conversation when the user picks another model. `send()` sends the chat's full history to whichever model is selected, and each reply keeps its model label. Keep it that way: never clear or restart the chat on a model change.

The server now handles the two cases that used to break a switch:

- **Earlier images, text-only model** (DeepSeek V4 Pro, GLM 5.3 Prime): the request goes through. The server replaces each earlier image with a short note telling the model an image was there. Only an image in the **new** message is refused. Your existing auto-switch to a vision model when attaching an image is still right.
- **Chat longer than the new model's context:** refused with `400 context_too_long` **before** any payment. The response includes `max_input_tokens`. Drop the oldest messages (keep any system message), or suggest "Start a new chat", and send again. Every current model allows 500k–1M tokens, so this is rare.

## Check

1. `npm run build` passes.
2. On mainnet, a short and a long chat both get a reply.
3. The price shows only in the model options, not while chatting, and the wallet history shows each reply's exact charge.
4. With the daily limit set to $0.05, the second Sonnet reply is refused on the device and nothing is charged.
5. A chat that started on Claude with a photo, then switched to DeepSeek, gets an answer that uses the earlier messages.
