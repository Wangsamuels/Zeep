// Shared plumbing for paid routes: proof check + credit burn, refund-on-failure,
// and SSE streaming that survives Heroku's 30 s / 55 s router windows.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { cfg } from '../config.js';
import { errors, ZeepError } from '../lib/errors.js';
import { bundleFromHeaders, notesHeader, requestSignal, spend, USD, type Spent } from '../notes/spend.js';
import { chargeCtx } from '../services/mpp.js';
import { requiredMicroUsd } from '../services/prices.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/**
 * Verify the request's `X-Zeep-Proof` spend and charge `usd` (+ markup) in micro-USD.
 * Sets `X-Zeep-Notes: <tree>:<i0>,<i1>` so the client knows where its change landed.
 */
export async function chargeRequest(req: FastifyRequest, reply: FastifyReply, usd: number): Promise<Spent> {
  const minCost = requiredMicroUsd(usd);
  const bundle = bundleFromHeaders(req.headers);
  const s = await spend({
    bundle,
    signal: requestSignal(req.method, req.url, req.rawBody, bundle?.compensate?.d ?? 0n),
    asset: USD,
    minCost,
    book: 'service',
  });
  reply.header('x-zeep-notes', notesHeader(s.notes));
  reply.header('x-zeep-cost', s.cost.toString());
  return s;
}

/**
 * Run the upstream call; if it fails before anything was sent, the cost comes back as a new
 * note — unless Zeep already paid the upstream for it (an MPP payment was signed). Then the
 * call is not refundable, so failing requests can't drain the treasury's MPP budget for free.
 */
export async function withCharge<T>(s: Spent, reply: FastifyReply, fn: () => Promise<T>): Promise<T> {
  const call = { upstreamPaid: false };
  try {
    return await chargeCtx.run(call, fn);
  } catch (e) {
    if (call.upstreamPaid) {
      if (e instanceof ZeepError) e.extra = { ...e.extra, refunded: false };
      throw e;
    }
    if (!reply.sent && !reply.raw.headersSent) {
      const back = await s.compensate().catch(() => null);
      if (back && e instanceof ZeepError) e.extra = { ...e.extra, compensation: { tree: back.tree, index: back.indexes[0] } };
      else if (back) throw new ZeepError(503, 'unavailable', 'upstream failed; your payment was returned as a new note', { compensation: { tree: back.tree, index: back.indexes[0] } });
    }
    throw e;
  }
}

/** Client-error statuses from an upstream mean "your request was bad": release and pass through. */
export async function upstreamJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) {
    if (res.status >= 400 && res.status < 500 && res.status !== 402 && res.status !== 429) {
      throw errors.bad('upstream rejected the request', { upstream_status: res.status, detail: safeJson(text) });
    }
    throw errors.busy();
  }
  return safeJson(text);
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t.slice(0, 2000);
  }
}

/**
 * Pipe an upstream SSE body to the client. Sends a `: ping` comment every
 * STREAM_HEARTBEAT_SEC so the Heroku router's 55 s idle window never closes it.
 */
export async function pipeSse(reply: FastifyReply, upstream: Response): Promise<void> {
  if (!upstream.body) throw errors.busy();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers[k] = String(v);
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    ...headers,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  raw.write(': open\n\n'); // first byte well inside the 30 s window
  const beat = setInterval(() => raw.write(': ping\n\n'), cfg.STREAM_HEARTBEAT_SEC * 1000);
  const reader = upstream.body.getReader();
  const abort = () => reader.cancel().catch(() => {});
  raw.on('close', abort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw.write(value);
    }
  } catch {
    raw.write(`event: error\ndata: {"error":"upstream stream interrupted"}\n\n`);
  } finally {
    clearInterval(beat);
    raw.off('close', abort);
    raw.end();
  }
}
