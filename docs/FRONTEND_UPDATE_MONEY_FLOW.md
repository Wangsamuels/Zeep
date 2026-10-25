# Frontend update: money-flow fixes (backend + SDK)

For the agent working in `Zeep-front`. This covers the four issues the testnet money check found. The backend and the SDK now handle all four. **Re-copy the SDK, then remove the app-side workarounds.**

## 1. Re-copy two SDK files

Copy these from the backend `sdk/` over `lib/zeep/`:

- `client.ts`
- `notes.ts`

Don't edit the copies.

## 2. Deposits: poll with `pollDeposits()`

The note book now remembers every deposit slot that is still pending in `book.pendingDeposits`. That includes the claim slot opened when someone pays the same address twice. It is saved with the rest of the book in `toJSON()`.

- Poll with `client.pollDeposits()` instead of tracking slots yourself. It returns a `Map<slot, DepositStatus>`, and a slot leaves the list once it is credited.
- `depositStatus(slot)` returns `claim: { slot, intent_id }` when it opened a claim. You can show "second payment found" for that slot.
- **Remove** any workaround that guessed the claim slot, such as `book.nextDeposit - 1`.

## 3. Deposits: new status `queued`

`DepositStatus.status` has a new value, `"queued"`, with a matching `queued` field:

```ts
queued: { amount_zats: number; reason: "daily_limit" | "crediting"; until: string | null } | null
```

Show it like this:

- **`reason: "daily_limit"`**: "Received. Today's deposit limit is reached, so this is credited automatically after {until, in the user's local time}." Nothing for the user to do.
- **`reason: "crediting"`**: "Received, crediting…". This normally lasts seconds.

A deposit that is waiting this way no longer shows as `expired` or `waiting`.

## 4. Withdrawals: the plan is now net of network fees

`planWithdrawal()` now returns:

- **`estimatedZats`**: what should arrive, **after** the payout network fees. Show this as "You'll receive about …".
- **`networkFeeZats`**: the network fees taken from the ZEC. It is 0 when Zeep is expected to cover them.
- **`networkFeesCovered`**: true when this looks like the first withdrawal of the UTC day (fees covered).

`networkFeesCovered` is an estimate, because another device may already have withdrawn today. After `withdraw()`, the response's `network_fees_paid_by` and `estimated_zec_zats` are final. Show those on the confirmation screen.

`planWithdrawal()` now throws `ZeepApiError` with code `too_small` when a ZEC-only amount can't cover the network fees. Show its message.

**Remove** any app-side subtraction of the network fees. The plan already does it.

## 5. Chat: charge = the published prices added up

The backend now charges exactly:

```
model.micro_usd + extra MB × attachments.micro_usd_per_mb
```

These are the figures from `GET /v1/prices`. Compute the cost that way and drop any workaround that added a micro-USD.

## Check

- `npm run build` passes.
- Pay twice to one deposit address on testnet. Both payments show up without a restore.
- A withdrawal preview matches the amount that arrives.
