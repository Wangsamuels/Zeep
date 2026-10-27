// Oblivious HTTP gateway. The app encrypts each API request to Zeep's OHTTP key and posts it
// to /ohttp through the relay, so the relay (Cloudflare) sees the user's IP but only
// ciphertext, and Heroku's router sees only "POST /ohttp" from Cloudflare. Here the request is
// decrypted and run through the normal routes in-process; the reply goes back encrypted.
//
// Sizes leak little: requests and buffered replies are padded to buckets, and streamed AI
// replies are sent in timed batches padded with SSE comments, so token lengths don't show.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { cfg } from '../config.js';
import { safeEqual } from '../lib/crypto.js';
import { ZeepError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import {
  bucket, decodeRequest, encodeContent, encodeKeyConfig, encodeKeyConfigs, encodeResponseEnd, encodeResponseHead,
  OhttpError, openRequest, publicKeyOf, REQ_MEDIA, RES_MEDIA, RESPONSE_OVERHEAD, responseWriter, type Fields,
} from '../lib/ohttp.js';

/** Marks requests the gateway runs in-process. Random per process; never leaves it. */
const INNER_TOKEN = randomBytes(32).toString('hex');
export const isInnerRequest = (v: unknown) => typeof v === 'string' && safeEqual(v, INNER_TOKEN);

const MAX_OUTER = 1536 * 1024; // inner body limit (1 MB) + proof headers + padding
const FLUSH_MS = 250;
const SSE_PAD = 512;

// Only what the API reads. Anything else in the encrypted request is dropped.
const PASS = new Set(['content-type', 'accept', 'x-vault-id', 'x-vault-auth']);
const passes = (n: string) => PASS.has(n) || n === 'x-zeep-proof' || /^x-zeep-proof-\d{1,2}$/.test(n);
// Hop-by-hop and transport headers that don't belong inside the encrypted reply.
const DROP_OUT = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'date', 'access-control-allow-origin', 'vary']);

/** The headers an inner request runs with: the allowlist, plus the gateway's own markers. */
export function innerHeaders(fields: Fields): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of fields) if (passes(k.toLowerCase())) headers[k.toLowerCase()] = v;
  headers['x-zeep-ohttp-inner'] = INNER_TOKEN;
  if (cfg.RELAY_SHARED_SECRET) headers['x-zeep-relay'] = cfg.RELAY_SHARED_SECRET;
  return headers;
}

function privateKeys(): Map<number, Uint8Array> {
  const m = new Map<number, Uint8Array>();
  if (cfg.OHTTP_PRIVATE_KEY) m.set(cfg.OHTTP_KEY_ID, new Uint8Array(Buffer.from(cfg.OHTTP_PRIVATE_KEY.trim(), 'base64')));
  if (cfg.OHTTP_PREVIOUS_PRIVATE_KEY) m.set(cfg.OHTTP_PREVIOUS_KEY_ID, new Uint8Array(Buffer.from(cfg.OHTTP_PREVIOUS_PRIVATE_KEY.trim(), 'base64')));
  return m;
}

/** The public key config (current key first), as served at /ohttp-keys. */
export function keyConfigs(): Uint8Array[] {
  return [...privateKeys()].map(([id, sk]) => encodeKeyConfig(id, publicKeyOf(sk)));
}

export async function registerOhttp(app: FastifyInstance) {
  const keys = privateKeys();

  app.addContentTypeParser(REQ_MEDIA, { parseAs: 'buffer', bodyLimit: MAX_OUTER }, (_req, body, done) => done(null, body));

  // For setup and checks only. The app must use the key built into the frontend: a key
  // fetched through the relay could be swapped by the relay.
  app.get('/ohttp-keys', async (_req, reply) => {
    if (!keys.size) throw new ZeepError(503, 'ohttp_not_configured', 'OHTTP is not configured');
    return reply.type('application/ohttp-keys').send(Buffer.from(encodeKeyConfigs(keyConfigs())));
  });

  app.post('/ohttp', { bodyLimit: MAX_OUTER }, async (req, reply) => {
    if (!keys.size) throw new ZeepError(503, 'ohttp_not_configured', 'OHTTP is not configured');
    if (!Buffer.isBuffer(req.body)) throw new ZeepError(415, 'ohttp_media', `send ${REQ_MEDIA}`);
    let opened: ReturnType<typeof openRequest>;
    let inner: ReturnType<typeof decodeRequest>;
    try {
      opened = openRequest(new Uint8Array(req.body), (id) => keys.get(id));
      inner = decodeRequest(opened.plaintext);
    } catch (e) {
      const unknownKey = e instanceof OhttpError && e.message === 'unknown key id';
      throw new ZeepError(unknownKey ? 422 : 400, unknownKey ? 'ohttp_key' : 'ohttp_decrypt',
        unknownKey ? 'the app has an old OHTTP key; reload it' : 'could not decrypt the request');
    }
    const method = inner.method.toUpperCase();
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw new ZeepError(400, 'ohttp_method', 'method not allowed');
    if (!/^\/v1\/[A-Za-z0-9._~\-/%]*(\?[A-Za-z0-9._~\-=&%]*)?$/.test(inner.path) || inner.path.includes('..')) {
      throw new ZeepError(400, 'ohttp_path', 'path not allowed');
    }
    const headers = innerHeaders(inner.headers);

    // Copy what the outer request's hooks set (CORS, no-store) before taking over the socket.
    const outerHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) outerHeaders[k] = String(v);
    const ac = new AbortController();
    const raw = reply.raw;
    raw.on('close', () => { if (!raw.writableFinished) ac.abort(); });

    const res = await app.inject({
      method: method as 'GET',
      url: inner.path,
      headers,
      payload: method === 'GET' ? undefined : Buffer.from(inner.body),
      payloadAsStream: true,
      signal: ac.signal,
    });

    const w = responseWriter(opened.ctx, opened.enc);
    const outHeaders: Fields = [];
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined || DROP_OUT.has(k)) continue;
      for (const one of Array.isArray(v) ? v : [v]) outHeaders.push([k, String(one)]);
    }
    const head = encodeResponseHead(res.statusCode, outHeaders);
    const sse = String(res.headers['content-type'] ?? '').includes('text/event-stream');

    reply.hijack();
    raw.writeHead(200, { ...outerHeaders, 'content-type': RES_MEDIA, 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' });
    raw.write(w.nonce);
    const stream = res.stream();

    if (!sse) {
      // Small JSON replies: buffer, pad to a bucket, send as the one final chunk.
      const parts: Buffer[] = [];
      try {
        for await (const c of stream) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      } catch {
        raw.destroy();
        return;
      }
      const body = encodeContent(new Uint8Array(Buffer.concat(parts)));
      const used = head.length + body.length + 2 + RESPONSE_OVERHEAD;
      raw.end(w.final(Buffer.concat([head, body, encodeResponseEnd(bucket(used) - used)])));
      return;
    }

    // Streamed AI reply: batch every FLUSH_MS at event boundaries, pad each batch with an
    // SSE comment to a multiple of SSE_PAD so the relay can't count tokens.
    let pending = Buffer.alloc(0);
    let headSent = false;
    const send = (content: Buffer) => {
      const piece = encodeContent(new Uint8Array(content));
      raw.write(w.chunk(headSent ? piece : Buffer.concat([head, piece])));
      headSent = true;
    };
    const padded = (b: Buffer) => {
      const target = Math.ceil((b.length + 2) / SSE_PAD) * SSE_PAD;
      return Buffer.concat([b, Buffer.from(`:${' '.repeat(target - b.length - 2)}\n`)]);
    };
    const flush = (all: boolean) => {
      if (!headSent && !pending.length) return send(Buffer.alloc(0));
      // Cut after the last complete line: an SSE comment line may sit anywhere between lines.
      const cut = all ? pending.length : pending.lastIndexOf('\n') + 1;
      if (cut <= 0) return;
      const out = pending.subarray(0, cut);
      pending = pending.subarray(cut);
      send(out[out.length - 1] === 10 ? padded(out) : out);
    };
    flush(false); // the head right away, so the app sees the status quickly
    const timer = setInterval(() => flush(false), FLUSH_MS);
    try {
      for await (const c of stream) pending = Buffer.concat([pending, Buffer.isBuffer(c) ? c : Buffer.from(c)]);
      flush(true);
      raw.end(w.final(encodeResponseEnd(Math.floor(Math.random() * 64))));
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'ohttp stream ended early');
      raw.destroy(); // no final chunk: the app treats the reply as cut short
    } finally {
      clearInterval(timer);
    }
  });
}
