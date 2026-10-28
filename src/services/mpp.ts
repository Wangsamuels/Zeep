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
/**
 * Set by withCharge() for a paid request: `maxUsd` is what the user paid, `upstreamPaid` turns
 * true once an MPP credential is signed. Outside a paid request (free routes, housekeeping)
 * there's no store, and Zeep refuses to pay anything at all.
 */
export const chargeCtx = new AsyncLocalStorage<{ upstreamPaid: boolean; maxUsd?: number; spentUsd?: number }>();

/** May Zeep pay `usd` more for the current request? Never beyond what the user paid; free routes never. */
export function mayPay(charge: { maxUsd?: number; spentUsd?: number } | undefined, usd: number): boolean {
  if (usd <= 0) return true;
  return (charge?.spentUsd ?? 0) + usd <= (charge?.maxUsd ?? 0) + 1e-9;
}

class BudgetExceeded extends Error {}
/** A provider asked for more than the user paid for this request: refused before signing. */
class PriceAbovePaid extends Error {}

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
      // Never pay a provider more than the user paid for this request (free routes: nothing).
      // Prices change and providers count tokens their own way; this is the backstop.
      const charge = chargeCtx.getStore();
      if (!mayPay(charge, usd)) {
        log.error({ service: ctx.getStore()?.service, price_usd: usd, paid_usd: charge?.maxUsd ?? 0 }, 'ALERT provider price above what the user paid; refused, user refunded');
        throw new PriceAbovePaid();
      }
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
      if (charge && usd > 0) {
        charge.upstreamPaid = true; // only once Zeep has actually signed a payment
        charge.spentUsd = (charge.spentUsd ?? 0) + usd;
      }
      return credential;
    },
  });
}

export async function budgetLeftUsd(): Promise<number> {
  const spent = Number((await redis.get(keys.mppBudget(today()))) ?? 0);
  return cfg.MPP_DAILY_BUDGET_USD - spent / 100;
}

/**
 * What a provider would charge for this exact request, in USD, read from its 402 challenge
 * without paying (USDC.e offers only, the most expensive one). Used to price AI replies
 * exactly: the gateway counts tokens its own way and its rates change.
 */
export async function mppQuoteUsd(url: string, init: RequestInit): Promise<number> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw errors.busy('the provider is unreachable; you were not charged');
  }
  if (res.status !== 402) {
    const text = await res.text().catch(() => '');
    if (res.ok) return 0;
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw errors.bad('the provider rejected the request', { upstream_status: res.status, detail: text.slice(0, 300) });
    }
    throw errors.busy();
  }
  await res.body?.cancel().catch(() => {});
  const header = res.headers.get('www-authenticate') ?? '';
  let best = -1;
  for (const ch of header.split(/,\s*(?=Payment\s)/)) {
    const p = Object.fromEntries([...ch.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (p.method !== 'tempo' || !['charge', 'session'].includes(p.intent) || !p.request) continue;
    try {
      const r = JSON.parse(Buffer.from(p.request, 'base64url').toString('utf8')) as { amount?: string; currency?: string; decimals?: number };
      if (String(r.currency).toLowerCase() !== cfg.TEMPO_USDC_E.toLowerCase()) continue;
      best = Math.max(best, Number(r.amount ?? 0) / 10 ** (r.decimals ?? 6));
    } catch { /* skip malformed offers */ }
  }
  if (best < 0) throw errors.busy('the provider offered no USDC.e price');
  return best;
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
    if (e instanceof PriceAbovePaid || (e as Error)?.cause instanceof PriceAbovePaid) {
      throw errors.busy('the provider\'s price changed; you were not charged, try again shortly');
    }
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
    research: { run_id: 'trun_mock', status: 'completed', output_text: 'mock research report', result: { output: { content: 'mock research report', basis: [] } } },
    health: url.includes('/v1/trials')
      ? { data: [{ id: 679751, registry_id: 'ISRCTN17465883', brief_title: 'Mock trial', status: 'recruiting', study_type: 'INTERVENTIONAL', countries: ['Israel'], start_date: '2022-06-07', enrollment_count: 3829, source_record_url: 'https://www.isrctn.com/ISRCTN17465883' }], has_more: false, next_cursor: null, total: 1 }
      : { data: [{ id: 147244, canonical_product_ndc: '75834-258', brand_name: 'ATORVASTATIN CALCIUM TABLET', generic_name: 'Atorvastatin calcium', manufacturer_name: 'NIVAGEN', dosage_form: 'TABLET', route: 'ORAL', strength: '80 mg/1', has_recall: true }], has_more: false, next_cursor: null, total: 1 },
    inbox: { inbox_id: `mock-${Date.now()}@example.com`, email: `mock-${Date.now()}@example.com`, inbox: `mock-${Date.now()}@example.com` },
    'inbox-send': { message_id: `mock-sent-${Date.now()}`, thread_id: 'mock-thread-1', messageId: `mock-sent-${Date.now()}` },
    'inbox-delete': { success: true },
    'email-send': { success: true, messageId: `mock-direct-${Date.now()}`, from: 'relay@stableemail.dev' },
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
