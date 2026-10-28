// End-to-end on local Postgres + Redis with the Rust workers on the dev chain and mock
// conversion rails (1% cost, ZEC at $50), driven by the client SDK as the app uses it:
// deposit ZEC → 50% ZEC note + 50% dollar note (minus 1.5%) → the dollar half converted to
// USDC.e → pay for search + AI (real proofs) → replay 409 → underpay 402 → staged refill
// (ZEC → dollars) → withdraw from ZEC (instant) and beyond it (credits converted back,
// shielded) → restore from phrase → each asset covered, with a profit → vault.
// Run: npm run test:e2e   (needs Postgres, Redis, `cargo build` in rust/, circuits/)
import './setup-e2e.js';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { cfg } from '../src/config.js';
import { pool, q } from '../src/lib/db.js';
import { log } from '../src/lib/log.js';
import { redis } from '../src/lib/redis.js';
import { migrate } from '../src/migrate.js';
import { registry } from '../src/notes/registry.js';
import { buildApp } from '../src/server.js';
import { floatTick, zecOwedZats } from '../src/treasury/float.js';
import { checkRedisNetwork } from '../src/lib/redis.js';
import { checkDbNetwork } from '../src/migrate.js';
import { reserveBooks } from '../src/services/reserve.js';
import { housekeeping } from '../src/workers/treasury.js';
import { chatCostMicro, deriveKeys, estimateDeposit, NoteBook, ohttpFetch, seedFromPhrase, USD, ZEC, ZeepClient } from '../sdk/index';
import { innerHeaders, keyConfigs } from '../src/routes/ohttp.js';
import { b64, decodeRequest, encodeKeyConfig, encodeRequest, parseKeyConfig, REQ_MEDIA, sealRequest } from '../src/lib/ohttp.js';
const testKeyConfig = () => b64(keyConfigs()[0]);
import { nodeProve } from './helpers/prove.js';

const BIN = new URL('../rust/target/debug/', import.meta.url).pathname;
const DEV_GENESIS = 1_760_000_000;
const devHeight = () => Math.floor(Date.now() / 1000) - DEV_GENESIS; // DEV_BLOCK_SECS=1
const workers: ChildProcess[] = [];
let app: FastifyInstance;
let base = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(300);
  }
}

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await migrate();
  await redis.del('zeep:network');
  await checkRedisNetwork();
  const env = {
    ...process.env, CHAIN_BACKEND: 'dev', DEV_BLOCK_SECS: '1', DEV_GENESIS_UNIX: String(DEV_GENESIS),
    MIN_CONFIRMATIONS: '1', POLL_SECS: '1', LOG_LEVEL: 'warn', ADDRESS_POOL_MIN: '8',
  };
  for (const b of ['zeep-watcher', 'zeep-payouts']) workers.push(spawn(BIN + b, { env, stdio: ['ignore', 'inherit', 'inherit'] }));
  await registry.boot();
  registry.startActivator(300);
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await until(async () => (await q('SELECT 1 FROM deposit_addresses')).length >= 5);
});

after(async () => {
  workers.forEach((w) => w.kill('SIGTERM'));
  await app?.close();
  await registry.close();
  await redis.quit();
  await pool.end();
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

const phrase = generateMnemonic(wordlist, 256);
const NET = process.env.ZEEP_ENV === 'mainnet' ? 'mainnet' : 'testnet';
const keys = deriveKeys(seedFromPhrase(phrase), NET);
// ZEEP_E2E_OHTTP=1 runs every API call in this suite through Oblivious HTTP (and the server
// refuses anything else), proving the whole product works with OHTTP on.
const OHTTP = process.env.ZEEP_E2E_OHTTP === '1';
const http: typeof fetch = (url, init) => (OHTTP ? ohttpFetch({ baseUrl: base, keyConfig: testKeyConfig() }) : fetch)(url, init);
const alice = new ZeepClient({ baseUrl: '', keys, book: new NoteBook(), prove: nodeProve, fetch: http });

async function payInto(address: string, zats: number) {
  await q('INSERT INTO dev_incoming (txid, to_address, height, amount_zats) VALUES ($1, $2, $3, $4)', [
    crypto.randomUUID(), address, devHeight() - 1, zats,
  ]);
}

async function settleFloat() {
  for (let i = 0; i < 60; i++) {
    await floatTick();
    const [c] = await q(`SELECT count(*)::int AS n FROM conversions WHERE step NOT IN ('done','failed')`);
    const [w] = await q(`SELECT count(*)::int AS n FROM withdrawals WHERE status = 'converting'`);
    if (c.n === 0 && w.n === 0) return;
    await sleep(500);
  }
  throw new Error('float did not settle');
}

async function payOut(id: string) {
  await q(`UPDATE payouts SET scheduled_at = now() WHERE withdrawal_id = $1`, [id]);
  await until(async () => (await q(`SELECT 1 FROM withdrawals WHERE id = $1 AND status = 'done' AND payout_addr_enc IS NULL`, [id])).length > 0, 60_000);
}

const fee = (value: number, bps: number) => Math.ceil((value * bps) / 10_000);
const usdOf = (zats: number) => Math.floor((zats / 1e8) * 50 * 1e6); // ZEC at $50 (test price)
const MAIN = process.env.ZEEP_ENV === 'mainnet';
const SAPLING = (MAIN ? 'zs1' : 'ztestsapling1') + 'q'.repeat(75);
const TADDR = (MAIN ? 't1' : 'tm') + 'B'.repeat(33);

test('deposit any ZEC amount → half kept as ZEC, half fixed dollars minus 1.5%; first of the day gets its network fee back', { timeout: 90_000 }, async () => {
  (alice as unknown as { base: string }).base = base;
  // This test checks the 50/50 split on any amount; small deposits (all credits) have their own test.
  const smallCfg = cfg as { ALL_CREDITS_BELOW_MICRO_USD: number };
  const savedSmall = smallCfg.ALL_CREDITS_BELOW_MICRO_USD;
  smallCfg.ALL_CREDITS_BELOW_MICRO_USD = 0;
  const d1 = await alice.startDeposit(50_000_000n); // the user typed 0.5 ZEC
  const d2 = await alice.startDeposit(12_345_670n); // any amount, no plans
  assert.notEqual(d1.address, d2.address); // a fresh address per deposit, no memo needed
  assert.equal(d1.first_today, true);
  assert.equal(d2.first_today, false); // same user, same day: proven privately by the daily tag
  await payInto(d1.address, 50_000_000);
  await payInto(d2.address, 12_345_670);
  await until(async () => (await alice.depositStatus(d1.slot)).credited && (await alice.depositStatus(d2.slot)).credited);
  smallCfg.ALL_CREDITS_BELOW_MICRO_USD = savedSmall;
  const c1 = (await alice.depositStatus(d1.slot)).credited!;
  const c2 = (await alice.depositStatus(d2.slot)).credited!;
  assert.equal(c1.zec.amount_zats, 25_000_000); // 50% stays ZEC, no fee
  assert.equal(c1.usd.converted_zats, 25_000_000);
  assert.equal(c1.usd.value_micro_usd, 12_500_000); // 0.25 ZEC × $50
  assert.equal(c1.usd.fee_micro_usd, 187_500); // 1.5% of the converted half only
  assert.equal(c1.usd.rebate_micro_usd, 5_000); // the user's 10,000-zat network fee, back in dollars
  assert.equal(c1.usd.amount_micro_usd, 12_317_500);
  assert.equal(c2.zec.amount_zats, 6_172_835);
  assert.equal(c2.usd.rebate_micro_usd, 0);
  assert.equal(c2.usd.amount_micro_usd, c2.usd.value_micro_usd - fee(c2.usd.value_micro_usd, 150));
  assert.deepEqual(alice.balances(), { usd: BigInt(c1.usd.amount_micro_usd + c2.usd.amount_micro_usd), zec: 31_172_835n });
  // What the app shows as credits: dollars + ZEC at the live price.
  assert.equal(alice.totalMicroUsd(50), BigInt(c1.usd.amount_micro_usd + c2.usd.amount_micro_usd + usdOf(31_172_835)));

  // The treasury converts only the dollar halves to USDC.e; the ZEC halves stay shielded ZEC.
  await sleep(1500); // payouts worker reports the ZEC balance
  await settleFloat();
  const [f] = await q('SELECT tempo_usdc FROM float_state');
  const dollarHalves = c1.usd.value_micro_usd + c2.usd.value_micro_usd;
  assert.ok(Number(f.tempo_usdc) > 0.98 * dollarHalves && Number(f.tempo_usdc) < dollarHalves, `float holds the dollar halves: ${f.tempo_usdc}`);
  await sleep(1500);
  const [w] = await q('SELECT reserve_balance_zats FROM wallet_state');
  assert.ok(Number(w.reserve_balance_zats) >= 31_172_835, `reserve keeps the ZEC notes' ZEC: ${w.reserve_balance_zats}`);
});

test('pay for search and streamed AI in dollars with real proofs; the server never sees the balance', { timeout: 120_000 }, async () => {
  const prices = await alice.prices();
  const searchCost = BigInt(prices.routes.search.micro_usd);
  assert.equal(searchCost, 10_450n); // $0.01 + 4.5%
  const before = alice.balances();
  const body = JSON.stringify({ query: 'zcash shielded pools' });
  const res = await alice.pay('POST', '/v1/search', body, searchCost);
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok((await res.json()).results.length > 0);
  assert.deepEqual(alice.balances(), { usd: before.usd - searchCost, zec: before.zec }); // ZEC untouched

  const model = prices.models.find((m: { id: string }) => m.id === 'gpt-oss-20b');
  const chat = JSON.stringify({ model: model.id, stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const r2 = await alice.pay('POST', '/v1/ai/chat/completions', chat, BigInt(model.micro_usd));
  assert.equal(r2.status, 200);
  const sse = await r2.text();
  const text = [...sse.matchAll(/^data: (\{.*\})$/gm)].map((m) => JSON.parse(m[1]).choices[0].delta.content).join('');
  assert.match(text, /mock reply/);
  assert.match(sse, /^: open/); // first byte goes out immediately (Heroku 30 s rule)
  assert.equal(alice.balance(USD), before.usd - searchCost - BigInt(model.micro_usd));
  const cols = await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'`);
  assert.ok(!cols.some((c) => /balance/.test(c.column_name) && !/reserve/.test(c.column_name)));
});

test('metered frontier model: the app pays exactly the price; a cheaper proof is refused and corrected once', { timeout: 120_000 }, async () => {
  (cfg.MODELS_JSON as unknown[]).push({ id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', host: 'mpp', usd: 0, vision: true, detail: '', testnet: true,
    in_usd_per_m: 2, out_usd_per_m: 10, min_usd: 0.012, default_output: 4096, max_output: 16000 });
  try {
    const sheet = await alice.prices();
    const listed = sheet.models.find((m: { id: string }) => m.id === 'anthropic/claude-sonnet-5.5');
    assert.ok(listed.metered && listed.micro_usd > 40_000); // "from" price at the default 4096-token cap
    const raw = JSON.stringify({ model: listed.id, max_tokens: 512, messages: [{ role: 'user', content: 'word '.repeat(2000) }] });
    const cost = chatCostMicro(sheet, listed.id, raw);
    // A proof below the price is refused (nothing spent); the SDK then pays the exact price the
    // server names, once. This is how a reply the gateway counts higher than the app gets priced.
    const before = alice.balance(USD);
    const fixed = await alice.pay('POST', '/v1/ai/chat/completions', raw, cost - 1n);
    assert.equal(fixed.status, 200, await fixed.clone().text());
    assert.equal(alice.balance(USD), before - cost, 'charged exactly the price, once');
    const ok = await alice.pay('POST', '/v1/ai/chat/completions', raw, cost);
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(alice.balance(USD), before - 2n * cost);
  } finally {
    (cfg.MODELS_JSON as { id: string }[]).splice((cfg.MODELS_JSON as { id: string }[]).findIndex((m) => m.id === 'anthropic/claude-sonnet-5.5'), 1);
  }
});

test("the user's own daily limit: default $5, adjustable, counted only for payments that went through", { timeout: 120_000 }, async () => {
  assert.equal(alice.dailySpending().limit, 5_000_000n);
  const searchCost = BigInt((await alice.prices()).routes.search.micro_usd);
  const spent0 = alice.dailySpending().spent;
  const ok = await alice.pay('POST', '/v1/search', JSON.stringify({ query: 'limit check' }), searchCost);
  assert.equal(ok.status, 200);
  assert.equal(alice.dailySpending().spent, spent0 + searchCost);
  // Lower the limit below today's spending plus one search: the next one is refused on the device.
  await alice.setDailyLimit(spent0 + searchCost + searchCost / 2n);
  const before = alice.balance(USD);
  await assert.rejects(alice.pay('POST', '/v1/search', JSON.stringify({ query: 'over' }), searchCost), /daily spending limit/);
  assert.equal(alice.balance(USD), before); // nothing spent
  await alice.setDailyLimit(0n); // no limit
  assert.equal(alice.dailySpending().left, null);
  const again = await alice.pay('POST', '/v1/search', JSON.stringify({ query: 'no limit' }), searchCost);
  assert.equal(again.status, 200);
  await alice.setDailyLimit(5_000_000n);
});

test('switching models mid-chat keeps the context: earlier images become a note for text-only models; too-long chats refused before payment', { timeout: 120_000 }, async () => {
  const add = [
    { id: 'deepseek/deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro', host: 'mpp', usd: 0, vision: false, detail: '', testnet: true, in_usd_per_m: 1.32, out_usd_per_m: 3.96, min_usd: 0.012, default_output: 4096, max_output: 16000, context: 1_000_000 },
    { id: 'test/tiny-context', name: 'Tiny', host: 'mpp', usd: 0, vision: true, detail: '', testnet: true, in_usd_per_m: 1, out_usd_per_m: 1, min_usd: 0.012, default_output: 1024, max_output: 2048, context: 5000 },
  ];
  (cfg.MODELS_JSON as unknown[]).push(...add);
  try {
    const sheet = await alice.prices();
    const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } };
    // The chat started on a vision model with a photo; the user now switches to DeepSeek (text only).
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'what is in this photo?' }, img] },
      { role: 'assistant', content: 'A cat on a sofa.' },
      { role: 'user', content: 'what colour was the sofa?' },
    ];
    const raw = JSON.stringify({ model: 'deepseek/deepseek-v4-pro-0813', messages: history });
    const before = alice.balance(USD);
    const cost = chatCostMicro(sheet, 'deepseek/deepseek-v4-pro-0813', raw);
    const r = await alice.pay('POST', '/v1/ai/chat/completions', raw, cost);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(alice.balance(USD), before - cost);
    // A NEW image to a text-only model is still refused, and nothing is charged.
    const raw2 = JSON.stringify({ model: 'deepseek/deepseek-v4-pro-0813', messages: [{ role: 'user', content: [{ type: 'text', text: 'and this?' }, img] }] });
    const b2 = alice.balance(USD);
    const r2 = await alice.pay('POST', '/v1/ai/chat/completions', raw2, chatCostMicro(sheet, 'deepseek/deepseek-v4-pro-0813', raw2));
    assert.equal(r2.status, 400);
    assert.equal(alice.balance(USD), b2);
    // Switching to a model with a smaller context than the chat: refused before payment.
    const long = JSON.stringify({ model: 'test/tiny-context', messages: [{ role: 'user', content: 'word '.repeat(4000) }] });
    const b3 = alice.balance(USD);
    const r3 = await alice.pay('POST', '/v1/ai/chat/completions', long, chatCostMicro(sheet, 'test/tiny-context', long));
    assert.equal(r3.status, 400);
    assert.equal((await r3.json()).error.code, 'context_too_long');
    assert.equal(alice.balance(USD), b3);
  } finally {
    for (const m of add) (cfg.MODELS_JSON as { id: string }[]).splice((cfg.MODELS_JSON as { id: string }[]).findIndex((x) => x.id === m.id), 1);
  }
});

test('replays are refused (409) and underpaying is refused (402) without losing money', { timeout: 120_000 }, async () => {
  const prices = await alice.prices();
  const cost = BigInt(prices.routes.search.micro_usd);
  let captured: { url: string; init: RequestInit } | undefined;
  const spy = new ZeepClient({
    baseUrl: base, keys, book: alice.book, prove: nodeProve,
    fetch: async (url, init) => {
      if (String(url).endsWith('/v1/search')) captured = { url: String(url), init: init! };
      return http(url, init);
    },
  });
  assert.equal((await spy.pay('POST', '/v1/search', JSON.stringify({ query: 'replay me' }), cost)).status, 200);
  assert.equal((await http(captured!.url, captured!.init)).status, 409);
  const before = alice.balances();
  const low = await alice.pay('POST', '/v1/search', JSON.stringify({ query: 'cheap' }), cost - 1n);
  assert.equal(low.status, 402);
  assert.deepEqual(alice.balances(), before);
});

test('staged refill: when dollars fall to 5% of the last top-up, 50% of the ZEC converts (minus 1.5%)', { timeout: 120_000 }, async () => {
  const cost = BigInt((await alice.prices()).routes.search.micro_usd);
  const before = alice.balances();
  assert.equal(alice.book.refill.stage, 0);
  // Pretend the last top-up was large, so the dollar balance is now under 5% of it.
  alice.book.refill.base = (before.usd * 25n).toString();
  const res = await alice.pay('POST', '/v1/search', JSON.stringify({ query: 'refill me' }), cost);
  assert.equal(res.status, 200);
  const half = before.zec / 2n;
  const added = BigInt(usdOf(Number(half)) - fee(usdOf(Number(half)), 150));
  assert.deepEqual(alice.balances(), { usd: before.usd + added - cost, zec: before.zec - half });
  assert.equal(alice.book.refill.stage, 1);
  assert.equal(alice.book.refill.base, (before.usd + added).toString()); // the new top-up level
  // The refill's ZEC is now surplus: the float converts it to USDC.e.
  await sleep(1500);
  await settleFloat();
  const [c] = await q(`SELECT count(*)::int AS n FROM conversions WHERE direction = 'to_tempo' AND step = 'done'`);
  assert.ok(c.n >= 2);
});

test('withdraw: from ZEC instantly; beyond the ZEC balance credits convert back (shielded) after confirmation', { timeout: 240_000 }, async () => {
  // 1) Covered by the ZEC balance: no conversion, no conversion fee, scheduled at once.
  const zec0 = alice.balance(ZEC);
  const p1 = await alice.planWithdrawal(4_000_000n);
  assert.equal(p1.needsConversion, false);
  assert.equal(p1.networkFeesCovered, true); // first of the day: the plan shows the full amount arriving
  assert.equal(p1.estimatedZats, 4_000_000n);
  const w1 = await alice.withdraw(p1, SAPLING);
  assert.equal(w1.status, 'scheduled');
  assert.equal(w1.processing.converting, false);
  assert.equal(w1.conversion_fee_micro_usd, 0);
  assert.equal(w1.network_fees_paid_by, 'zeep'); // first withdrawal of the day
  assert.equal(w1.estimated_zec_zats, 4_000_000);
  assert.equal(alice.balance(ZEC), zec0 - 4_000_000n);

  // 2) Transparent needs the opt-in; the second withdrawal today pays its own network fees.
  const taddr = TADDR;
  const p2 = await alice.planWithdrawal(2_500_000n);
  assert.equal(p2.networkFeesCovered, false); // second today: the plan already takes the fees off
  assert.equal(p2.networkFeeZats, 20_000n);
  assert.equal(p2.estimatedZats, 2_480_000n);
  await assert.rejects(alice.withdraw(p2, taddr), /allow_transparent/);
  const w2 = await alice.withdraw(p2, taddr, { allowTransparent: true });
  assert.equal(w2.network_fees_paid_by, 'you');
  assert.equal(w2.estimated_zec_zats, 2_500_000 - 20_000);
  assert.equal(BigInt(w2.estimated_zec_zats), p2.estimatedZats); // plan and server agree
  assert.equal(w2.transparent, true);
  assert.match(w2.warning, /public/);

  // 3) More than the ZEC balance: the plan says to ask the user to convert credits.
  const before = alice.balances();
  const p3 = await alice.planWithdrawal(before.zec + 10_000_000n);
  assert.equal(p3.needsConversion, true);
  assert.equal(p3.zecZats, before.zec);
  assert.ok(p3.usdMicro > 5_000_000n);
  // (the app shows the prompt and re-checks the PIN / passkey / phrase here)
  const w3 = await alice.withdraw(p3, SAPLING);
  assert.equal(w3.status, 'converting');
  assert.match(w3.processing.message, /converting your credits back to ZEC/);
  assert.equal(w3.conversion_fee_micro_usd, fee(Number(p3.usdMicro), 150)); // only on the credits converted
  assert.deepEqual(alice.balances(), { usd: before.usd - p3.usdMicro, zec: 0n });
  assert.equal((await alice.withdrawalStatus(w3.withdrawal_id)).status, 'converting');

  await settleFloat(); // USDC.e → Base → ZEC (returned to the t-address, then shielded); tranches scheduled
  const st = await alice.withdrawalStatus(w3.withdrawal_id);
  assert.equal(st.status, 'scheduled');
  const expected = ((Number(p3.usdMicro) - w3.conversion_fee_micro_usd) / 1e6 / 50) * 1e8;
  assert.ok(Math.abs(st.zec_received_zats - expected * 0.99) < expected * 0.01, `${st.zec_received_zats} vs ${expected}`);
  const sent = st.tranches.reduce((a: number, x: { amount_zats: number }) => a + x.amount_zats, 0);
  assert.equal(sent, Number(p3.zecZats) - 20_000 + st.zec_received_zats); // ZEC part + converted ZEC − network fees
  await sleep(1500);
  for (const w of [w1, w2, w3]) await payOut(w.withdrawal_id);
  const done = await alice.withdrawalStatus(w3.withdrawal_id);
  assert.ok(done.tranches.length === 2 && done.tranches.every((x: { status: string; txid: string }) => x.status === 'confirmed' && x.txid));
});

test('safety: housekeeping never touches a withdrawal that is still converting credits', { timeout: 180_000 }, async () => {
  const p = await alice.planWithdrawal(1_000_000n); // the ZEC balance is empty now: all from credits
  assert.equal(p.needsConversion, true);
  const w = await alice.withdraw(p, SAPLING);
  assert.equal(w.status, 'converting');
  await housekeeping(); // runs hourly in production
  const [row] = await q<{ status: string; enc: string | null }>('SELECT status, payout_addr_enc AS enc FROM withdrawals WHERE id = $1', [w.withdrawal_id]);
  assert.equal(row.status, 'converting');
  assert.ok(row.enc, 'payout address kept while converting');
  await settleFloat();
  await sleep(1500);
  await payOut(w.withdrawal_id);
  await housekeeping();
  assert.equal((await alice.withdrawalStatus(w.withdrawal_id)).status, 'done');
});

test('safety: two payments to one deposit address become one credit plus a claim (no duplicate notes)', { timeout: 120_000 }, async () => {
  const before = alice.balances();
  const d = await alice.startDeposit(4_000_000n);
  await payInto(d.address, 4_000_000);
  await payInto(d.address, 2_000_000); // same block: the activator sees both in one batch
  // Whichever poll first sees the second payment as unclaimed claims it and returns the new slot.
  let claim: { slot: number } | undefined;
  await until(async () => {
    const s = await alice.depositStatus(d.slot);
    claim ??= s.claim;
    return !!s.credited && !!claim;
  });
  const st = await alice.depositStatus(d.slot);
  assert.equal(st.claim, undefined); // claimed once, not again
  const claimSlot = claim!.slot;
  assert.notEqual(claimSlot, d.slot);
  assert.ok(alice.book.pendingDeposits.includes(claimSlot), 'the claim is tracked for polling');
  assert.ok(!alice.book.pendingDeposits.includes(d.slot), 'the credited slot is done');
  await until(async () => { await alice.pollDeposits(); return !alice.book.pendingDeposits.includes(claimSlot); });
  const c1 = st.credited!;
  const c2 = (await alice.depositStatus(claimSlot)).credited!;
  assert.equal(c1.zec_zats + c2.zec_zats, 6_000_000); // both payments credited, once each
  assert.equal(alice.balance(ZEC), before.zec + BigInt(c1.zec.amount_zats + c2.zec.amount_zats));
  const [dup] = await q<{ n: number }>('SELECT count(*)::int AS n FROM (SELECT commitment FROM notes GROUP BY commitment HAVING count(*) > 1) x');
  assert.equal(dup.n, 0);
  await sleep(1500);
  await settleFloat();
});

test('a later payment to an already-credited address is found by pollDeposits() and claimed', { timeout: 120_000 }, async () => {
  const d = await alice.startDeposit(3_000_000n);
  await payInto(d.address, 3_000_000);
  await until(async () => !!(await alice.depositStatus(d.slot)).credited);
  assert.ok(!alice.book.pendingDeposits.includes(d.slot));
  assert.ok(alice.book.watchedDeposits[d.slot] > Date.now()); // still watched
  const zec0 = alice.balance(ZEC);
  const usd0 = alice.balance(USD);
  await payInto(d.address, 1_000_000); // someone reuses the address later ($0.50: small, so all credits)
  await until(async () => {
    alice.book.lastWatchCheck = 0; // the app polls every few seconds; the watch runs every 10 min
    await alice.pollDeposits();
    return alice.balance(USD) >= usd0 + 492_500n;
  });
  assert.equal(alice.balance(ZEC), zec0);
  await sleep(1500);
  await settleFloat();
});

test('daily deposit limit: a payment over it shows as queued until the next UTC day, never stuck', { timeout: 120_000 }, async () => {
  const [{ z }] = await q<{ z: string }>(`SELECT COALESCE(SUM(amount_zats),0) AS z FROM deposits WHERE status = 'credited' AND credited_on = CURRENT_DATE`);
  const c = cfg as { MAX_DEPOSIT_ZATS_PER_DAY?: number };
  const saved = c.MAX_DEPOSIT_ZATS_PER_DAY;
  c.MAX_DEPOSIT_ZATS_PER_DAY = Number(z) + 1_000_000; // only 0.01 ZEC left today
  try {
    const d = await alice.startDeposit(3_000_000n);
    await payInto(d.address, 3_000_000);
    await until(async () => (await alice.depositStatus(d.slot)).status === 'queued');
    const st = await alice.depositStatus(d.slot);
    assert.equal(st.queued?.reason, 'daily_limit');
    assert.equal(st.queued?.amount_zats, 3_000_000);
    assert.equal(new Date(st.queued!.until!).getUTCHours(), 0);
    await housekeeping(); // must not expire an intent whose payment is waiting
    assert.notEqual((await alice.depositStatus(d.slot)).status, 'expired');
    c.MAX_DEPOSIT_ZATS_PER_DAY = saved; // "the next day"
    await until(async () => (await alice.depositStatus(d.slot)).credited);
    assert.ok(!alice.book.pendingDeposits.includes(d.slot));
  } finally {
    c.MAX_DEPOSIT_ZATS_PER_DAY = saved;
  }
  await sleep(1500);
  await settleFloat();
});

test('safety: deposits still confirming count as owed ZEC, so the float never converts them', async () => {
  const [i] = await q<{ id: string }>('SELECT id FROM deposit_intents LIMIT 1');
  const before = await zecOwedZats();
  await q('INSERT INTO deposit_sightings (intent_id, txid_hash, amount_zats, confirmations) VALUES ($1, $2, $3, 0)', [i.id, 'test-sighting', 100_000_000]);
  assert.equal(await zecOwedZats(), before + 100_000_000);
  await q(`DELETE FROM deposit_sightings WHERE txid_hash = 'test-sighting'`);
});

test('network guard: every process refuses a database or Redis that belongs to the other network', { timeout: 60_000 }, async () => {
  const other = MAIN ? 'testnet' : 'mainnet';
  await q(`UPDATE meta SET value = $1 WHERE key = 'network'`, [other]);
  try {
    await assert.rejects(checkDbNetwork(), new RegExp(`belongs to ${other}`));
    // The Rust workers refuse too, before touching the wallet.
    const out = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const p = spawn(BIN + 'zeep-watcher', { env: { ...process.env, CHAIN_BACKEND: 'dev', POLL_SECS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stdout!.on('data', (b) => (err += b));
      p.stderr!.on('data', (b) => (err += b));
      p.on('exit', (code) => resolve({ code, err }));
    });
    assert.notEqual(out.code, 0);
    assert.match(out.err, /belongs to/);
  } finally {
    await q(`UPDATE meta SET value = $1 WHERE key = 'network'`, [MAIN ? 'mainnet' : 'testnet']);
  }
  await redis.set('zeep:network', other);
  try {
    await assert.rejects(checkRedisNetwork(), /belongs to/);
  } finally {
    await redis.set('zeep:network', MAIN ? 'mainnet' : 'testnet');
  }
  // And a worker whose ZEEP_ENV and ZCASH_NETWORK disagree won't start at all.
  const bad = await new Promise<number | null>((resolve) => {
    const p = spawn(BIN + 'zeep-payouts', { env: { ...process.env, ZCASH_NETWORK: MAIN ? 'test' : 'main' }, stdio: 'ignore' });
    p.on('exit', resolve);
  });
  assert.notEqual(bad, 0);
});

test('restore from the 24 words alone finds both exact balances', { timeout: 120_000 }, async () => {
  const fresh = new ZeepClient({ baseUrl: base, keys: deriveKeys(seedFromPhrase(phrase), NET), book: new NoteBook(), prove: nodeProve, fetch: http });
  await fresh.restore();
  assert.deepEqual(fresh.balances(), alice.balances());
  assert.ok(fresh.book.nextDeposit >= 2);
});

test('reserve: ZEC held covers ZEC owed, dollars held cover dollars owed, and the fees leave a profit', async () => {
  await sleep(1500);
  const b = await reserveBooks(); // exact (the public endpoint is rounded)
  assert.equal(b.usd.notes_micro_usd, Number(alice.balance(USD)), JSON.stringify(b));
  assert.equal(b.zec.notes_zats, Number(alice.balance(ZEC)), JSON.stringify(b));
  assert.ok(b.zec.coverage_bps >= 10_000, JSON.stringify(b.zec));
  assert.ok(b.usd.coverage_bps >= 10_000, JSON.stringify(b.usd));
  assert.ok(b.profit.conversion_fees_micro_usd > b.profit.conversion_costs_micro_usd, JSON.stringify(b.profit));
  assert.ok(b.profit.net_micro_usd > 0, JSON.stringify(b.profit));
  console.log('reserve', JSON.stringify({ zec: b.zec, usd: b.usd, coverage_pct: b.coverage_pct, profit: b.profit }));
  const pub = await (await http(`${base}/v1/reserve`)).json();
  assert.equal(pub.usd.owed_micro_usd % 1_000_000, 0); // published rounded to $1
  assert.equal(pub.zec.owed_zats % 1_000_000, 0); // and 0.01 ZEC
});

test('testnet on a real chain: credits convert back from the reserve (simulated rails), no ZEC sent to fake addresses', { timeout: 180_000 }, async () => {
  const c = cfg as { CHAIN_BACKEND: string };
  const saved = c.CHAIN_BACKEND;
  const d = await alice.startDeposit(20_000_000n);
  await payInto(d.address, 20_000_000);
  await until(async () => !!(await alice.depositStatus(d.slot)).credited);
  c.CHAIN_BACKEND = 'lightclient'; // what Heroku testnet runs
  try {
    // An older build's surplus conversion to a fake rails address gets cancelled, not sent.
    const [pay] = await q<{ id: string }>(`INSERT INTO payouts (kind, dest_address, amount_zats, scheduled_at) VALUES ('conversion', 'tmMockDeposit1', 1000, now() + interval '1 day') RETURNING id`);
    await q(`INSERT INTO conversions (direction, reason, step, zec_zats, zec_usd, oneclick_deposit, payout_id) VALUES ('to_tempo','surplus','zec_sending',1000,50,'tmMockDeposit1',$1)`, [pay.id]);
    const open0 = await q(`SELECT 1 FROM conversions WHERE direction = 'to_tempo' AND step NOT IN ('done','failed')`);
    assert.equal(open0.length, 1);

    const before = alice.balances();
    const p = await alice.planWithdrawal(before.zec + 2_000_000n); // needs credits converted back
    assert.equal(p.needsConversion, true);
    const w = await alice.withdraw(p, SAPLING);
    assert.equal(w.status, 'converting');
    await floatTick();

    assert.equal((await q(`SELECT 1 FROM conversions WHERE direction = 'to_tempo' AND step NOT IN ('done','failed')`)).length, 0);
    const [po] = await q<{ status: string }>('SELECT status FROM payouts WHERE id = $1', [pay.id]);
    assert.equal(po.status, 'failed'); // never sent to the fake address
    const st = await alice.withdrawalStatus(w.withdrawal_id);
    assert.equal(st.status, 'scheduled'); // converted at once from the reserve
    const [conv] = await q<{ step: string; relay_request: string }>('SELECT step, relay_request FROM conversions WHERE withdrawal_id = $1', [w.withdrawal_id]);
    assert.deepEqual(conv, { step: 'done', relay_request: 'testnet-simulated' });
    const expected = ((Number(p.usdMicro) - w.conversion_fee_micro_usd) / 1e6 / 50) * 1e8 * 0.99;
    assert.ok(Math.abs(st.zec_received_zats - expected) <= 2, `${st.zec_received_zats} vs ${expected}`);
    await floatTick(); // idempotent: nothing booked twice
    assert.equal((await q('SELECT 1 FROM conversions WHERE withdrawal_id = $1', [w.withdrawal_id])).length, 1);
    c.CHAIN_BACKEND = saved;
    await sleep(1500);
    await payOut(w.withdrawal_id);
  } finally {
    c.CHAIN_BACKEND = saved;
  }
});

test('anonymous inbox: create, list, read the full letter, send, reply, delete; id never in a URL', { timeout: 120_000 }, async () => {
  const prices = await alice.prices();
  const sendCost = BigInt(prices.routes.inbox_send.micro_usd);
  const usd0 = alice.balance(USD);
  const box = await alice.createInbox();
  assert.match(box.inbox_id, /^ibx_/);
  assert.equal(alice.balance(USD), usd0 - BigInt(prices.routes.inbox.micro_usd));

  const page = await alice.inboxMessages(box.inbox_id);
  assert.equal(page.messages.length, 1);
  const item = page.messages[0];
  assert.ok(item.preview.length > 0 && item.preview.length <= 200);
  assert.equal(item.read, false);
  const full = await alice.readMessage(box.inbox_id, item.id);
  assert.match(full.text!, /Real mail arrives/); // the full letter, not the preview
  assert.match(full.html!, /<p>/);

  const usd1 = alice.balance(USD);
  const sent = await alice.sendEmail(box.inbox_id, { to: ['bob@example.com'], subject: 'hi', text: 'hello' });
  assert.ok(sent.message_id);
  const rep = await alice.replyEmail(box.inbox_id, item.id, { text: 'thanks' });
  assert.ok(rep.message_id);
  assert.equal(alice.balance(USD), usd1 - 2n * sendCost);

  // Bad input is refused before any payment.
  await assert.rejects(alice.sendEmail(box.inbox_id, { to: ['not-an-address'], subject: 'x', text: 'y' }), /not an email address/);
  await assert.rejects(alice.sendEmail(box.inbox_id, { to: ['a@example.com'], subject: 'x' }), /write a message/);
  await assert.rejects(alice.sendEmail(box.inbox_id, { to: Array.from({ length: 11 }, (_, i) => `u${i}@example.com`), subject: 'x', text: 'y' }), /at most 10/);
  assert.equal(alice.balance(USD), usd1 - 2n * sendCost);

  // Delete hides it at once.
  const del = await alice.deleteMessage(box.inbox_id, item.id);
  assert.equal(del.deleted, true);
  assert.equal((await alice.inboxMessages(box.inbox_id)).messages.length, 0);
  await assert.rejects(alice.readMessage(box.inbox_id, item.id), /not found/);

  // Unknown inbox: 404; the old GET route with the id in the path is gone.
  await assert.rejects(alice.inboxMessages('ibx_' + 'A'.repeat(32)), /not found/);
  assert.equal((await http(`${base}/v1/inbox/${box.inbox_id}/messages`)).status, 404);

  // Daily send limit: refused without charging.
  const c = cfg as { INBOX_SENDS_PER_DAY: number };
  const saved = c.INBOX_SENDS_PER_DAY;
  c.INBOX_SENDS_PER_DAY = 2;
  try {
    const usd2 = alice.balance(USD);
    await assert.rejects(alice.sendEmail(box.inbox_id, { to: ['bob@example.com'], subject: 'x', text: 'y' }), /2 emails a day/);
    assert.equal(alice.balance(USD), usd2);
  } finally {
    c.INBOX_SENDS_PER_DAY = saved;
  }

  // Expired inboxes are deleted at the provider and forgotten.
  await q(`UPDATE inboxes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [box.inbox_id]);
  await housekeeping();
  assert.equal((await q('SELECT 1 FROM inboxes WHERE id = $1', [box.inbox_id])).length, 0);
});

test('encrypted vault: chat items with 30-day auto-delete, auth required', async () => {
  const url = `${base}/v1/vault/items/chat-1`;
  const h = { 'content-type': 'application/json', 'x-vault-id': keys.vaultId, 'x-vault-auth': keys.vaultAuth };
  const expires = new Date(Date.now() + 30 * 86_400_000).toISOString();
  assert.equal((await http(url, { method: 'PUT', headers: h, body: JSON.stringify({ blob: 'AAAA', expires_at: expires }) })).status, 204);
  assert.equal((await (await http(url, { headers: h })).json()).blob, 'AAAA');
  assert.equal((await http(url, { headers: { ...h, 'x-vault-auth': 'f'.repeat(64) } })).status, 401);
  await q(`UPDATE vault_items SET expires_at = now() - interval '1 second'`);
  assert.equal((await http(url, { headers: h })).status, 404);
  assert.equal((await http(`${base}/v1/vault`, { method: 'DELETE', headers: h })).status, 204);
});

// ------------------------------------------------------------------ adversarial: money-loss channels
// Each test tries to get something for nothing and checks the books to the micro-dollar.
const svcBooks = async () => {
  const [r] = await q<{ s: string; c: string }>(`SELECT COALESCE(SUM(amount),0) AS s, COALESCE(SUM(count),0) AS c FROM books_daily WHERE kind = 'service'`);
  const [k] = await q<{ s: string; c: string }>(`SELECT COALESCE(SUM(amount),0) AS s, COALESCE(SUM(count),0) AS c FROM books_daily WHERE kind = 'compensation'`);
  return { service: BigInt(r.s), serviceN: Number(r.c), comp: BigInt(k.s), compN: Number(k.c) };
};
/** A fetch that records every request, so a test can replay the exact bytes (proof headers included). */
function recorder() {
  const sent: { url: string; init: RequestInit }[] = [];
  const f = ((url: string, init: RequestInit = {}) => { sent.push({ url, init }); return http(url, init); }) as typeof fetch;
  return { sent, f };
}
/** A fetch that withholds the paid request (keeping its exact bytes) and passes everything else through. */
const holdProof = (keep: (c: { url: string; init: RequestInit }) => void) => (async (url: string, init: RequestInit = {}) => {
  if (!(init.headers as Record<string, string> | undefined)?.['x-zeep-proof']) return http(url, init);
  keep({ url, init });
  return new Response('{"error":{"code":"held","message":"held by the test"}}', { status: 599 });
}) as typeof fetch;
const mPhrase = generateMnemonic(wordlist, 256);
const mKeys = deriveKeys(seedFromPhrase(mPhrase), NET);
const rec = recorder();
const mallory = new ZeepClient({ baseUrl: '', keys: mKeys, book: new NoteBook(), prove: nodeProve, fetch: rec.f });

test('adversarial setup: mallory deposits 0.2 ZEC', { timeout: 120_000 }, async () => {
  (mallory as unknown as { base: string }).base = base;
  const d = await mallory.startDeposit(20_000_000n, undefined, false);
  await payInto(d.address, 20_000_000);
  await until(async () => !!(await mallory.depositStatus(d.slot)).credited);
  assert.ok(mallory.balance(USD) > 4_000_000n);
});

test('adversarial: the same paid request sent twice at once is charged once and served once', { timeout: 120_000 }, async () => {
  const cost = BigInt((await mallory.prices()).routes.search.micro_usd);
  const before = await svcBooks();
  const r1 = await mallory.pay('POST', '/v1/search', JSON.stringify({ query: 'race' }), cost);
  assert.equal(r1.status, 200);
  const last = rec.sent[rec.sent.length - 1];
  // Replay the identical bytes twice in parallel (a malicious client or a retrying proxy).
  const [a, b] = await Promise.all([http(last.url, last.init), http(last.url, last.init)]);
  assert.deepEqual([a.status, b.status], [409, 409]);
  const after = await svcBooks();
  assert.equal(after.service - before.service, cost); // one charge
  assert.equal(after.serviceN - before.serviceN, 1);
});

test('adversarial: two simultaneous first uses of one proof → exactly one succeeds', { timeout: 120_000 }, async () => {
  const cost = BigInt((await mallory.prices()).routes.search.micro_usd);
  const before = await svcBooks();
  // Capture a fresh proof without sending it, then fire it twice concurrently.
  let captured: { url: string; init: RequestInit } | undefined;
  const hold = new ZeepClient({ baseUrl: base, keys: mKeys, book: mallory.book, prove: nodeProve,
    fetch: holdProof((c) => (captured = c)) });
  await hold.pay('POST', '/v1/search', JSON.stringify({ query: 'twin' }), cost).catch(() => {});
  assert.ok(captured);
  const rs = await Promise.all([http(captured!.url, captured!.init), http(captured!.url, captured!.init)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  const after = await svcBooks();
  assert.equal(after.service - before.service, cost);
  await mallory.restore();
});

test('adversarial: a proof is bound to its route and body (no reuse elsewhere, no free upgrade)', { timeout: 120_000 }, async () => {
  const p = await mallory.prices();
  const cost = BigInt(p.routes.search.micro_usd);
  const before = await svcBooks();
  let captured: { url: string; init: RequestInit } | undefined;
  const hold = new ZeepClient({ baseUrl: base, keys: mKeys, book: mallory.book, prove: nodeProve,
    fetch: holdProof((c) => (captured = c)) });
  await hold.pay('POST', '/v1/search', JSON.stringify({ query: 'cheap' }), cost).catch(() => {});
  const h = captured!.init.headers as Record<string, string>;
  // Same proof, different body (a longer query) and different routes (research, an AI reply).
  const other = await http(`${base}/v1/search`, { method: 'POST', headers: h, body: JSON.stringify({ query: 'something else entirely' }) });
  const research = await http(`${base}/v1/research`, { method: 'POST', headers: h, body: JSON.stringify({ query: 'cheap', processor: 'pro' }) });
  const chat = await http(`${base}/v1/ai/chat/completions`, { method: 'POST', headers: h, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  for (const r of [other, research, chat]) assert.ok([401, 402, 422].includes(r.status), `status ${r.status}`); // refused before any note is burnt
  assert.equal((await svcBooks()).service, before.service); // nothing charged
  // The untouched proof still works exactly once for its own request.
  const ok = await http(captured!.url, captured!.init);
  assert.equal(ok.status, 200);
  // The app never saw that reply, so it lost track of its change; the 24 words get it back.
  await mallory.restore();
  assert.ok(mallory.balance(USD) > 0n, 'change from a hand-sent proof is recoverable');
});

test('adversarial: underpaying and wildly overpaying are refused without losing the notes', { timeout: 120_000 }, async () => {
  const cost = BigInt((await mallory.prices()).routes.search.micro_usd);
  const usd0 = mallory.balance(USD);
  const under = await mallory.pay('POST', '/v1/search', JSON.stringify({ query: 'under' }), cost - 1n);
  assert.equal(under.status, 402);
  const over = await mallory.pay('POST', '/v1/search', JSON.stringify({ query: 'over' }), cost * 5n);
  assert.ok(over.status >= 400);
  assert.equal(mallory.balance(USD), usd0);
});

test('adversarial: a failed upstream refunds exactly once; replaying the failed proof gets nothing', { timeout: 120_000 }, async () => {
  const cost = BigInt((await mallory.prices()).routes.search.micro_usd);
  const c = cfg as { MPP_DAILY_BUDGET_USD: number };
  const saved = c.MPP_DAILY_BUDGET_USD;
  const usd0 = mallory.balance(USD);
  const before = await svcBooks();
  c.MPP_DAILY_BUDGET_USD = 0; // the provider can't be paid → request fails before Zeep pays
  let failed: Response;
  try {
    failed = await mallory.pay('POST', '/v1/search', JSON.stringify({ query: 'refund me' }), cost);
  } finally {
    c.MPP_DAILY_BUDGET_USD = saved;
  }
  assert.equal(failed!.status, 503);
  assert.equal(mallory.balance(USD), usd0); // refunded as a new note
  const last = rec.sent[rec.sent.length - 1];
  const replay = await http(last.url, last.init); // budget is back: try to get it served for free
  assert.equal(replay.status, 409);
  const after = await svcBooks();
  assert.equal(after.compN - before.compN, 1);
  assert.equal(after.service - before.service, cost); // charged once…
  assert.equal(after.comp - before.comp, cost); // …and returned once
});

test('adversarial: two devices spend the same notes at once (service + withdrawal) → only one goes through', { timeout: 180_000 }, async () => {
  await mallory.refreshSpent();
  // Device B: a copy of mallory's book (same 24 words on a second device).
  const bookB = NoteBook.from(JSON.parse(JSON.stringify(mallory.book.toJSON())));
  const deviceB = new ZeepClient({ baseUrl: base, keys: mKeys, book: bookB, prove: nodeProve, fetch: http });
  const usd = mallory.balance(USD);
  const cost = BigInt((await mallory.prices()).routes.search.micro_usd);
  // Mallory's credits (~$4.9) are under the $5 convert-back minimum; lower it so device B's
  // withdrawal really races device A for the same dollar notes.
  const c = cfg as { MIN_CONVERT_BACK_MICRO_USD: number };
  const savedMin = c.MIN_CONVERT_BACK_MICRO_USD;
  c.MIN_CONVERT_BACK_MICRO_USD = 1_000_000;
  let pay: PromiseSettledResult<Response>, wd: PromiseSettledResult<any>;
  try {
    const plan = await deviceB.planWithdrawal('all');
    assert.ok(plan.usdMicro > 0n, 'the withdrawal spends the same dollar notes as the payment');
    [pay, wd] = await Promise.allSettled([
      mallory.pay('POST', '/v1/search', JSON.stringify({ query: 'device A' }), cost),
      deviceB.withdraw(plan, SAPLING),
    ]);
  } finally {
    c.MIN_CONVERT_BACK_MICRO_USD = savedMin;
  }
  const paid = pay.status === 'fulfilled' && pay.value.status === 200;
  const withdrew = wd.status === 'fulfilled' && !!wd.value?.withdrawal_id;
  assert.ok(paid !== withdrew || !paid, `both went through: pay=${paid} withdraw=${withdrew}`);
  // Whatever happened, the server never owes more than was deposited.
  await mallory.refreshSpent();
  await deviceB.refreshSpent();
  const b = await reserveBooks();
  assert.ok(b.usd.coverage_bps >= 10_000, JSON.stringify(b.usd));
  assert.ok(usd >= 0n);
  await sleep(1500);
  await settleFloat();
});

test('adversarial: the books balance after every attack (owed = all users\' notes; held ≥ owed)', { timeout: 120_000 }, async () => {
  await sleep(1500);
  await alice.refreshSpent();
  await mallory.refreshSpent();
  const b = await reserveBooks();
  assert.ok(b.usd.coverage_bps >= 10_000, JSON.stringify(b.usd));
  assert.ok(b.zec.coverage_bps >= 10_000, JSON.stringify(b.zec));
  assert.ok(b.profit.net_micro_usd > 0, JSON.stringify(b.profit));
  const [n] = await q<{ n: number }>('SELECT count(*)::int AS n FROM (SELECT nullifier FROM nullifiers GROUP BY nullifier HAVING count(*) > 1) x');
  assert.equal(n.n, 0); // no note ever spent twice
});

test('privacy: no IP, user agent or client header reaches a handler, a log or the database', { timeout: 60_000 }, async () => {
  const cols = await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'`);
  assert.ok(!cols.some((c) => /(^|_)ip($|_)|user_agent|useragent|remote_addr|forwarded/i.test(c.column_name)), cols.map((c) => c.column_name).join(','));
  // Capture everything the app hands its logger (every level) while a request carries
  // every identifying header there is.
  const lines: string[] = [];
  const L = log as unknown as Record<string, unknown> & { level: string };
  const savedLevel = L.level;
  L.level = 'trace';
  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const origs = Object.fromEntries(levels.map((k) => [k, L[k]]));
  for (const k of levels) L[k] = (...a: unknown[]) => { lines.push(JSON.stringify(a)); };
  try {
    await fetch(`${base}/v1/status`, { headers: {
      'x-forwarded-for': '198.51.100.23', 'x-real-ip': '198.51.100.24', 'cf-connecting-ip': '198.51.100.25', forwarded: 'for=198.51.100.26',
      'true-client-ip': '198.51.100.27', 'user-agent': 'SecretBrowser/9.9 (alice-laptop)', 'accept-language': 'xx-SECRET',
    } });
    await sleep(300);
  } finally {
    Object.assign(L, origs);
    L.level = savedLevel;
  }
  const logged = lines.join('');
  assert.ok(logged.includes('"route":"/v1/status"'), 'the request was logged (route/status/latency only)');
  for (const s of ['198.51.100', 'SecretBrowser', 'alice-laptop', 'xx-SECRET']) assert.ok(!logged.includes(s), `log leaked ${s}`);
});

// ------------------------------------------------------------------ Oblivious HTTP
/** What the relay would see: every outer request and reply, as bytes. */
function relayView() {
  const seen: { path: string; reqBytes: number; resBytes: number; status: number }[] = [];
  const net = (async (url: string, init: RequestInit) => {
    const r = await fetch(url, init);
    const buf = new Uint8Array(await r.arrayBuffer());
    seen.push({ path: new URL(url).pathname, reqBytes: (init.body as Uint8Array).length, resBytes: buf.length, status: r.status });
    return new Response(buf, { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return { seen, net };
}
const isBucket = (n: number) => n === 1024 || (n <= 65536 && (n & (n - 1)) === 0) || n % 65536 === 0;

test('ohttp: the relay sees only POST /ohttp with padded sizes; the reply matches the plain one', { timeout: 60_000 }, async () => {
  const view = relayView();
  const zf = ohttpFetch({ baseUrl: base, keyConfig: testKeyConfig(), fetch: view.net });
  const r = await zf(`${base}/v1/prices`);
  assert.equal(r.status, 200);
  const viaOhttp = await r.json();
  assert.ok(viaOhttp.routes?.search, 'real API reply inside');
  // Two different requests: the relay sees the same path and the same padded sizes.
  await zf(`${base}/v1/config`);
  await zf(`${base}/v1/vault/items`, { headers: { 'x-vault-id': 'a'.repeat(64), 'x-vault-auth': 'b'.repeat(64) } });
  for (const s of view.seen) {
    assert.equal(s.path, '/ohttp');
    assert.ok(isBucket(s.reqBytes), `request size ${s.reqBytes} is a bucket`);
    assert.ok(isBucket(s.resBytes), `reply size ${s.resBytes} is a bucket`);
  }
  assert.equal(new Set(view.seen.map((s) => s.reqBytes)).size, 1, 'different routes, same request size');
});

test('ohttp: tampering, an unknown key, a cut reply and forbidden inner paths all fail closed', { timeout: 60_000 }, async () => {
  // A relay flipping one bit of the request.
  const flip = (async (url: string, init: RequestInit) => {
    const b = new Uint8Array(init.body as Uint8Array);
    b[b.length - 5] ^= 1;
    return fetch(url, { ...init, body: b });
  }) as typeof fetch;
  const t = await ohttpFetch({ baseUrl: base, keyConfig: testKeyConfig(), fetch: flip })(`${base}/v1/prices`);
  assert.equal(t.status, 400);
  assert.equal((await t.json()).error.code, 'ohttp_decrypt');
  // A key the server doesn't have.
  const other = b64(encodeKeyConfig(9, new Uint8Array(32).fill(5).map((x, i) => x + i)));
  const k = await ohttpFetch({ baseUrl: base, keyConfig: other })(`${base}/v1/prices`);
  assert.equal(k.status, 422);
  // A relay cutting the reply short: the app must notice, never accept a partial answer.
  const cut = (async (url: string, init: RequestInit) => {
    const r = await fetch(url, init);
    const buf = new Uint8Array(await r.arrayBuffer());
    return new Response(buf.subarray(0, buf.length - 3), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  await assert.rejects(async () => {
    const r = await ohttpFetch({ baseUrl: base, keyConfig: testKeyConfig(), fetch: cut })(`${base}/v1/prices`);
    await r.text();
  });
  // Only /v1/ routes run inside the gateway: no internal routes, no nesting.
  for (const path of ['/internal/x', '/ohttp', '/v1/../internal/x']) {
    const sealed = sealRequest(parseKeyConfig(testKeyConfig()), encodeRequest('GET', path, [], new Uint8Array(0)));
    const r = await fetch(`${base}/ohttp`, { method: 'POST', headers: { 'content-type': REQ_MEDIA }, body: sealed.body });
    assert.equal(r.status, 400, path);
  }
  // The app can't call anything but Zeep through it (no accidental plain-text leaks).
  await assert.rejects(ohttpFetch({ baseUrl: base, keyConfig: testKeyConfig() })('https://example.com/v1/prices'));
});

test('ohttp: smuggled identity headers inside the encrypted request never reach a handler', { timeout: 60_000 }, async () => {
  const smuggled: [string, string][] = [
    ['x-forwarded-for', '198.51.100.9'], ['cf-connecting-ip', '198.51.100.9'], ['forwarded', 'for=198.51.100.9'], ['user-agent', 'Leaky/1.0'],
    ['cookie', 'id=alice'], ['accept-language', 'xx-SECRET'], ['x-zeep-ohttp-inner', 'guess'], ['x-zeep-relay', 'guess'],
    ['content-type', 'application/json'], ['x-zeep-proof', 'p'], ['x-vault-id', 'v'],
  ];
  const h = innerHeaders(smuggled);
  assert.deepEqual(Object.keys(h).filter((k) => !['x-zeep-ohttp-inner', 'x-zeep-relay'].includes(k)).sort(), ['content-type', 'x-vault-id', 'x-zeep-proof']);
  assert.notEqual(h['x-zeep-ohttp-inner'], 'guess');
  assert.ok(!JSON.stringify(h).includes('198.51.100') && !JSON.stringify(h).includes('Leaky') && !JSON.stringify(h).includes('SECRET'));
  // And a real request carrying them still works normally.
  const zf = ohttpFetch({ baseUrl: base, keyConfig: testKeyConfig() });
  assert.equal((await zf(`${base}/v1/status`, { headers: Object.fromEntries(smuggled.slice(0, 8)) })).status, 200);
});

test('ohttp: REQUIRE_OHTTP refuses plain calls, still serves OHTTP and the status page', { timeout: 60_000 }, async () => {
  const c = cfg as { REQUIRE_OHTTP: boolean };
  const saved = c.REQUIRE_OHTTP;
  c.REQUIRE_OHTTP = true;
  try {
    const plain = await fetch(`${base}/v1/prices`);
    assert.equal(plain.status, 403);
    assert.equal((await plain.json()).error.code, 'ohttp_required');
    assert.equal((await fetch(`${base}/v1/status`)).status, 200);
    // A guessed inner marker from outside doesn't work.
    assert.equal((await fetch(`${base}/v1/prices`, { headers: { 'x-zeep-ohttp-inner': 'f'.repeat(64) } })).status, 403);
    const viaOhttp = await ohttpFetch({ baseUrl: base, keyConfig: testKeyConfig() })(`${base}/v1/prices`);
    assert.equal(viaOhttp.status, 200);
  } finally {
    c.REQUIRE_OHTTP = saved;
  }
});

test('ohttp: a streamed AI reply arrives intact, in padded batches, with nothing cut', { timeout: 120_000 }, async () => {
  const zf = ohttpFetch({ baseUrl: base, keyConfig: testKeyConfig() });
  const bob = new ZeepClient({ baseUrl: base, keys: mKeys, book: mallory.book, prove: nodeProve, fetch: zf });
  const p = await bob.prices();
  const model = p.models.find((m: { metered: unknown }) => !m.metered) ?? p.models[0];
  const chat = JSON.stringify({ model: model.id, stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const cost = model.metered ? chatCostMicro(p, model.id, chat) : BigInt(model.micro_usd);
  const r = await bob.pay('POST', '/v1/ai/chat/completions', chat, cost);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
  const sse = await r.text();
  assert.match(sse, /^: open/);
  const text = [...sse.matchAll(/^data: (\{.*\})$/gm)].map((m) => JSON.parse(m[1]).choices[0].delta.content).join('');
  assert.match(text, /mock reply/);
  assert.match(sse, /data: \[DONE\]/);
});

test('removed services stay removed: no chain RPC, no internal gate, no price for them', { timeout: 30_000 }, async () => {
  for (const [path, body] of [['/v1/rpc/ethereum', '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}'], ['/internal/verify', '{}']] as const) {
    const r = await http(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.ok(r.status === 404 || r.status === 400, `${path} → ${r.status}`);
  }
  const p = await (await http(`${base}/v1/prices`)).json();
  assert.ok(!('rpc100' in p.routes), 'no chain price on the sheet');
});

test('research (answers and multi-hop tasks) and health lookups work and cost at least the provider price', { timeout: 120_000 }, async () => {
  const p = await alice.prices();
  // What the user pays is at least what the provider charges Zeep (Exa, Parallel, RxAtlas, AgentMail).
  const floor: Record<string, number> = { email_send: 20_000, search: 7_000, research_base: 10_000, research_core: 50_000, research_pro: 100_000, health: 100_000, inbox: 2_000_000, inbox_send: 10_000 };
  for (const [route, min] of Object.entries(floor)) assert.ok(p.routes[route].micro_usd >= min, `${route} ${p.routes[route].micro_usd} ≥ ${min}`);
  for (const processor of ['base', 'core', 'pro'] as const) {
    const body = JSON.stringify({ query: 'state of fusion energy', processor });
    const r = await alice.pay('POST', '/v1/research', body, BigInt(p.routes[`research_${processor}`].micro_usd));
    assert.equal(r.status, 202, processor);
    const { job_id } = await r.json();
    const done = await until(async () => {
      const j = await (await http(`${base}/v1/jobs/${job_id}`)).json();
      return j.status === 'completed' ? j : undefined;
    });
    assert.match(done.result.content, /mock research report/, processor);
  }
  for (const kind of ['drug', 'trial'] as const) {
    const r = await alice.pay('POST', '/v1/health/lookup', JSON.stringify({ kind, query: 'aspirin', summarize: false }), BigInt(p.routes.health.micro_usd));
    assert.equal(r.status, 200, kind);
    const j = await r.json();
    // Records come back as list items the app can show: title + snippet (+ link for trials).
    assert.ok(Array.isArray(j.data) && j.data.length === 1, kind);
    assert.match(j.data[0].title, kind === 'drug' ? /ATORVASTATIN/ : /Mock trial/);
    assert.match(j.data[0].snippet, kind === 'drug' ? /80 mg\/1 · TABLET · ORAL/ : /ISRCTN17465883 · Status: recruiting/);
    if (kind === 'trial') assert.equal(j.data[0].url, 'https://www.isrctn.com/ISRCTN17465883');
    assert.equal(j.total, 1);
  }
});

test('send-only email: no inbox needed, charged per send, reply address optional, nothing charged on a bad request', { timeout: 120_000 }, async () => {
  const p = await alice.prices();
  assert.ok(p.routes.email_send.micro_usd >= 20_000, 'never below StableEmail\'s $0.02');
  const before = alice.balance(USD);
  const sent = await alice.sendEmailDirect({ to: 'friend@example.com', subject: 'Hello', text: 'Sent from Zeep without an inbox.' });
  assert.ok(sent.message_id);
  assert.equal(sent.reply_to, null);
  assert.equal(alice.balance(USD), before - BigInt(p.routes.email_send.micro_usd));
  // Refused BEFORE payment: no subject, a bad address, an unknown reply inbox.
  const mid = alice.balance(USD);
  await assert.rejects(alice.sendEmailDirect({ to: 'friend@example.com', subject: '', text: 'x' }));
  await assert.rejects(alice.sendEmailDirect({ to: 'Friend <friend@example.com>', subject: 's', text: 'x' }));
  await assert.rejects(alice.sendEmailDirect({ to: 'friend@example.com', subject: 's', text: 'x', replyInboxId: 'ibx_' + 'x'.repeat(32) }));
  assert.equal(alice.balance(USD), mid);
});

test('withdrawals: credits under the convert-back minimum are refused before anything is spent', { timeout: 120_000 }, async () => {
  const conf = await (await http(`${base}/v1/config`)).json();
  assert.equal(conf.withdrawals.min_convert_micro_usd, cfg.MIN_CONVERT_BACK_MICRO_USD);
  const fresh = new ZeepClient({ baseUrl: base, keys: deriveKeys(seedFromPhrase(generateMnemonic(wordlist, 256)), NET), book: new NoteBook(), prove: nodeProve, fetch: http });
  const d = await fresh.startDeposit(20_000_000n, undefined, false); // 0.2 ZEC ($10) → ~$4.93 of credits + 0.1 ZEC
  await payInto(d.address, 20_000_000);
  await until(async () => !!(await fresh.depositStatus(d.slot)).credited);
  const usd = fresh.balance(USD);
  assert.ok(usd > 0n && usd < BigInt(cfg.MIN_CONVERT_BACK_MICRO_USD));
  // "Withdraw all" leaves credits under the minimum as credits; asking for more refuses.
  const all = await fresh.planWithdrawal('all');
  assert.equal(all.usdMicro, 0n);
  await assert.rejects(fresh.planWithdrawal(fresh.balance(ZEC) + 1_000_000n));
  assert.equal(fresh.balance(USD), usd);
});

test('small deposits (worth under $10) become credits only, so all of it can be used for services', { timeout: 120_000 }, async () => {
  const conf = await (await http(`${base}/v1/config`)).json();
  assert.equal(conf.split.all_credits_below_micro_usd, 10_000_000);
  const small = new ZeepClient({ baseUrl: base, keys: deriveKeys(seedFromPhrase(generateMnemonic(wordlist, 256)), NET), book: new NoteBook(), prove: nodeProve, fetch: http });
  const d = await small.startDeposit(10_000_000n, undefined, false); // 0.1 ZEC at the $50 test price = $5
  await payInto(d.address, 10_000_000);
  await until(async () => !!(await small.depositStatus(d.slot)).credited);
  const c = (await small.depositStatus(d.slot)).credited!;
  assert.equal(c.zec.amount_zats, 0); // no ZEC half
  assert.equal(c.usd.converted_zats, 10_000_000); // all of it converted
  assert.equal(c.usd.value_micro_usd, 5_000_000);
  assert.equal(c.usd.fee_micro_usd, 75_000); // 1.5%
  assert.equal(c.usd.amount_micro_usd, 5_000_000 - 75_000 + c.usd.rebate_micro_usd);
  assert.deepEqual(small.balances(), { usd: BigInt(c.usd.amount_micro_usd), zec: 0n });
  // The app's estimate agrees before the deposit lands.
  const est = estimateDeposit(10_000_000n, 50, conf.split.zec_share_bps, conf.split.conversion_fee_bps.zec_to_usd, conf.split.all_credits_below_micro_usd);
  assert.deepEqual([est.zecZats, est.usdMicro], [0n, 4_925_000n]);
  // And it all works for services straight away.
  const cost = BigInt((await small.prices()).routes.search.micro_usd);
  assert.equal((await small.pay('POST', '/v1/search', JSON.stringify({ query: 'small deposit' }), cost)).status, 200);
  // The ZEC behind it is surplus for the float to convert, never owed as ZEC.
  await sleep(1500);
  await settleFloat();
  const b = await reserveBooks();
  assert.ok(b.usd.coverage_bps >= 10_000 && b.zec.coverage_bps >= 10_000, JSON.stringify({ usd: b.usd.coverage_bps, zec: b.zec.coverage_bps }));
});
