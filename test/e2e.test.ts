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
import { redis } from '../src/lib/redis.js';
import { migrate } from '../src/migrate.js';
import { registry } from '../src/notes/registry.js';
import { buildApp } from '../src/server.js';
import { floatTick, zecOwedZats } from '../src/treasury/float.js';
import { checkRedisNetwork } from '../src/lib/redis.js';
import { checkDbNetwork } from '../src/migrate.js';
import { reserveBooks } from '../src/services/reserve.js';
import { housekeeping } from '../src/workers/treasury.js';
import { deriveKeys, NoteBook, seedFromPhrase, USD, ZEC, ZeepClient } from '../sdk/index';
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
const alice = new ZeepClient({ baseUrl: '', keys, book: new NoteBook(), prove: nodeProve });

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
  const d1 = await alice.startDeposit(50_000_000n); // the user typed 0.5 ZEC
  const d2 = await alice.startDeposit(12_345_670n); // any amount, no plans
  assert.notEqual(d1.address, d2.address); // a fresh address per deposit, no memo needed
  assert.equal(d1.first_today, true);
  assert.equal(d2.first_today, false); // same user, same day: proven privately by the daily tag
  await payInto(d1.address, 50_000_000);
  await payInto(d2.address, 12_345_670);
  await until(async () => (await alice.depositStatus(d1.slot)).credited && (await alice.depositStatus(d2.slot)).credited);
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

test('replays are refused (409) and underpaying is refused (402) without losing money', { timeout: 120_000 }, async () => {
  const prices = await alice.prices();
  const cost = BigInt(prices.routes.search.micro_usd);
  let captured: { url: string; init: RequestInit } | undefined;
  const spy = new ZeepClient({
    baseUrl: base, keys, book: alice.book, prove: nodeProve,
    fetch: async (url, init) => {
      if (String(url).endsWith('/v1/search')) captured = { url: String(url), init: init! };
      return fetch(url, init);
    },
  });
  assert.equal((await spy.pay('POST', '/v1/search', JSON.stringify({ query: 'replay me' }), cost)).status, 200);
  assert.equal((await fetch(captured!.url, captured!.init)).status, 409);
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
  const fresh = new ZeepClient({ baseUrl: base, keys: deriveKeys(seedFromPhrase(phrase), NET), book: new NoteBook(), prove: nodeProve });
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
  const pub = await (await fetch(`${base}/v1/reserve`)).json();
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
  assert.equal((await fetch(`${base}/v1/inbox/${box.inbox_id}/messages`)).status, 404);

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
  assert.equal((await fetch(url, { method: 'PUT', headers: h, body: JSON.stringify({ blob: 'AAAA', expires_at: expires }) })).status, 204);
  assert.equal((await (await fetch(url, { headers: h })).json()).blob, 'AAAA');
  assert.equal((await fetch(url, { headers: { ...h, 'x-vault-auth': 'f'.repeat(64) } })).status, 401);
  await q(`UPDATE vault_items SET expires_at = now() - interval '1 second'`);
  assert.equal((await fetch(url, { headers: h })).status, 404);
  assert.equal((await fetch(`${base}/v1/vault`, { method: 'DELETE', headers: h })).status, 204);
});
