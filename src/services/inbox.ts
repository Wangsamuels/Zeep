// Anonymous inbox: one adapter per email provider, all paid by Zeep over MPP.
// The app never talks to the provider; it only knows Zeep's random inbox id (a bearer
// secret, sent in request bodies, never in URLs). Message contents pass through and are
// never stored by Zeep.
//
//   agentmail   (default)  https://mpp.api.agentmail.to   list, read, send, reply ($2 per inbox, $0.01 per send);
//                                                         messages can't be deleted one by one: Zeep hides them
//   stableemail            https://stableemail.dev        list, read, send; reply = send "Re:";
//                                                         delete needs a wallet sign-in (SIWX), so
//                                                         Zeep also hides deleted messages itself
import { randomBytes } from 'node:crypto';
import { cfg } from '../config.js';
import { errors, ZeepError } from '../lib/errors.js';
import { mppFetch } from './mpp.js';

export type Provider = 'agentmail' | 'stableemail';

export interface MessageItem {
  id: string;
  thread_id: string | null;
  from: string;
  to: string[];
  subject: string;
  preview: string;
  received_at: string;
  read: boolean;
}

export interface Message extends MessageItem {
  cc: string[];
  reply_to: string[];
  text: string | null;
  html: string | null;
  attachments: { filename: string; content_type: string; size: number }[];
}

export interface Outgoing {
  to: string[];
  cc: string[];
  subject: string;
  text?: string;
  html?: string;
}

export interface InboxRow {
  provider: Provider;
  provider_ref: string;
  address: string;
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Parse a provider reply; 4xx → "rejected", 404 → not found, anything else → busy. */
async function body(res: Response): Promise<any> {
  const text = await res.text();
  let j: any;
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { raw: text.slice(0, 500) };
  }
  if (res.ok) return j;
  if (res.status === 404) throw errors.notFound('message not found');
  if (res.status >= 400 && res.status < 500 && res.status !== 402 && res.status !== 429) {
    throw errors.bad(String(j?.message ?? j?.error ?? 'the email provider rejected the request'), { upstream_status: res.status });
  }
  throw errors.busy('the email provider is unavailable; try again shortly');
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
const iso = (v: unknown): string => {
  const d = new Date(String(v ?? ''));
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
};
const previewOf = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

// ------------------------------------------------------------------ AgentMail
const AM = () => cfg.MPP_AGENTMAIL_URL.replace(/\/+$/, '');
const amPath = (ref: string, rest = '') => `${AM()}/v0/inboxes/${encodeURIComponent(ref)}${rest}`;

function amItem(m: any): MessageItem {
  return {
    id: String(m.message_id),
    thread_id: m.thread_id ? String(m.thread_id) : null,
    from: String(m.from ?? ''),
    to: list(m.to),
    subject: String(m.subject ?? ''),
    preview: previewOf(m.preview ?? m.extracted_text ?? m.text),
    received_at: iso(m.timestamp ?? m.created_at),
    read: !list(m.labels).includes('unread'),
  };
}

const agentmail = {
  async create(): Promise<{ ref: string; address: string }> {
    const j = await body(await mppFetch('inbox', `${AM()}/v0/inboxes`, json({})));
    return { ref: String(j.inbox_id), address: String(j.email ?? j.inbox_id) };
  },
  async list(ref: string, cursor: string | undefined, limit: number): Promise<{ messages: MessageItem[]; next_cursor: string | null }> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (cursor) qs.set('page_token', cursor);
    const j = await body(await mppFetch('inbox-read', amPath(ref, `/messages?${qs}`), { method: 'GET' }));
    return { messages: (j.messages ?? []).map(amItem), next_cursor: j.next_page_token ? String(j.next_page_token) : null };
  },
  async read(ref: string, id: string): Promise<Message> {
    const m = await body(await mppFetch('inbox-read', amPath(ref, `/messages/${encodeURIComponent(id)}`), { method: 'GET' }));
    return {
      ...amItem(m),
      cc: list(m.cc),
      reply_to: list(m.reply_to),
      text: m.text ?? null,
      html: m.html ?? null,
      attachments: (m.attachments ?? []).map((a: any) => ({ filename: String(a.filename ?? ''), content_type: String(a.content_type ?? ''), size: Number(a.size ?? 0) })),
    };
  },
  async send(ref: string, o: Outgoing): Promise<{ id: string; thread_id: string | null }> {
    const j = await body(await mppFetch('inbox-send', amPath(ref, '/messages/send'),
      json({ to: o.to, cc: o.cc.length ? o.cc : undefined, subject: o.subject, text: o.text, html: o.html })));
    return { id: String(j.message_id), thread_id: j.thread_id ? String(j.thread_id) : null };
  },
  async reply(ref: string, id: string, o: { text?: string; html?: string; replyAll: boolean }): Promise<{ id: string; thread_id: string | null }> {
    const j = await body(await mppFetch('inbox-send', amPath(ref, `/messages/${encodeURIComponent(id)}/${o.replyAll ? 'reply-all' : 'reply'}`),
      json({ text: o.text, html: o.html })));
    return { id: String(j.message_id), thread_id: j.thread_id ? String(j.thread_id) : null };
  },
  /** AgentMail's MPP gateway has no message delete: Zeep hides it; it goes with the inbox. */
  async remove(_ref: string, _id: string): Promise<boolean> {
    return false;
  },
  /** End of life: delete the whole inbox and its mail at the provider. */
  async destroy(ref: string): Promise<void> {
    const res = await mppFetch('inbox-delete', amPath(ref), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) await body(res);
  },
};

// ------------------------------------------------------------------ StableEmail
const SE = () => cfg.MPP_STABLEEMAIL_URL.replace(/\/+$/, '');

function seItem(m: any): MessageItem {
  return {
    id: String(m.id),
    thread_id: null,
    from: String(m.from ?? m.fromEmail ?? ''),
    to: list(m.to),
    subject: String(m.subject ?? ''),
    preview: previewOf(m.preview ?? m.text),
    received_at: iso(m.receivedAt ?? m.date),
    read: m.read !== false,
  };
}

const stableemail = {
  async create(): Promise<{ ref: string; address: string }> {
    // Random, unlinkable username: "z" + 15 base32 characters.
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    const username = 'z' + Array.from(randomBytes(15), (b) => alphabet[b & 31]).join('');
    const j = await body(await mppFetch('inbox', `${SE()}/api/inbox/buy`, json({ username })));
    return { ref: username, address: String(j.inbox ?? `${username}@stableemail.dev`) };
  },
  async list(ref: string, cursor: string | undefined, limit: number): Promise<{ messages: MessageItem[]; next_cursor: string | null }> {
    const j = await body(await mppFetch('inbox-read', `${SE()}/api/inbox/messages`, json({ username: ref, cursor, limit })));
    return { messages: (j.messages ?? []).map(seItem), next_cursor: j.nextCursor ? String(j.nextCursor) : null };
  },
  async read(_ref: string, id: string): Promise<Message> {
    const j = await body(await mppFetch('inbox-read', `${SE()}/api/inbox/messages/read`, json({ messageId: id })));
    const m = j.message ?? j;
    return {
      ...seItem({ ...m, read: true }),
      cc: list(m.cc),
      reply_to: list(m.replyTo),
      text: m.text ?? null,
      html: m.html ?? null,
      attachments: (m.attachments ?? []).map((a: any) => ({ filename: String(a.filename ?? ''), content_type: String(a.contentType ?? ''), size: Number(a.size ?? 0) })),
    };
  },
  async send(ref: string, o: Outgoing): Promise<{ id: string; thread_id: string | null }> {
    const j = await body(await mppFetch('inbox-send', `${SE()}/api/inbox/send`,
      json({ username: ref, to: o.to, cc: o.cc.length ? o.cc : undefined, subject: o.subject, text: o.text, html: o.html })));
    return { id: String(j.messageId ?? ''), thread_id: null };
  },
  /** No native reply: send to the original sender (or Reply-To) with "Re: <subject>". */
  async reply(ref: string, id: string, o: { text?: string; html?: string; replyAll: boolean }): Promise<{ id: string; thread_id: string | null }> {
    const orig = await stableemail.read(ref, id);
    const to = orig.reply_to.length ? orig.reply_to : [orig.from];
    const cc = o.replyAll ? [...orig.to, ...orig.cc].filter((a) => !a.includes(ref)) : [];
    const subject = /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
    return stableemail.send(ref, { to, cc, subject, text: o.text, html: o.html });
  },
  /** Needs a wallet sign-in the MPP client may not support; Zeep hides the message either way. */
  async remove(_ref: string, id: string): Promise<boolean> {
    try {
      await body(await mppFetch('inbox-delete', `${SE()}/api/inbox/messages/delete`, json({ messageId: id })));
      return true;
    } catch (e) {
      if (e instanceof ZeepError && e.status === 404) throw e;
      return false;
    }
  },
  async destroy(): Promise<void> {
    // Expires at the provider on its own after the 30 days paid for.
  },
};

export const providers: Record<Provider, typeof agentmail> = { agentmail, stableemail: stableemail as typeof agentmail };

// ------------------------------------------------------------------ checks shared by routes
const EMAIL = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]{2,}$/;

/** Recipients: plain addresses only (no display names, no header injection). */
export function recipients(v: unknown, max: number, field: string): string[] {
  const all = list(v).map((s) => s.trim()).filter(Boolean);
  if (all.length > max) throw errors.bad(`at most ${max} addresses in ${field}`);
  for (const a of all) if (a.length > 254 || !EMAIL.test(a)) throw errors.bad(`not an email address: ${a.slice(0, 80)}`);
  return [...new Set(all.map((a) => a.toLowerCase()))];
}
