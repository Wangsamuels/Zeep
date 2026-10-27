// Prices are in USD and charged in micro-USD. The live ZEC price values ZEC notes for display
// and sets the rate of every ZEC ⇄ dollar conversion (deposits' dollar half, refills,
// withdrawal estimates).
//
// ZEC/USD comes from the NEAR Intents 1Click token list (the same venue the treasury
// sells on). Display uses a quote up to PRICE_REFRESH_SEC old, falling back to
// ZEC_USD_FALLBACK. Money operations use moneyQuote(): live and at most PRICE_MAX_AGE_SEC
// old, never the fallback (unless ALLOW_PRICE_FALLBACK on testnet).
import { OneClickService, OpenAPI } from '@defuse-protocol/one-click-sdk-typescript';
import { cfg, models, type ModelInfo } from '../config.js';
import { errors, ZeepError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { q } from '../lib/db.js';
import { keys, redis } from '../lib/redis.js';

const KEY = keys.price;

interface Quote {
  usd: number;
  at: string;
  source: 'near-intents' | 'fallback';
}
let cache: { current: Quote; previous: Quote | null; fetchedAt: number } | undefined;

/**
 * The fallback price updates itself: every live quote is saved in Postgres (meta.last_zec_usd),
 * and when 1Click is unreachable the last live price is used. ZEC_USD_FALLBACK is only the
 * starting value before the first live quote ever. (Money still never moves at a fallback
 * price on mainnet; see moneyQuote.)
 */
async function lastLiveUsd(): Promise<number> {
  try {
    const r = await q<{ value: string }>(`SELECT value FROM meta WHERE key = 'last_zec_usd'`);
    const v = r[0] ? Number(JSON.parse(r[0].value).usd) : NaN;
    return v > 0 ? v : cfg.ZEC_USD_FALLBACK;
  } catch {
    return cfg.ZEC_USD_FALLBACK;
  }
}
async function saveLiveUsd(usd: number, at: string): Promise<void> {
  await q(`INSERT INTO meta (key, value) VALUES ('last_zec_usd', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify({ usd, at })]).catch(() => {});
}
const fallbackQuote = async (): Promise<Quote> => ({ usd: await lastLiveUsd(), at: new Date().toISOString(), source: 'fallback' });

async function fetchZecUsd(): Promise<Quote> {
  if (!cfg.NEAR_ONECLICK_JWT) return fallbackQuote();
  try {
    OpenAPI.BASE = cfg.NEAR_ONECLICK_BASE_URL;
    OpenAPI.TOKEN = cfg.NEAR_ONECLICK_JWT;
    const tokens = (await Promise.race([
      OneClickService.getTokens(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('1Click token list timed out')), 8_000)),
    ])) as Array<{ symbol?: string; blockchain?: string; price?: number | string }>;
    const zec = tokens.find((t) => t.symbol?.toUpperCase() === 'ZEC' && (t.blockchain ?? '').toLowerCase().includes('zec'))
      ?? tokens.find((t) => t.symbol?.toUpperCase() === 'ZEC');
    const usd = Number(zec?.price);
    if (!(usd > 0)) throw new Error('no ZEC price in token list');
    const at = new Date().toISOString();
    await saveLiveUsd(usd, at);
    return { usd, at, source: 'near-intents' };
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'ZEC price fetch failed; using the last live price');
    return fallbackQuote();
  }
}

/** Treasury job: refresh the shared quote every PRICE_REFRESH_SEC so it never goes stale. */
export async function refreshPrice(): Promise<Quote> {
  const fresh = await fetchZecUsd();
  const prev = cache?.current ?? null;
  const stored = { current: fresh, previous: prev };
  await redis.set(KEY, JSON.stringify(stored), 'EX', 24 * 3600).catch(() => {});
  cache = { ...stored, fetchedAt: Date.now() };
  return fresh;
}

/** Current and previous ZEC/USD quotes, shared across dynos through Redis. */
export async function zecQuotes(): Promise<{ current: Quote; previous: Quote | null }> {
  if (cache && Date.now() - cache.fetchedAt < 30_000) return cache;
  let stored: { current: Quote; previous: Quote | null } | null = null;
  try {
    const raw = await redis.get(KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  const stale = !stored || Date.now() - Date.parse(stored.current.at) > cfg.PRICE_REFRESH_SEC * 1000;
  if (stale) {
    const fresh = await fetchZecUsd();
    stored = { current: fresh, previous: stored?.current ?? null };
    await redis.set(KEY, JSON.stringify(stored), 'EX', 24 * 3600).catch(() => {});
  }
  cache = { ...stored!, fetchedAt: Date.now() };
  return cache;
}

/**
 * The quote money moves at. Throws 503 price_unavailable when no live quote can be had, so
 * nothing is credited or converted at a made-up or stale price (callers retry later).
 */
export async function moneyQuote(): Promise<Quote> {
  let q = (await zecQuotes()).current;
  if (Date.now() - Date.parse(q.at) > cfg.PRICE_MAX_AGE_SEC * 1000 || q.source === 'fallback') {
    const fresh = await fetchZecUsd();
    if (fresh.source !== 'fallback') {
      const stored = { current: fresh, previous: q };
      await redis.set(KEY, JSON.stringify(stored), 'EX', 24 * 3600).catch(() => {});
      cache = { ...stored, fetchedAt: Date.now() };
    }
    q = fresh;
  }
  // Testnet ZEC has no real value, so testnet may run on the fallback price; mainnet never.
  if (q.source === 'fallback' && !(cfg.ZEEP_ENV === 'testnet' || cfg.ALLOW_PRICE_FALLBACK)) {
    throw new ZeepError(503, 'price_unavailable', 'the ZEC price is unavailable right now; try again in a minute');
  }
  return q;
}

export const usdToZats = (usd: number, zecUsd: number): number => Math.ceil((usd * 1e8) / zecUsd);
export const zatsToMicroUsd = (zats: number | bigint, zecUsd: number): number => Math.floor((Number(zats) / 1e8) * zecUsd * 1e6);
export const microUsdToZats = (micro: number | bigint, zecUsd: number): number => Math.floor((Number(micro) / 1e6 / zecUsd) * 1e8);

/** What the user pays in USD: the upstream price plus PRICE_MARKUP_BPS. */
export const withMarkup = (usd: number): number => (usd * (10_000 + cfg.PRICE_MARKUP_BPS)) / 10_000;
export const toMicro = (usd: number): number => Math.ceil(Math.round(usd * 1e12) / 1e6);

/** What a request for an upstream price of `usd` costs, in micro-USD (markup included). */
export function requiredMicroUsd(usd: number): number {
  return usd <= 0 ? 0 : toMicro(withMarkup(usd));
}

export function routeUsd(key: string): number {
  const usd = cfg.SERVICE_PRICES_USD_JSON[key];
  if (usd === undefined) throw errors.forbidden(`${key} is disabled on this network`);
  return usd;
}

/** Research price for a Parallel processor. A flat legacy `research` price still works if set. */
export function researchUsd(processor: 'base' | 'core' | 'pro'): number {
  const prices = cfg.SERVICE_PRICES_USD_JSON;
  return routeUsd(prices[`research_${processor}`] !== undefined ? `research_${processor}` : 'research');
}

export function modelById(id: string): ModelInfo | undefined {
  return models().find((m) => m.id === id);
}

// ---------------------------------------------------------------- metered chat pricing
// Mirrored exactly in sdk/client.ts (chatCostMicro); test/unit.test.ts checks they agree.
/** Conservative token estimate for text: 1 token per 3 UTF-8 bytes (gateways count ~4–5). */
export const CHAT_BYTES_PER_TOKEN = 3;
/** Allowance per image (gateways don't count image bytes as text). */
export const CHAT_IMAGE_TOKENS = 1_500;
/** Per-message overhead (role, separators). */
export const CHAT_MESSAGE_TOKENS = 8;
/** A model that can't read images gets this text instead of each earlier image (chat context kept). */
export const IMAGE_PLACEHOLDER = '[image omitted: this model cannot see images]';
export const CHAT_PLACEHOLDER_TOKENS = 16;

type ChatMessage = { content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] };

export function chatInputTokens(messages: ChatMessage[], vision = true): number {
  let bytes = 0;
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') bytes += Buffer.byteLength(m.content, 'utf8');
    else for (const p of m.content) {
      if (p.type === 'text') bytes += Buffer.byteLength(p.text, 'utf8');
      else images++;
    }
  }
  return Math.ceil(bytes / CHAT_BYTES_PER_TOKEN) + images * (vision ? CHAT_IMAGE_TOKENS : CHAT_PLACEHOLDER_TOKENS) + messages.length * CHAT_MESSAGE_TOKENS;
}

/** True when the model is priced per request from its tokens (frontier models over MPP). */
export const isMetered = (m: ModelInfo) => m.in_usd_per_m !== undefined && m.out_usd_per_m !== undefined;

/** The output cap a request runs with: what the client asked for, never above the model's cap. */
export const chatOutputCap = (m: ModelInfo, requested?: number) => Math.min(requested ?? m.default_output, m.max_output);

/**
 * What a chat request costs, in micro-USD (markup included), and the output cap to enforce.
 * Metered: max(min, input tokens × in + output cap × out). Flat: the model price + extra MB.
 */
export function chatQuote(m: ModelInfo, body: { messages: ChatMessage[]; max_tokens?: number }, bodyBytes: number): { micro: number; maxTokens?: number; inputTokens: number } {
  const inputTokens = chatInputTokens(body.messages, m.vision);
  if (!isMetered(m)) return { micro: chatMicroUsd(m, bodyBytes), maxTokens: body.max_tokens, inputTokens };
  const maxTokens = chatOutputCap(m, body.max_tokens);
  const usd = Math.max(m.min_usd, (inputTokens * m.in_usd_per_m! + maxTokens * m.out_usd_per_m!) / 1e6);
  return { micro: requiredMicroUsd(usd), maxTokens, inputTokens };
}

/** Per-response price for a chat body of `bodyBytes` (attachments beyond 64 KB are metered). */
export function chatUsd(model: ModelInfo, bodyBytes: number): number {
  const extraMb = Math.max(0, Math.ceil((bodyBytes - 64 * 1024) / (1024 * 1024)));
  return model.usd + extraMb * cfg.ATTACHMENT_USD_PER_MB;
}

/**
 * What a chat request is charged, in micro-USD: exactly the sum of the published figures
 * (model.micro_usd + extra MB × attachments.micro_usd_per_mb), each marked up and rounded on its own.
 */
export function chatMicroUsd(model: ModelInfo, bodyBytes: number): number {
  const extraMb = Math.max(0, Math.ceil((bodyBytes - 64 * 1024) / (1024 * 1024)));
  return requiredMicroUsd(model.usd) + extraMb * requiredMicroUsd(cfg.ATTACHMENT_USD_PER_MB);
}

/** Public price sheet for the frontend. Every amount is what a request is actually charged. */
export async function priceSheet() {
  const q = await zecQuotes();
  const m = (usd: number) => requiredMicroUsd(usd);
  const cr = (usd: number) => m(usd) / cfg.MICRO_USD_PER_CREDIT;
  return {
    unit: 'micro_usd',
    micro_usd_per_credit: cfg.MICRO_USD_PER_CREDIT,
    markup_bps: cfg.PRICE_MARKUP_BPS,
    zec_usd: q.current.usd, // only used to show what a ZEC deposit will be worth
    zec_price_source: q.current.source,
    quoted_at: q.current.at,
    routes: Object.fromEntries(Object.entries(cfg.SERVICE_PRICES_USD_JSON).map(([k, usd]) => [k, { micro_usd: m(usd), credits: cr(usd) }])),
    models: models().map((x) => {
      // "From" price: a one-line message at the default output cap.
      const from = chatQuote(x, { messages: [{ content: 'hi' }] }, 64).micro;
      return {
        id: x.id, name: x.name, host: x.host, detail: x.detail, vision: x.vision,
        micro_usd: isMetered(x) ? from : m(x.usd),
        credits: (isMetered(x) ? from : m(x.usd)) / cfg.MICRO_USD_PER_CREDIT,
        // Metered models: the client computes the exact price with the same formula
        // (sdk chatCostMicro). Absent for flat-priced models.
        metered: isMetered(x)
          ? { in_usd_per_m: x.in_usd_per_m, out_usd_per_m: x.out_usd_per_m, min_usd: x.min_usd, default_output: x.default_output, max_output: x.max_output,
              context: x.context, bytes_per_token: CHAT_BYTES_PER_TOKEN, message_tokens: CHAT_MESSAGE_TOKENS,
              image_tokens: x.vision ? CHAT_IMAGE_TOKENS : CHAT_PLACEHOLDER_TOKENS }
          : null,
      };
    }),
    attachments: { free_kb: 64, micro_usd_per_mb: m(cfg.ATTACHMENT_USD_PER_MB), max_body_mb: cfg.CHAT_MAX_BODY_MB },
    default_model: cfg.DEFAULT_MODEL,
  };
}
