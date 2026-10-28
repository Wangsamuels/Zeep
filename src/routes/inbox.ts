// Anonymous inbox routes. The inbox id ("ibx_…") is a bearer secret: it is only ever sent in
// POST bodies (never in a URL), so it can't land in router or relay logs.
//
//   POST /v1/inbox                    create (paid: routes.inbox)                 → { inbox_id, address, expires_at }
//   POST /v1/inbox/messages           list   { inbox_id, cursor?, limit? }        → { address, expires_at, messages, next_cursor }
//   POST /v1/inbox/messages/read      one    { inbox_id, message_id }             → { message }   (full text + html)
//   POST /v1/inbox/send               send   (paid: routes.inbox_send)            → { message_id, thread_id }
//   POST /v1/inbox/reply              reply  (paid: routes.inbox_send)            → { message_id, thread_id }
//   POST /v1/inbox/messages/delete    delete { inbox_id, message_id }             → { deleted: true }
//   POST /v1/email/send               send without an inbox (paid: routes.email_send) → { message_id, from }
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cfg } from '../config.js';
import { q } from '../lib/db.js';
import { errors, ZeepError } from '../lib/errors.js';
import { NS, redis } from '../lib/redis.js';
import { providers, recipients, sendDirect, type InboxRow, type Provider } from '../services/inbox.js';
import { routeUsd } from '../services/prices.js';
import { chargeRequest, withCharge } from './paid.js';

const INBOX_ID = /^ibx_[A-Za-z0-9_-]{32}$/;
const MSG_ID = z.string().min(1).max(512);
const MAX_BODY = 256 * 1024; // text + html per message

async function inboxOf(id: unknown): Promise<InboxRow & { id: string; expires_at: Date }> {
  if (typeof id !== 'string' || !INBOX_ID.test(id)) throw errors.notFound('inbox not found or expired');
  const [row] = await q<InboxRow & { expires_at: Date }>(
    'SELECT provider, provider_ref, address, expires_at FROM inboxes WHERE id = $1', [id]);
  if (!row || row.expires_at < new Date()) throw errors.notFound('inbox not found or expired');
  if (!(row.provider in providers)) throw errors.busy('this inbox provider is no longer available');
  return { ...row, id };
}

/** Fixed-window counter per inbox; throws 429 when the window is full. */
async function limit(kind: string, inboxId: string, max: number, windowSec: number, take = 1): Promise<void> {
  const win = Math.floor(Date.now() / 1000 / windowSec);
  const key = `${NS}:inbox:${kind}:${inboxId}:${win}`;
  const n = await redis.incrby(key, take);
  if (n === take) await redis.expire(key, windowSec + 60);
  if (n > max) {
    await redis.decrby(key, take);
    throw new ZeepError(429, 'rate_limited', kind === 'send'
      ? `this inbox can send ${max} emails a day; try again tomorrow`
      : kind === 'direct'
        ? 'send-only email is busy today; try again tomorrow, or send from your own inbox'
        : 'too many requests for this inbox; wait a few minutes');
  }
}
const release = (kind: string, inboxId: string, windowSec: number, n = 1) =>
  redis.decrby(`${NS}:inbox:${kind}:${inboxId}:${Math.floor(Date.now() / 1000 / windowSec)}`, n).catch(() => {});

async function hidden(inboxId: string): Promise<Set<string>> {
  const rows = await q<{ message_id: string }>('SELECT message_id FROM inbox_hidden WHERE inbox_id = $1', [inboxId]);
  return new Set(rows.map((r) => r.message_id));
}

const Body = z.object({
  text: z.string().max(MAX_BODY).optional(),
  html: z.string().max(MAX_BODY).optional(),
});
const Send = Body.extend({
  inbox_id: z.string(),
  to: z.union([z.string(), z.array(z.string())]),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  subject: z.string().max(300).default(''),
});
const Direct = Body.extend({
  to: z.union([z.string(), z.array(z.string())]),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  subject: z.string().min(1, 'add a subject').max(300),
  // Optional: the user's own Zeep inbox, so replies go there.
  reply_inbox_id: z.string().optional(),
});
const Reply = Body.extend({ inbox_id: z.string(), message_id: MSG_ID, reply_all: z.boolean().default(false) });
const needsBody = (b: { text?: string; html?: string }) => {
  if (!b.text?.trim() && !b.html?.trim()) throw errors.bad('write a message (text or html)');
};

export default async function inboxRoutes(app: FastifyInstance) {
  app.post('/v1/inbox', async (req, reply) => {
    const c = await chargeRequest(req, reply, routeUsd('inbox'));
    return withCharge(c, reply, async () => {
      const provider: Provider = cfg.INBOX_PROVIDER;
      const { ref, address } = await providers[provider].create();
      const id = 'ibx_' + randomBytes(24).toString('base64url');
      const expires = new Date(Date.now() + 30 * 86_400_000);
      await q('INSERT INTO inboxes (id, provider, provider_ref, address, expires_at) VALUES ($1,$2,$3,$4,$5)',
        [id, provider, ref, address, expires]);
      reply.code(201);
      return { inbox_id: id, address, expires_at: expires.toISOString() };
    });
  });

  app.post('/v1/inbox/messages', async (req) => {
    const b = (req.body ?? {}) as { inbox_id?: unknown; cursor?: unknown; limit?: unknown };
    const box = await inboxOf(b.inbox_id);
    await limit('read', box.id, cfg.INBOX_READS_PER_HOUR, 3600);
    const n = Math.min(50, Math.max(1, Number(b.limit) || 20));
    const cursor = typeof b.cursor === 'string' && b.cursor.length <= 512 ? b.cursor : undefined;
    const page = await providers[box.provider].list(box.provider_ref, cursor, n);
    const skip = await hidden(box.id);
    return {
      address: box.address,
      expires_at: box.expires_at.toISOString(),
      messages: page.messages.filter((m) => !skip.has(m.id)),
      next_cursor: page.next_cursor,
    };
  });

  app.post('/v1/inbox/messages/read', async (req) => {
    const b = (req.body ?? {}) as { inbox_id?: unknown; message_id?: unknown };
    const box = await inboxOf(b.inbox_id);
    const id = MSG_ID.safeParse(b.message_id);
    if (!id.success) throw errors.bad('message_id is required');
    if ((await hidden(box.id)).has(id.data)) throw errors.notFound('message not found');
    await limit('read', box.id, cfg.INBOX_READS_PER_HOUR, 3600);
    const message = await providers[box.provider].read(box.provider_ref, id.data);
    return { message };
  });

  app.post('/v1/inbox/send', async (req, reply) => {
    const p = Send.safeParse(req.body);
    if (!p.success) throw errors.bad(p.error.issues[0]?.message ?? 'invalid email');
    const b = p.data;
    needsBody(b);
    const to = recipients(b.to, cfg.INBOX_MAX_RECIPIENTS, 'to');
    const cc = recipients(b.cc, cfg.INBOX_MAX_RECIPIENTS, 'cc');
    if (!to.length) throw errors.bad('add at least one recipient');
    if (to.length + cc.length > cfg.INBOX_MAX_RECIPIENTS) throw errors.bad(`at most ${cfg.INBOX_MAX_RECIPIENTS} recipients in total`);
    const box = await inboxOf(b.inbox_id);
    // Check the daily limit BEFORE taking payment; give the slot back if anything fails.
    await limit('send', box.id, cfg.INBOX_SENDS_PER_DAY, 86_400);
    try {
      const c = await chargeRequest(req, reply, routeUsd('inbox_send'));
      return await withCharge(c, reply, async () => {
        const sent = await providers[box.provider].send(box.provider_ref, { to, cc, subject: b.subject.replace(/[\r\n]+/g, ' '), text: b.text, html: b.html });
        reply.code(201);
        return { message_id: sent.id, thread_id: sent.thread_id };
      });
    } catch (e) {
      await release('send', box.id, 86_400);
      throw e;
    }
  });

  // Send-only: no inbox to buy first. Goes out from a shared relay address; recipients can
  // reply only when the user names one of their own inboxes as the reply address.
  app.post('/v1/email/send', async (req, reply) => {
    const p = Direct.safeParse(req.body);
    if (!p.success) throw errors.bad(p.error.issues[0]?.message ?? 'invalid email');
    const b = p.data;
    needsBody(b);
    const to = recipients(b.to, cfg.INBOX_MAX_RECIPIENTS, 'to');
    const cc = recipients(b.cc, cfg.INBOX_MAX_RECIPIENTS, 'cc');
    if (!to.length) throw errors.bad('add at least one recipient');
    if (to.length + cc.length > cfg.INBOX_MAX_RECIPIENTS) throw errors.bad(`at most ${cfg.INBOX_MAX_RECIPIENTS} recipients in total`);
    const replyTo = b.reply_inbox_id ? (await inboxOf(b.reply_inbox_id)).address : undefined;
    await limit('direct', 'all', cfg.EMAIL_SENDS_PER_DAY, 86_400);
    try {
      const c = await chargeRequest(req, reply, routeUsd('email_send'));
      return await withCharge(c, reply, async () => {
        const sent = await sendDirect({ to, cc, subject: b.subject.replace(/[\r\n]+/g, ' '), text: b.text, html: b.html, replyTo });
        reply.code(201);
        return { message_id: sent.id, from: 'relay@stableemail.dev', reply_to: replyTo ?? null };
      });
    } catch (e) {
      await release('direct', 'all', 86_400);
      throw e;
    }
  });

  app.post('/v1/inbox/reply', async (req, reply) => {
    const p = Reply.safeParse(req.body);
    if (!p.success) throw errors.bad(p.error.issues[0]?.message ?? 'invalid reply');
    const b = p.data;
    needsBody(b);
    const box = await inboxOf(b.inbox_id);
    if ((await hidden(box.id)).has(b.message_id)) throw errors.notFound('message not found');
    await limit('send', box.id, cfg.INBOX_SENDS_PER_DAY, 86_400);
    try {
      const c = await chargeRequest(req, reply, routeUsd('inbox_send'));
      return await withCharge(c, reply, async () => {
        const sent = await providers[box.provider].reply(box.provider_ref, b.message_id, { text: b.text, html: b.html, replyAll: b.reply_all });
        reply.code(201);
        return { message_id: sent.id, thread_id: sent.thread_id };
      });
    } catch (e) {
      await release('send', box.id, 86_400);
      throw e;
    }
  });

  app.post('/v1/inbox/messages/delete', async (req) => {
    const b = (req.body ?? {}) as { inbox_id?: unknown; message_id?: unknown };
    const box = await inboxOf(b.inbox_id);
    const id = MSG_ID.safeParse(b.message_id);
    if (!id.success) throw errors.bad('message_id is required');
    await limit('read', box.id, cfg.INBOX_READS_PER_HOUR, 3600);
    // Hide it in Zeep first, so it disappears even if the provider can't delete right now.
    await q('INSERT INTO inbox_hidden (inbox_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [box.id, id.data]);
    let removed = false;
    try {
      removed = await providers[box.provider].remove(box.provider_ref, id.data);
    } catch {
      removed = false; // hidden in Zeep anyway; the provider copy goes when the inbox expires
    }
    return { deleted: true, removed_at_provider: removed };
  });
}

/** Housekeeping: delete expired inboxes at the provider, then forget them (retry for 7 days). */
export async function expireInboxes(): Promise<number> {
  const rows = await q<{ id: string; provider: Provider; provider_ref: string; expires_at: Date }>(
    'SELECT id, provider, provider_ref, expires_at FROM inboxes WHERE expires_at < now() ORDER BY expires_at LIMIT 50');
  let n = 0;
  for (const r of rows) {
    let ok = false;
    try {
      await providers[r.provider]?.destroy(r.provider_ref);
      ok = true;
    } catch {
      ok = r.expires_at.getTime() < Date.now() - 7 * 86_400_000;
    }
    if (ok) {
      await q('DELETE FROM inboxes WHERE id = $1', [r.id]);
      n++;
    }
  }
  return n;
}
