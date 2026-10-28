# Frontend handover: send-only email, new prices, exact AI pricing

For the agent working in `Zeep-front`. This covers the backend push "Fix provider prices and endpoints, cap provider payments, price AI from the gateway quote, send-only email".

Nothing here changes how payments, OHTTP or the vault work. Every API call still goes through `zeepFetch` / the SDK.

## 1. Re-copy the SDK (required)

Copy the backend `sdk/client.ts` over `lib/zeep/client.ts`, keeping your extra `fund()` method. The other SDK files are unchanged. The new `client.ts` adds two things:

- **`sendEmailDirect()`**: send an email without owning an inbox (section 2).
- **Exact AI pricing.** The server now prices each AI reply from the AI gateway's own quote for that exact request. On some chats (lots of numbers or code) that's slightly above what `chatCostMicro()` estimates.
  - When that happens, the server refuses the first payment before anything is spent.
  - `pay()` then pays the exact price the server named, once, automatically. It only does this for `/v1/ai/chat/completions`, and only up to 2× the estimate.
  - Nothing changes in the UI; keep paying `chatCostMicro(...)` as now.
  - Without the new `client.ts`, those chats fail with `402 underpaid`. No money is lost, but the user gets an error.

The daily spending limit still applies to the corrected amount.

## 2. Inbox: no wall to start (send-only)

Opening the Inbox page must never require buying an inbox first.

**New SDK method:**

```ts
await client.sendEmailDirect({
  to: "friend@example.com",        // or an array; plain addresses only, max 10 recipients in total
  cc: [],                          // optional
  subject: "Hello",                // required
  text: "…",                       // text and/or html
  replyInboxId: inboxId,           // optional: one of the user's own inboxes, so replies come back there
});
// → { message_id, from: "relay@stableemail.dev", reply_to: string | null }
```

Price: `routes.email_send` from `/v1/prices` (≈ 0.026 credits today). Read it from the price sheet; don't hard-code it.

**What the page should do:**

- **No inbox yet:** show the composer straight away (To, Cc, Subject, Body) with a "Send" button and the price, using the same confirm pattern as search.
  - Under it, one line: "Sent from a shared Zeep address. Recipients can't reply unless you have your own address."
  - Next to it, a secondary button: "Get your own address (2.09 cr) to receive replies", which runs the existing `createInbox()` flow.
- **With an inbox:** keep everything as it is (list, read, send from the inbox, reply). In the composer, add a toggle "Send from: your address / shared address". The shared option calls `sendEmailDirect({ ..., replyInboxId })`, so replies still reach the user.
- **Don't show a fake address or a placeholder inbox.** Until the user buys an address, there's nowhere for mail to arrive, and the page must say so.

**Errors** (nothing is charged for any of these):

| Status | Code | Show |
| --- | --- | --- |
| 400 | `bad_request` | Missing subject or body, a bad address, too many recipients, or an unknown reply inbox. Show the message. |
| 429 | `rate_limited` | "Send-only email is busy today; try again tomorrow, or send from your own address." |
| 503 | `unavailable` | "Couldn't send right now. You were not charged." |

## 3. Prices changed: read them, don't hard-code

These are the provider's real prices plus Zeep's margin. The old ones lost money on every call.

| Route | Before | Now (credits) |
| --- | --- | --- |
| `inbox` (own address, 30 days) | 0.31 | **2.09** |
| `health` | 0.005 | **0.1045** |
| `email_send` (new) | n/a | 0.026 |
| `search`, `research_*`, `inbox_send` | unchanged | unchanged |

`InboxScreen.tsx` and `HealthScreen.tsx` already read `view.prices.routes.*`, so the numbers update by themselves. Check any copy that names a fixed price ("30 cents", "half a cent") and remove it.

**Opening an address can be refused for a while.** It costs Zeep $2.00 upfront from its float. Until the float holds that much, `createInbox()` returns `503 unavailable` with `compensation`; the payment comes straight back as a new note. Show "Addresses are temporarily unavailable. You were not charged. You can still send email." Send-only keeps working.

## 4. Smaller behaviour changes

- **Search:** only Exa now. `provider: "brave"` is still accepted but served by Exa, and the reply says `provider: "exa"`. Remove any Brave option from the UI.
- **Research:**
  - `base` and `core` now return a cited answer almost immediately. The first poll of `/v1/jobs/:id` already says `completed`.
  - `pro` is a multi-hop task: keep polling as today.
  - The result is `{ content: string, citations: [] }`. Render `content` as Markdown.
- **Inbox delete:** AgentMail can't delete single messages. Delete hides the message in Zeep (`removed_at_provider: false`), and the provider's copy goes when the address expires. The UI behaviour doesn't change: remove it from the list.
- **Reply all** now really replies to everyone. The existing checkbox is right.

## 5. Settings unrelated to this push (from the audit)

In Vercel, set:

- `NEXT_PUBLIC_SOURCE_URL`: the "Open source" footer link currently points to `github.com/zeep/zeep`, which isn't Zeep's repo.
- `NEXT_PUBLIC_DOCS_URL`: currently `zeep.app/docs`; set it or hide the link.

## Check

1. `npm run build` passes.
2. With no inbox, the Inbox page shows the composer, and sending to your own email arrives from `relay@stableemail.dev`. The wallet history shows one `email_send` charge.
3. With an inbox, a "shared address" send has `Reply-To` set to your inbox, and a reply to it shows up in the inbox list.
4. Health and inbox prices on screen match `/v1/prices`.
5. A chat pasted with a long table of numbers gets a reply, not a `402`.
6. Research `base` shows its answer on the first poll.
