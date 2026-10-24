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

export function modelById(id: string): ModelInfo | undefined {
  return models().find((m) => m.id === id);
}

/** Per-response price for a chat body of `bodyBytes` (attachments beyond 64 KB are metered). */
export function chatUsd(model: ModelInfo, bodyBytes: number): number {
  const extraMb = Math.max(0, Math.ceil((bodyBytes - 64 * 1024) / (1024 * 1024)));
  return model.usd + extraMb * cfg.ATTACHMENT_USD_PER_MB;
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
    models: models().map((x) => ({
      id: x.id, name: x.name, host: x.host, detail: x.detail, vision: x.vision, micro_usd: m(x.usd), credits: cr(x.usd),
    })),
    attachments: { free_kb: 64, micro_usd_per_mb: m(cfg.ATTACHMENT_USD_PER_MB), max_body_mb: cfg.CHAT_MAX_BODY_MB },
    default_model: cfg.DEFAULT_MODEL,
  };
}
