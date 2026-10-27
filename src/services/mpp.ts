// Paid upstream calls over MPP (HTTP 402 + Tempo stablecoin payments) via `mppx`.
// Every payment is checked against a Redis daily budget *before* the credential is
// signed, so spend stops hard at MPP_DAILY_BUDGET_USD.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Mppx, tempo } from 'mppx/client';
import { createClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { cfg, need } from '../config.js';
import { q } from '../lib/db.js';
import { errors, ZeepError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { keys, redis } from '../lib/redis.js';

const today = () => new Date().toISOString().slice(0, 10);
const ctx = new AsyncLocalStorage<{ service: string; costUsd: number }>();
/** Set by withCharge(): marks the user's request as paid upstream once an MPP credential is signed. */
export const chargeCtx = new AsyncLocalStorage<{ upstreamPaid: boolean }>();

class BudgetExceeded extends Error {}

let client: ReturnType<typeof makeClient> | undefined;
function makeClient() {
  const account = privateKeyToAccount(need('TEMPO_PRIVATE_KEY') as `0x${string}`);
  return Mppx.create({
    polyfill: false, // never patch global fetch: only calls made through mppFetch can pay
    methods: [
      tempo({
        account,
        maxDeposit: String(cfg.MPP_SESSION_MAX_USD),
        getClient: cfg.TEMPO_RPC_URL ? () => createClient({ transport: http(cfg.TEMPO_RPC_URL) }) : undefined,
      }),
    ],
    async onChallenge(challenge, { createCredential }) {
      const req = challenge.request as { amount?: string; decimals?: number };
      const usd = Number(req.amount ?? 0) / 10 ** (req.decimals ?? 6);
      const cents = Math.ceil(usd * 100);
      const key = keys.mppBudget(today());
      const spent = await redis.incrby(key, cents);
      await redis.expire(key, 2 * 86_400);
      if (spent > cfg.MPP_DAILY_BUDGET_USD * 100) {
        await redis.decrby(key, cents);
        throw new BudgetExceeded();
      }
      const store = ctx.getStore();
      if (store) store.costUsd += usd;
      const credential = await createCredential();
      const charge = chargeCtx.getStore();
      if (charge && usd > 0) charge.upstreamPaid = true; // only once Zeep has actually signed a payment
      return credential;
    },
  });
}

export async function budgetLeftUsd(): Promise<number> {
  const spent = Number((await redis.get(keys.mppBudget(today()))) ?? 0);
  return cfg.MPP_DAILY_BUDGET_USD - spent / 100;
}

/**
 * fetch() that pays MPP 402 challenges from the treasury's Tempo wallet.
 * `service` is only used for the daily totals in `upstream_daily`.
 */
export async function mppFetch(service: string, url: string, init: RequestInit = {}): Promise<Response> {
  if (!cfg.MPP_ENABLED) throw errors.busy('paid upstreams are disabled');
  if ((await budgetLeftUsd()) <= 0) throw errors.budget();
  if (cfg.MPP_MODE === 'mock') return mockResponse(service, url);

  client ??= makeClient();
  const store = { service, costUsd: 0 };
  try {
    const res = await ctx.run(store, () =>
      client!.fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(cfg.UPSTREAM_TIMEOUT_MS) }),
    );
    if (res.status === 402) {
      // The provider refused our payment (e.g. not enough USDC.e on Tempo): nothing was taken,
      // so the user's request stays refundable.
      const charge = chargeCtx.getStore();
      if (charge) charge.upstreamPaid = false;
      log.warn({ service }, 'ALERT upstream refused the MPP payment; check USDC.e on Tempo');
      throw errors.busy('upstream payment was not accepted');
    }
    return res;
  } catch (e) {
    if (e instanceof BudgetExceeded || (e as Error)?.cause instanceof BudgetExceeded) throw errors.budget();
    if (e instanceof ZeepError) throw e;
    log.warn({ service, err: (e as Error).message }, 'mpp upstream failed');
    throw errors.busy();
  } finally {
    recordUsage(service, store.costUsd).catch(() => {});
  }
}

export async function recordUsage(service: string, costUsd: number): Promise<void> {
  await q(
    `INSERT INTO upstream_daily (day, service, calls, cost_usd) VALUES ($1, $2, 1, $3)
     ON CONFLICT (day, service) DO UPDATE SET calls = upstream_daily.calls + 1, cost_usd = upstream_daily.cost_usd + $3`,
    [today(), service, costUsd.toFixed(6)],
  );
}

/** Canned answers for MPP_MODE=mock (offline tests, demos without a funded wallet). */
function mockResponse(service: string, url: string): Response {
  const body: Record<string, unknown> = {
    'ai-frontier': {
      id: 'mock', object: 'chat.completion', model: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: 'mock frontier reply' }, finish_reason: 'stop' }],
    },
    search: { results: [{ title: 'Mock result', url: 'https://example.com', snippet: 'mock' }] },
    research: { run_id: 'mock-run', status: 'completed', output: { content: 'mock research report', citations: [] } },
    health: { results: [{ name: 'mock', summary: 'mock record' }] },
    rpc: { jsonrpc: '2.0', id: 1, result: '0x1' },
    inbox: { inbox_id: `mock-${Date.now()}@example.com`, email: `mock-${Date.now()}@example.com`, inbox: `mock-${Date.now()}@example.com` },
    'inbox-send': { message_id: `mock-sent-${Date.now()}`, thread_id: 'mock-thread-1', messageId: `mock-sent-${Date.now()}` },
    'inbox-delete': { success: true },
  };
  if (service === 'inbox-read') {
    const msg = {
      message_id: 'mock-msg-1', id: 'mock-msg-1', thread_id: 'mock-thread-1', from: 'Zeep test <hello@example.com>', to: ['you@example.com'],
      subject: 'Welcome to your Zeep inbox', preview: 'This is a mock message (MPP_MODE=mock).',
      text: 'This is a mock message (MPP_MODE=mock).\n\nReal mail arrives here on a live network.',
      html: '<p>This is a mock message (MPP_MODE=mock).</p><p>Real mail arrives here on a live network.</p>',
      timestamp: new Date().toISOString(), receivedAt: new Date().toISOString(), labels: ['received', 'unread'], read: false, attachments: [],
    };
    const one = /\/messages\/[^/?]+$|\/messages\/read$/.test(new URL(url).pathname);
    return Response.json(one ? { ...msg, message: msg } : { count: 1, messages: [msg] });
  }
  return Response.json(body[service] ?? { ok: true, url });
}
