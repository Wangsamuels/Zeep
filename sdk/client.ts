// ZeepClient: the user's private balances against one Zeep API (testnet or mainnet).
// Two balances: dollar notes (asset 0, micro-USD) pay for services; ZEC notes (asset 1, zats)
// are the user's own ZEC. The app shows both together as credits (ZEC at the live price).
// Holds the note book and tree caches; pays, refills dollars from ZEC, deposits, withdraws,
// restores.
import { nullifierOf, decryptNote, encryptNote, noteFromKeys, NoteBook, ownerTag, USD, ZEC, type Asset, type Note } from "./notes";
import { depositSlot, type ZeepKeys } from "./keys";
import { convertSignal, depositSignal, notesSignal, randomField, requestSignal, withdrawSignal } from "./field";
import { bpsOf, zatsToMicroUsd } from "./units";
import { sha256 } from "@noble/hashes/sha256";
import { utf8ToBytes } from "@noble/hashes/utils";
import { buildSpend, DEPTH, TAG, type Paths, type ProveFn } from "./spend";
import { MerkleTree } from "./tree";

export class ZeepApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly body: unknown) {
    super(message);
  }
}

export interface DepositStatus {
  intent_id: string;
  status: "waiting" | "confirming" | "queued" | "credited" | "expired";
  address: string;
  expected_zats: number | null;
  /** First deposit of your day: Zeep credits your network fee back (usd.rebate_micro_usd). */
  first_today: boolean;
  /** The ZEC received, split into a ZEC note (kept) and a dollar note (converted, minus the fee). */
  credited: {
    zec_zats: number; zec_usd: number; tree: number;
    zec: { amount_zats: number; index: number };
    usd: { converted_zats: number; value_micro_usd: number; fee_micro_usd: number; rebate_micro_usd: number; amount_micro_usd: number; index: number };
  } | null;
  confirming: { amount_zats: number; confirmations: number; needed: number }[];
  /**
   * Confirmed and waiting to be credited. reason "daily_limit": the day's deposit limit is
   * reached and it is credited automatically after `until` (next UTC midnight).
   */
  queued: { amount_zats: number; reason: "daily_limit" | "crediting"; until: string | null } | null;
  unclaimed_zats: number;
  expires_at: string;
  /** Set by depositStatus() when a second payment to this address was moved to a new slot: poll that slot. */
  claim?: { slot: number; intent_id: string };
}

/** A message in the inbox list (short preview only). */
export interface InboxMessageItem {
  id: string;
  thread_id: string | null;
  from: string;
  to: string[];
  subject: string;
  preview: string;
  received_at: string;
  read: boolean;
}
/** A full message. `html` comes from the sender: render it sandboxed (no scripts, no remote loads). */
export interface InboxMessage extends InboxMessageItem {
  cc: string[];
  reply_to: string[];
  text: string | null;
  html: string | null;
  attachments: { filename: string; content_type: string; size: number }[];
}

/** What a withdrawal takes from each balance. */
export interface WithdrawalPlan {
  /** Zats from ZEC notes, paid as they are. */
  zecZats: bigint;
  /** Micro-USD from dollar notes, converted back to ZEC (0 if the ZEC balance covers it). */
  usdMicro: bigint;
  /**
   * True when credits must be converted back to ZEC: the app shows the confirmation prompt
   * (amount, conversion fee, 20–60 min) and re-asks for the PIN / passkey / phrase first.
   */
  needsConversion: boolean;
  conversionFeeMicro: bigint;
  /** What should arrive, after the payout network fees (final amount depends on the conversion). */
  estimatedZats: bigint;
  /** Payout network fees taken from the ZEC (0 when Zeep is expected to cover them). */
  networkFeeZats: bigint;
  /**
   * True when this looks like the first withdrawal of the UTC day and qualifies for covered
   * network fees. It's an estimate: another device may already have withdrawn today, so the
   * server's `network_fees_paid_by` in the withdrawal response is final.
   */
  networkFeesCovered: boolean;
}

interface TreeCache {
  tree: MerkleTree;
  enc: (string | null)[];
  root: bigint;
  closed: boolean;
}

export interface ClientOptions {
  baseUrl: string;
  keys: ZeepKeys;
  book: NoteBook;
  prove: ProveFn;
  fetch?: typeof fetch;
  /** Called whenever notes change, so the app can persist the book (encrypted). */
  onChange?: (book: NoteBook) => void | Promise<void>;
}

const b64json = (v: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(v));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export class ZeepClient {
  readonly keys: ZeepKeys;
  readonly book: NoteBook;
  private trees = new Map<number, TreeCache>();
  private base: string;
  private f: typeof fetch;
  private busy: Promise<unknown> = Promise.resolve();
  private conf: any;
  private verified = false;

  constructor(private o: ClientOptions) {
    this.keys = o.keys;
    this.book = o.book;
    this.base = o.baseUrl.replace(/\/$/, "");
    this.f = o.fetch ?? fetch.bind(globalThis);
  }

  /** Spendable balance of one asset: micro-USD (dollars, default) or zats (ZEC). */
  balance(asset: Asset = USD): bigint {
    return this.book.balance(asset);
  }

  balances(): { usd: bigint; zec: bigint } {
    return { usd: this.book.balance(USD), zec: this.book.balance(ZEC) };
  }

  /**
   * Everything the user owns, in micro-USD at `zecUsd` (from /v1/prices): dollars + ZEC.
   * Divide by micro_usd_per_credit for credits.
   */
  totalMicroUsd(zecUsd: number): bigint {
    const b = this.balances();
    return b.usd + BigInt(zatsToMicroUsd(b.zec, zecUsd));
  }

  // ---------------------------------------------------------------- http
  async api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    // Nothing that carries a key-derived value (intent ids, vault id, proofs) is sent until the
    // server has confirmed it is on the same network as the keys.
    if (!this.verified && path !== "/v1/config") await this.config();
    const res = await this.f(`${this.base}${path}`, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", ...init });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      throw new ZeepApiError(body?.error?.message ?? `HTTP ${res.status}`, res.status, body?.error?.code ?? "http", body);
    }
    return body as T;
  }

  private json(method: string, body: unknown): RequestInit {
    return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  }

  async config() {
    const c = await this.api<any>("/v1/config");
    if (c?.network !== this.keys.network) {
      throw new ZeepApiError(`This server is on ${c?.network}, but these keys are for ${this.keys.network}.`, 0, "wrong_network", c);
    }
    this.conf = c;
    this.verified = true;
    return this.conf;
  }
  prices() {
    return this.api<any>("/v1/prices");
  }
  fees() {
    return this.api<any>("/v1/fees");
  }

  // ---------------------------------------------------------------- anonymous inbox
  // The inbox id is a bearer secret: these methods only ever send it in POST bodies.
  // Keep it in the encrypted vault, not in URLs, analytics or logs.

  /** Paid: create a 30-day inbox (routes.inbox). */
  async createInbox(): Promise<{ inbox_id: string; address: string; expires_at: string }> {
    const cost = BigInt((await this.prices()).routes.inbox.micro_usd);
    return this.paidJson("/v1/inbox", {}, cost);
  }
  /** List messages, newest first. Each has a short `preview`; use readMessage() for the full letter. */
  inboxMessages(inboxId: string, opts: { cursor?: string; limit?: number } = {}): Promise<{ address: string; expires_at: string; messages: InboxMessageItem[]; next_cursor: string | null }> {
    return this.api("/v1/inbox/messages", this.json("POST", { inbox_id: inboxId, cursor: opts.cursor, limit: opts.limit }));
  }
  /** One full message: text, html (untrusted: render sandboxed) and attachment names. Marks it read. */
  async readMessage(inboxId: string, messageId: string): Promise<InboxMessage> {
    return (await this.api<{ message: InboxMessage }>("/v1/inbox/messages/read", this.json("POST", { inbox_id: inboxId, message_id: messageId }))).message;
  }
  /** Paid (routes.inbox_send): send a new email from the inbox. */
  async sendEmail(inboxId: string, mail: { to: string | string[]; cc?: string | string[]; subject: string; text?: string; html?: string }): Promise<{ message_id: string; thread_id: string | null }> {
    const cost = BigInt((await this.prices()).routes.inbox_send.micro_usd);
    return this.paidJson("/v1/inbox/send", { inbox_id: inboxId, ...mail }, cost);
  }
  /** Paid (routes.inbox_send): reply to a message (replyAll adds the other recipients). */
  async replyEmail(inboxId: string, messageId: string, mail: { text?: string; html?: string; replyAll?: boolean }): Promise<{ message_id: string; thread_id: string | null }> {
    const cost = BigInt((await this.prices()).routes.inbox_send.micro_usd);
    return this.paidJson("/v1/inbox/reply", { inbox_id: inboxId, message_id: messageId, text: mail.text, html: mail.html, reply_all: mail.replyAll ?? false }, cost);
  }
  /** Delete a message (free). It disappears from the list at once. */
  deleteMessage(inboxId: string, messageId: string): Promise<{ deleted: true; removed_at_provider: boolean }> {
    return this.api("/v1/inbox/messages/delete", this.json("POST", { inbox_id: inboxId, message_id: messageId }));
  }
  private async paidJson<T>(path: string, body: unknown, cost: bigint): Promise<T> {
    const res = await this.pay("POST", path, JSON.stringify(body), cost);
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new ZeepApiError(j?.error?.message ?? `HTTP ${res.status}`, res.status, j?.error?.code ?? "http", j);
    return j as T;
  }

  // ---------------------------------------------------------------- trees
  private async syncTree(id: number): Promise<TreeCache> {
    let t = this.trees.get(id);
    if (!t) {
      t = { tree: new MerkleTree(DEPTH), enc: [], root: 0n, closed: false };
      this.trees.set(id, t);
    }
    if (t.closed) return t;
    for (;;) {
      const r = await this.api<{ leaves: { c: string; e: string | null }[]; root: string; total: number; closed: boolean }>(
        `/v1/trees/${id}/leaves?from=${t.tree.size}`,
      );
      const leaves = r.leaves.map((l) => BigInt(l.c));
      if (leaves.length) {
        const all: bigint[] = [];
        for (let i = 0; i < t.tree.size; i++) all.push(t.tree.leaf(i)!);
        t.tree.load(all.concat(leaves));
        t.enc.push(...r.leaves.map((l) => l.e));
      }
      t.closed = r.closed;
      t.root = BigInt(r.root);
      if (t.tree.size >= r.total || !r.leaves.length) break;
    }
    return t;
  }

  private async syncAll(): Promise<{ current: number; trees: number[] }> {
    const cfg = await this.config();
    const ids: number[] = [...cfg.trees.closed.map((t: { id: number }) => t.id), cfg.trees.current.id];
    for (const id of ids) await this.syncTree(id);
    return { current: cfg.trees.current.id, trees: ids };
  }

  private paths(current: number): Paths {
    return {
      path: (tree, index) => {
        const t = this.trees.get(tree);
        if (!t || index >= t.tree.size) throw new Error("note not synced");
        return { ...t.tree.path(index), root: t.tree.root() };
      },
      anyRoot: () => this.trees.get(current)!.tree.root(),
    };
  }

  // ---------------------------------------------------------------- spends
  /** Serialize spends: a note can only be in one spend at a time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    return run;
  }

  private async changed() {
    await this.o.onChange?.(this.book);
  }

  private adoptOutputs(header: string | null, built: { change: { rho: bigint; amount: bigint } }, inputs: Note[], asset: Asset) {
    if (!header) return false;
    const [tree, idx] = header.split(":");
    return this.adopt({ tree: Number(tree), indexes: idx.split(",").map(Number) }, built, inputs, asset);
  }

  private adopt(at: { tree: number; indexes: number[] } | null | undefined, built: { change: { rho: bigint; amount: bigint } }, inputs: Note[], asset: Asset) {
    if (!at) return false;
    for (const n of inputs) n.spent = true;
    if (built.change.amount > 0n) this.book.add(noteFromKeys(this.keys, built.change.rho, built.change.amount, asset, at.tree, at.indexes[0], "change"));
    return true;
  }

  /**
   * Prepare inputs of `asset` for `cost`, merging notes first if the money is spread too thin.
   * Returns the inputs (locked) and the synced current tree id.
   */
  private async prepare(cost: bigint, asset: Asset): Promise<{ inputs: Note[]; current: number }> {
    for (let i = 0; i < 8; i++) {
      const { current } = await this.syncAll();
      const pick = this.book.select(cost, asset);
      if (!pick) {
        const unit = asset === USD ? "micro-USD" : "zats";
        throw new ZeepApiError(`Not enough balance: this needs ${cost} ${unit}, you have ${this.book.balance(asset)}.`, 402, "insufficient", null);
      }
      if ("inputs" in pick) {
        pick.inputs.forEach((n) => (n.pending = true));
        return { inputs: pick.inputs, current };
      }
      await this.mergeNow(pick.merge, current);
    }
    throw new Error("could not gather enough notes; try again");
  }

  private async mergeNow(notes: Note[], current: number) {
    notes.forEach((n) => (n.pending = true));
    const asset = notes[0].asset;
    try {
      const built = await buildSpend(this.keys, { asset, inputs: notes, cost: 0n, signal: notesSignal() }, this.paths(current), this.o.prove);
      const res = await this.f(`${this.base}/v1/notes/spend`, this.json("POST", { proof: built.bundle }));
      if (!res.ok) throw new ZeepApiError(`merge failed: HTTP ${res.status}`, res.status, "merge", await res.text());
      this.adoptOutputs(res.headers.get("x-zeep-notes"), built, notes, asset);
      await this.changed();
    } finally {
      notes.forEach((n) => (n.pending = false));
    }
  }

  // ---------------------------------------------------------------- refills (ZEC → dollars)
  /**
   * Staged refill, run before each payment. When the dollar balance would fall to
   * refill.at_bps (5%) of its last top-up, convert refill.convert_bps (50%) of the ZEC
   * balance to dollars; the final stage converts all of it. If the dollars can't cover a
   * payment at all, keep going through the stages. A deposit resets the stages.
   */
  private async ensureUsd(cost: bigint): Promise<void> {
    const r = (this.conf ?? (await this.config())).split.refill as { at_bps: number; convert_bps: number; final_stage: number; min_zats: number };
    for (let guard = 0; guard < r.final_stage + 1; guard++) {
      const usd = this.book.balance(USD);
      const zec = this.book.balance(ZEC);
      const base = BigInt(this.book.refill.base);
      const low = (usd - cost) * 10_000n <= base * BigInt(r.at_bps);
      if (usd >= cost && !low) return;
      if (zec < BigInt(r.min_zats)) return; // nothing (left) to refill from
      const stage = this.book.refill.stage + 1;
      let zats = stage >= r.final_stage ? zec : (zec * BigInt(r.convert_bps)) / 10_000n;
      if (zats < BigInt(r.min_zats) || zec - zats < BigInt(r.min_zats)) zats = zec; // no dust left behind
      try {
        await this.convertNow(zats);
      } catch (e) {
        if (usd >= cost) return; // the refill can wait; this payment is covered
        throw e;
      }
      this.book.refill = { base: this.book.balance(USD).toString(), stage };
      await this.changed();
      if (usd >= cost) return;
    }
  }

  /** Convert `zats` of the ZEC balance to dollars now (the app can offer this as a manual action too). */
  convertToUsd(zats: bigint): Promise<{ amount_micro_usd: number; zec_usd: number; fee_micro_usd: number }> {
    return this.exclusive(() => this.convertNow(zats));
  }

  private async convertNow(zats: bigint): Promise<{ amount_micro_usd: number; zec_usd: number; fee_micro_usd: number }> {
    const conf = this.conf ?? (await this.config());
    const feeBps: number = conf.split.conversion_fee_bps.zec_to_usd;
    const { inputs, current } = await this.prepare(zats, ZEC);
    try {
      const id = crypto.randomUUID();
      const rho = randomField();
      const d = ownerTag(this.keys.pk, rho);
      const px = (await this.prices()).zec_usd as number;
      const value = zatsToMicroUsd(zats, px);
      let amount = value - bpsOf(value, feeBps);
      for (let attempt = 0; ; attempt++) {
        // The proof binds the new note's amount, so a changed amount needs a new proof.
        const built = await buildSpend(this.keys, { asset: ZEC, inputs, cost: zats, signal: convertSignal(id, d, BigInt(amount)) }, this.paths(current), this.o.prove);
        delete built.bundle.compensate;
        const e = await encryptNote(this.keys.noteKey, BigInt(amount), rho, USD);
        const res = await this.f(`${this.base}/v1/convert/to-usd`, this.json("POST", {
          conversion_id: id, mint: { d: d.toString(), e, amount_micro_usd: amount }, proof: built.bundle,
        }));
        const body = await res.json().catch(() => null);
        if (res.status === 409 && body?.error?.code === "price_moved" && attempt < 2) {
          amount = body.error.amount_micro_usd; // the live quote (nothing was spent)
          continue;
        }
        if (!res.ok) {
          if (res.status === 409) await this.refreshSpent();
          throw new ZeepApiError(body?.error?.message ?? `HTTP ${res.status}`, res.status, body?.error?.code ?? "http", body);
        }
        this.adoptOutputs(res.headers.get("x-zeep-notes"), built, inputs, ZEC);
        this.book.add(noteFromKeys(this.keys, rho, BigInt(amount), USD, body.minted.tree, body.minted.index, "refill"));
        await this.changed();
        return body;
      }
    } finally {
      inputs.forEach((n) => (n.pending = false));
    }
  }

  /**
   * Pay for one API request (from the dollar balance, refilling it from ZEC when low) and
   * send it. `body` must be the exact string sent. `costMicroUsd` is the price from
   * /v1/prices. Returns the raw Response (JSON or an SSE stream).
   */
  pay(method: string, path: string, body: string, costMicroUsd: bigint, extraHeaders: Record<string, string> = {}): Promise<Response> {
    return this.exclusive(async () => {
      await this.ensureUsd(costMicroUsd);
      const { inputs, current } = await this.prepare(costMicroUsd, USD);
      try {
        const refundRho = randomField();
        const signal = requestSignal(method, path, body, ownerTag(this.keys.pk, refundRho));
        const built = await buildSpend(this.keys, { asset: USD, inputs, cost: costMicroUsd, signal, refundRho }, this.paths(current), this.o.prove);
        const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
        const b64 = b64json(built.bundle);
        for (let i = 0, n = 0; i < b64.length; i += 7000, n++) headers[n ? `x-zeep-proof-${n}` : "x-zeep-proof"] = b64.slice(i, i + 7000);
        let res: Response;
        try {
          res = await this.f(`${this.base}${path}`, { method, headers, body, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
        } catch (e) {
          await this.reconcile(inputs, built);
          throw e;
        }
        const adopted = this.adoptOutputs(res.headers.get("x-zeep-notes"), built, inputs, USD);
        if (!res.ok) {
          const body = await res.clone().json().catch(() => null);
          const comp = body?.error?.compensation as { tree: number; index: number } | undefined;
          if (comp) this.book.add(noteFromKeys(this.keys, built.refund.rho, built.refund.amount, USD, comp.tree, comp.index, "change"));
          if (!adopted && res.status === 409) await this.refreshSpent();
        }
        await this.changed();
        return res;
      } finally {
        inputs.forEach((n) => (n.pending = false));
      }
    });
  }

  /** After a network error we can't tell if the spend landed: look for our outputs in the tree. */
  private async reconcile(inputs: Note[], built: { change: { rho: bigint; amount: bigint; commitment: bigint } }, asset: Asset = USD) {
    const { trees } = await this.syncAll();
    for (const id of trees) {
      const t = this.trees.get(id)!;
      for (let i = t.tree.size - 1; i >= Math.max(0, t.tree.size - 2000); i--) {
        if (t.tree.leaf(i) === built.change.commitment) {
          inputs.forEach((n) => (n.spent = true));
          if (built.change.amount > 0n) this.book.add(noteFromKeys(this.keys, built.change.rho, built.change.amount, asset, id, i, "change"));
          await this.changed();
          return;
        }
      }
    }
  }

  // ---------------------------------------------------------------- deposits
  /**
   * Reserve a fresh deposit address. The user can send any amount to it, from any wallet
   * (the in-app wallet shields first; see the handover). On confirmation it becomes two notes:
   * zec_share_bps kept as ZEC, the rest converted to dollars. With `dailyTag` (default) a small
   * zero-value proof reveals today's deposit tag, so the first deposit of the day gets its
   * network fee credited back.
   */
  async startDeposit(expectedZats?: bigint, claimFrom?: string, dailyTag = true): Promise<DepositStatus & { slot: number }> {
    const slot = this.book.nextDeposit;
    const { intentId, d, dZec } = depositSlot(this.keys, slot);
    let proof: unknown;
    if (dailyTag && !claimFrom) {
      const { current } = await this.syncAll();
      const built = await buildSpend(this.keys, { asset: USD, inputs: [], cost: 0n, signal: depositSignal(intentId, d), daily: TAG.depositRebate }, this.paths(current), this.o.prove);
      delete built.bundle.compensate;
      proof = built.bundle;
    }
    const bits: number = (this.conf ?? (await this.config())).deposits.pow_bits ?? 0;
    const st = await this.api<DepositStatus>("/v1/deposits", this.json("POST", {
      intent_id: intentId, d: d.toString(), d_zec: dZec.toString(), expected_zats: expectedZats ? Number(expectedZats) : undefined, claim_from: claimFrom, proof,
      pow: bits > 0 ? solvePow(intentId, bits) : undefined,
    }));
    this.book.nextDeposit = slot + 1;
    if (st.status !== "credited" && !this.book.pendingDeposits.includes(slot)) this.book.pendingDeposits.push(slot);
    await this.changed();
    return { ...st, slot };
  }

  /**
   * Poll a deposit; adds its two notes to the book when it lands (and resets the refill stages).
   * If a second payment reached the same address, it opens a claim on a new slot, returns it as
   * `claim` and keeps polling it via pollDeposits() (it's in book.pendingDeposits).
   */
  async depositStatus(slot: number, opts: { claim?: boolean } = {}): Promise<DepositStatus> {
    const { intentId, rho, rhoZec } = depositSlot(this.keys, slot);
    const st = await this.api<DepositStatus>("/v1/deposits/status", this.json("POST", { intent_id: intentId }));
    const c = st.credited;
    if (c) {
      const usd = noteFromKeys(this.keys, rho, BigInt(c.usd.amount_micro_usd), USD, c.tree, c.usd.index, `deposit:${slot}`);
      const zec = noteFromKeys(this.keys, rhoZec, BigInt(c.zec.amount_zats), ZEC, c.tree, c.zec.index, `deposit-zec:${slot}`);
      const fresh = !this.book.notes.some((n) => n.commitment === usd.commitment);
      if (c.usd.amount_micro_usd > 0) this.book.add(usd);
      if (c.zec.amount_zats > 0) this.book.add(zec);
      if (fresh) this.book.refill = { base: this.book.balance(USD).toString(), stage: 0 };
    }
    const settled = st.status === "credited" || (st.status === "expired" && !st.confirming.length && !st.queued);
    if (settled && this.book.pendingDeposits.includes(slot)) this.book.pendingDeposits = this.book.pendingDeposits.filter((s) => s !== slot);
    // Keep an eye on a credited address for a while: a second payment to it needs a claim.
    if (st.status === "credited" && this.book.watchedDeposits[slot] === undefined) this.book.watchedDeposits[slot] = Date.now() + WATCH_MS;
    if (c || settled) await this.changed();
    if (st.unclaimed_zats > 0 && opts.claim !== false) {
      // Money sent twice to one address: move it to a new slot and poll that one too.
      const claim = await this.startDeposit(undefined, intentId);
      return { ...st, claim: { slot: claim.slot, intent_id: claim.intent_id } };
    }
    return st;
  }

  /** Poll every deposit still pending (including claims). Returns the statuses by slot. */
  async pollDeposits(): Promise<Map<number, DepositStatus>> {
    const out = new Map<number, DepositStatus>();
    for (const slot of [...this.book.pendingDeposits]) out.set(slot, await this.depositStatus(slot));
    // Credited addresses: every 10 minutes, look for a second payment (claimed into a new slot).
    const now = Date.now();
    if (now - this.book.lastWatchCheck >= WATCH_EVERY_MS) {
      this.book.lastWatchCheck = now;
      for (const [k, until] of Object.entries(this.book.watchedDeposits)) {
        const slot = Number(k);
        if (until < now) {
          delete this.book.watchedDeposits[slot];
          continue;
        }
        if (!out.has(slot)) out.set(slot, await this.depositStatus(slot));
      }
      await this.changed();
    }
    return out;
  }

  // ---------------------------------------------------------------- withdrawals
  /**
   * Plan a withdrawal of `zats` (what leaves the balances, before network fees). The ZEC
   * balance is used first. Anything above it is taken from credits (dollar notes) and
   * converted back to ZEC: `needsConversion` is then true and the app must show the
   * confirmation prompt and re-authenticate before calling withdraw(plan, ...).
   * `zats = "all"` withdraws everything (ZEC + all credits).
   */
  async planWithdrawal(zats: bigint | "all"): Promise<WithdrawalPlan> {
    const gross = await this.planGross(zats);
    // Payout network fees, as the server will apply them: paid by the user unless this is the
    // first withdrawal of the UTC day, the tagged (larger) part is worth enough and Zeep's
    // fee budget has room.
    const [fees, px] = [await this.fees(), (await this.prices()).zec_usd as number];
    const feeZats = BigInt(fees.withdrawal.network_fee_zats);
    const zecMicro = BigInt(zatsToMicroUsd(gross.zecZats, px));
    const tagged = gross.zecZats > 0n && (gross.usdMicro === 0n || zecMicro >= gross.usdMicro) ? zecMicro : gross.usdMicro;
    const covered = fees.free_network_fees_available === true
      && this.book.lastWithdrawalDay !== utcDay()
      && tagged >= BigInt(fees.withdrawal.min_micro_usd_for_free);
    const networkFeeZats = covered ? 0n : feeZats;
    if (!gross.needsConversion && gross.zecZats <= networkFeeZats) {
      throw new ZeepApiError("This amount is too small to cover the network fees.", 400, "too_small", { network_fee_zats: networkFeeZats.toString() });
    }
    const estimatedZats = gross.estimatedZats > networkFeeZats ? gross.estimatedZats - networkFeeZats : 0n;
    return { ...gross, estimatedZats, networkFeeZats, networkFeesCovered: covered };
  }

  /** The plan before payout network fees. */
  private async planGross(zats: bigint | "all"): Promise<Omit<WithdrawalPlan, "networkFeeZats" | "networkFeesCovered">> {
    const conf = this.conf ?? (await this.config());
    const feeBps = BigInt(conf.split.conversion_fee_bps.usd_to_zec);
    const minUsd = BigInt(conf.withdrawals.min_micro_usd);
    const px = (await this.prices()).zec_usd as number;
    const { usd, zec } = this.balances();
    if (zats === "all") {
      const usdMicro = usd >= minUsd ? usd : 0n;
      const fee = usdMicro ? (usdMicro * feeBps + 9_999n) / 10_000n : 0n;
      return { zecZats: zec, usdMicro, needsConversion: usdMicro > 0n, conversionFeeMicro: fee, estimatedZats: zec + toZats(usdMicro - fee, px) };
    }
    if (zats <= zec) return { zecZats: zats, usdMicro: 0n, needsConversion: false, conversionFeeMicro: 0n, estimatedZats: zats };
    const short = zats - zec;
    // Credits needed so that, after the conversion fee, they buy `short` zats.
    let usdMicro = (BigInt(zatsToMicroUsd(short, px)) * 10_000n + (10_000n - feeBps) - 1n) / (10_000n - feeBps) + 1n;
    if (usdMicro < minUsd) usdMicro = minUsd;
    if (usdMicro > usd) throw new ZeepApiError("Not enough balance for this withdrawal.", 402, "insufficient", { max_zats: (await this.planWithdrawal("all")).estimatedZats.toString() });
    const fee = (usdMicro * feeBps + 9_999n) / 10_000n;
    return { zecZats: zec, usdMicro, needsConversion: true, conversionFeeMicro: fee, estimatedZats: zec + toZats(usdMicro - fee, px) };
  }

  /**
   * Withdraw per a plan from planWithdrawal(). ZEC-only withdrawals are scheduled at once;
   * with credits converted, the status is "converting" (20–60 min: show
   * `processing.message`) and the ZEC arrives shielded, then is paid in two tranches.
   * Payout network fees are covered by Zeep on your first withdrawal of the day.
   * A transparent address needs `allowTransparent` — amount and recipient become public.
   */
  withdraw(plan: Pick<WithdrawalPlan, "zecZats" | "usdMicro">, payoutAddress: string, opts: { allowTransparent?: boolean } = {}): Promise<any> {
    return this.exclusive(async () => {
      const id = crypto.randomUUID();
      const signal = withdrawSignal(id, payoutAddress);
      const locked: Note[] = [];
      // Today's withdrawal tag goes on the larger part (covered network fees need it to move ≥ $1).
      const px = (await this.prices()).zec_usd as number;
      const tagOnZec = plan.zecZats > 0n && (plan.usdMicro === 0n || BigInt(zatsToMicroUsd(plan.zecZats, px)) >= plan.usdMicro);
      try {
        let zecSpend: { built: Awaited<ReturnType<typeof buildSpend>>; inputs: Note[] } | undefined;
        let usdSpend: typeof zecSpend;
        if (plan.zecZats > 0n) {
          const { inputs, current } = await this.prepare(plan.zecZats, ZEC);
          locked.push(...inputs);
          const built = await buildSpend(this.keys, { asset: ZEC, inputs, cost: plan.zecZats, signal, daily: tagOnZec ? TAG.withdrawal : undefined }, this.paths(current), this.o.prove);
          zecSpend = { built, inputs };
        }
        if (plan.usdMicro > 0n) {
          const { inputs, current } = await this.prepare(plan.usdMicro, USD);
          locked.push(...inputs);
          const built = await buildSpend(this.keys, { asset: USD, inputs, cost: plan.usdMicro, signal, daily: tagOnZec ? undefined : TAG.withdrawal }, this.paths(current), this.o.prove);
          usdSpend = { built, inputs };
        }
        if (!zecSpend && !usdSpend) throw new Error("nothing to withdraw");
        for (const s of [zecSpend, usdSpend]) if (s) delete s.built.bundle.compensate;
        const res = await this.f(`${this.base}/v1/withdrawals`, this.json("POST", {
          withdrawal_id: id, payout_address: payoutAddress, allow_transparent: opts.allowTransparent ?? false,
          zec_proof: zecSpend?.built.bundle, usd_proof: usdSpend?.built.bundle,
        }));
        const body = await res.json().catch(() => null);
        if (zecSpend) this.adopt(body?.notes?.zec, zecSpend.built, zecSpend.inputs, ZEC);
        if (usdSpend) this.adopt(body?.notes?.usd, usdSpend.built, usdSpend.inputs, USD);
        await this.changed();
        if (!res.ok) {
          if (res.status === 409) await this.refreshSpent();
          throw new ZeepApiError(body?.error?.message ?? `HTTP ${res.status}`, res.status, body?.error?.code ?? "http", body);
        }
        this.book.lastWithdrawalDay = utcDay(); // today's withdrawal tag is used now
        await this.changed();
        return body;
      } finally {
        locked.forEach((n) => (n.pending = false));
      }
    });
  }

  withdrawalStatus(id: string) {
    return this.api<any>("/v1/withdrawals/status", this.json("POST", { withdrawal_id: id }));
  }

  // ---------------------------------------------------------------- restore / sync
  /** Mark notes another device already spent. Mixes in decoys so the query reveals less. */
  async refreshSpent(): Promise<void> {
    const mine = this.book.notes.filter((n) => !n.spent);
    if (!mine.length) return;
    // Ask only for buckets (top bits) and check locally: the server never sees our nullifiers.
    const bits: number = (this.conf ?? (await this.config())).nullifier_bucket_bits;
    const real = mine.map((n) => nullifierOf(this.keys.sk, BigInt(n.rho)));
    const bucketOf = (x: bigint) => Number(x >> BigInt(254 - bits));
    const buckets = [...new Set(real.map(bucketOf))];
    const spent = new Set<string>();
    for (let i = 0; i < buckets.length; i += 64) {
      const r = await this.api<{ spent: Record<string, string[]> }>("/v1/nullifiers/buckets", this.json("POST", { buckets: buckets.slice(i, i + 64) }));
      for (const list of Object.values(r.spent)) list.forEach((x) => spent.add(x));
    }
    mine.forEach((n, i) => {
      if (spent.has(real[i].toString())) n.spent = true;
    });
    await this.changed();
  }

  /**
   * Rebuild the note book from the recovery phrase alone: trial-decrypt every backup in
   * every tree, re-find deposits, then drop what's already spent.
   */
  async restore(onProgress?: (msg: string) => void): Promise<bigint> {
    const { trees } = await this.syncAll();
    for (const id of trees) {
      const t = this.trees.get(id)!;
      onProgress?.(`Scanning ${t.tree.size} notes in tree ${id}`);
      for (let i = 0; i < t.enc.length; i++) {
        const e = t.enc[i];
        if (!e) continue;
        const n = await decryptNote(this.keys.noteKey, e);
        if (!n) continue;
        const note = noteFromKeys(this.keys, n.rho, n.amount, n.asset, id, i, "change");
        if (BigInt(note.commitment) === t.tree.leaf(i) && n.amount > 0n) this.book.add(note);
      }
    }
    onProgress?.("Finding deposits");
    let misses = 0;
    const toClaim: number[] = [];
    for (let slot = 0; misses < 5; slot++) {
      try {
        // Don't claim mid-scan: a claim takes the next free slot, which may not be known yet.
        const st = await this.depositStatus(slot, { claim: false });
        this.book.nextDeposit = Math.max(this.book.nextDeposit, slot + 1);
        if (st.unclaimed_zats > 0) toClaim.push(slot);
        else if (st.status !== "credited" && st.status !== "expired" && !this.book.pendingDeposits.includes(slot)) this.book.pendingDeposits.push(slot);
        misses = 0;
      } catch (e) {
        if (e instanceof ZeepApiError && e.status === 404) misses++;
        else throw e;
      }
    }
    for (const slot of toClaim) await this.depositStatus(slot);
    onProgress?.("Checking spent notes");
    await this.refreshSpent();
    this.book.notes = this.book.notes.filter((n) => !n.spent);
    if (this.book.refill.base === "0") this.book.refill = { base: this.book.balance(USD).toString(), stage: 0 };
    await this.changed();
    return this.book.balance(USD);
  }
}

/** Anti-spam proof of work for a deposit intent (~65k hashes at 16 bits; well under a second). */
export function solvePow(intentId: string, bits: number): string {
  for (let n = 0; ; n++) {
    const nonce = n.toString(16);
    const h = sha256(utf8ToBytes(`zeep-intent-pow-v1:${intentId}:${nonce}`));
    let need = bits;
    let ok = true;
    for (const byte of h) {
      if (need <= 0) break;
      if (need >= 8) {
        if (byte !== 0) { ok = false; break; }
        need -= 8;
      } else {
        if (byte >> (8 - need) !== 0) ok = false;
        break;
      }
    }
    if (ok) return nonce;
  }
}

const WATCH_MS = 30 * 86_400_000;
const WATCH_EVERY_MS = 10 * 60_000;
const utcDay = (): number => Math.floor(Date.now() / 86_400_000);
const toZats = (micro: bigint, zecUsd: number): bigint => (micro <= 0n ? 0n : BigInt(Math.floor((Number(micro) / 1e6 / zecUsd) * 1e8)));

/**
 * Exact price of a chat request, in micro-USD: what POST /v1/ai/chat/completions charges for
 * this `rawBody` (the exact string you send). Pass the result as the cost to pay().
 * Metered (frontier) models: max(min, input tokens × in + output cap × out) + markup, where the
 * output cap is body.max_tokens (or the model default), never above the model's max.
 * Flat models: model price + attachment MB beyond 64 KB. Mirrors src/services/prices.ts.
 */
export function chatCostMicro(sheet: any, modelId: string, rawBody: string): bigint {
  const m = sheet.models.find((x: { id: string }) => x.id === modelId);
  if (!m) throw new ZeepApiError(`unknown model ${modelId}`, 400, "bad_request", null);
  const bytes = utf8Len(rawBody);
  if (!m.metered) {
    const extraMb = Math.max(0, Math.ceil((bytes - 64 * 1024) / (1024 * 1024)));
    return BigInt(m.micro_usd) + BigInt(extraMb) * BigInt(sheet.attachments.micro_usd_per_mb);
  }
  const r = m.metered;
  const body = JSON.parse(rawBody) as { messages: { content: string | { type: string; text?: string }[] }[]; max_tokens?: number };
  let text = 0;
  let images = 0;
  for (const msg of body.messages) {
    if (typeof msg.content === "string") text += utf8Len(msg.content);
    else for (const p of msg.content) {
      if (p.type === "text") text += utf8Len(p.text ?? "");
      else images++;
    }
  }
  const input = Math.ceil(text / r.bytes_per_token) + images * r.image_tokens + body.messages.length * r.message_tokens;
  const out = Math.min(body.max_tokens ?? r.default_output, r.max_output);
  const usd = Math.max(r.min_usd, (input * r.in_usd_per_m + out * r.out_usd_per_m) / 1e6);
  const marked = (usd * (10_000 + sheet.markup_bps)) / 10_000;
  return BigInt(Math.ceil(Math.round(marked * 1e12) / 1e6));
}

const utf8Len = (s: string): number => new TextEncoder().encode(s).length;
