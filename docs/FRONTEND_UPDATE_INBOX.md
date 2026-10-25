# Frontend update: anonymous inbox (send, reply, read, delete)

For the agent working in `Zeep-front`. The backend now supports the full inbox:

- create;
- list;
- read one message in full;
- send;
- reply;
- delete.

**Re-copy `sdk/client.ts` from the backend over `lib/zeep/client.ts`**, then build the Inbox page on the methods below. Don't call the routes by hand.

## Breaking change

`GET /v1/inbox/:id/messages` is **gone**. It put the inbox id, a bearer secret, in the URL, where router logs record it. Every inbox call is now a POST with the id in the body. The SDK methods below handle this.

**Never** put an inbox id in a URL, a route param, analytics or logs. Keep the user's inbox ids in the encrypted vault, as before.

## SDK methods (`ZeepClient`)

| Method | Cost | Returns |
| --- | --- | --- |
| `createInbox()` | `routes.inbox` (30 days) | `{ inbox_id, address, expires_at }` |
| `inboxMessages(inboxId, { cursor?, limit? })` | free | `{ address, expires_at, messages: InboxMessageItem[], next_cursor }` |
| `readMessage(inboxId, messageId)` | free | `InboxMessage`: the full letter. Marks it read. |
| `sendEmail(inboxId, { to, cc?, subject, text?, html? })` | `routes.inbox_send` | `{ message_id, thread_id }` |
| `replyEmail(inboxId, messageId, { text?, html?, replyAll? })` | `routes.inbox_send` | `{ message_id, thread_id }` |
| `deleteMessage(inboxId, messageId)` | free | `{ deleted: true, removed_at_provider }` |

Read the prices from `GET /v1/prices` (`routes.inbox`, `routes.inbox_send`); don't hard-code them. Each paid call is a normal spend proof, the same as search, so it uses the same "this costs X credits" confirm pattern.

## Building the page

- **List.** The list shows `from`, `subject`, `preview` (at most 200 characters), `received_at`, and `read` in bold or normal. Page with `next_cursor`. Refresh on focus or with a refresh button rather than a tight loop; reads are limited to about 240 an hour per inbox.
- **Reading pane.** Call `readMessage()` when a message is opened. `preview` is only a snippet; the full letter is `text` / `html`.
- **Untrusted HTML.** `html` comes from whoever sent the email. Render it in a sandboxed `<iframe sandbox="" srcdoc=…>`: no `allow-scripts`, no `allow-same-origin`.
  - Block remote images by default; they track opens. Offer a "Load images" button.
  - Fall back to `text` when `html` is null.
  - Never put email HTML into the app's DOM with `dangerouslySetInnerHTML`.
- **Attachments.** `attachments` lists file names and sizes only. Downloading them isn't supported yet, so show them as plain labels.
- **Compose and reply.** The form has To, Cc, Subject and Body.
  - There's a limit of 10 recipients in total. Only plain addresses are allowed (`name@example.com`), not `Name <name@example.com>`.
  - Send plain `text`. Add `html` only if you build a rich editor, and keep it under 256 KB.
  - Reply opens with the original quoted underneath, read-only, and a "Reply all" toggle.
- **Send errors** (the payment is not taken for these):
  - `400`: a bad address, too many recipients, or an empty body. Show the message.
  - `429 rate_limited`: an inbox can send 20 emails a day. Show "Daily sending limit reached, try again tomorrow".
- **Delete.** Remove the message from the list right away. `removed_at_provider: false` is normal: Zeep still hides it, and the provider's copy goes when the inbox expires.
- **Expiry.** Show `expires_at` ("Inbox expires in N days"). After expiry every call returns 404 `inbox not found or expired`. Drop that inbox from the vault.

## Types

```ts
interface InboxMessageItem { id: string; thread_id: string | null; from: string; to: string[]; subject: string; preview: string; received_at: string; read: boolean }
interface InboxMessage extends InboxMessageItem { cc: string[]; reply_to: string[]; text: string | null; html: string | null; attachments: { filename: string; content_type: string; size: number }[] }
```

## Check

1. `npm run build` passes, and `grep -rn "/v1/inbox/" app lib` finds no inbox id put into a URL.
2. On testnet with mock services, a new inbox shows one welcome message.
3. Opening it shows the full letter in the sandboxed pane.
4. Send and reply each charge `routes.inbox_send`.
5. Delete removes the message from the list.
