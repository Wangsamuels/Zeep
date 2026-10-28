// Unit tests (no DB/Redis): tree, signals, units, keys, note backups, real spend proofs.
import './setup.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import * as snarkjs from 'snarkjs';
import { decryptAddr, encryptAddr } from '../src/lib/crypto.js';
import { MerkleTree } from '../src/notes/tree.js';
import { convertSignal as serverConvert, requestSignal as serverSignal, withdrawSignal as serverWithdraw } from '../src/notes/spend.js';
import { cfg, networkProblems } from '../src/config.js';
import { roundBooks } from '../src/routes/public.js';
import { createHash } from 'node:crypto';
import { isTransparent, validPayoutAddress, withdrawalAmounts } from '../src/routes/money.js';
import { marginOf } from '../src/services/fees.js';
import { decide } from '../src/treasury/float.js';
import { CHAT_BYTES_PER_TOKEN, CHAT_IMAGE_TOKENS, CHAT_MESSAGE_TOKENS, chatMicroUsd, chatQuote, chatUsd, requiredMicroUsd, withMarkup, zatsToMicroUsd } from '../src/services/prices.js';
import { chatCostMicro, convertSignal, solvePow, decryptNote, deriveKeys, depositSlot, encryptNote, estimateDeposit, formatCredits, formatUsd, NoteBook, noteFromKeys, nullifierOf, parseZec, requestSignal, USD, withdrawSignal, ZEC, zeros } from '../sdk/index';
import { buildSpend } from '../sdk/spend';
import { CIRCUIT, nodeProve } from './helpers/prove.js';
import * as ohttp from '../src/lib/ohttp.js';

after(async () => {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

const seed = new Uint8Array(64).fill(9);
const keys = deriveKeys(seed, 'testnet');

test('incremental tree matches bulk load', () => {
  const leaves = Array.from({ length: 37 }, (_, i) => BigInt(i * 7919 + 1));
  const a = new MerkleTree(20);
  leaves.forEach((l) => a.append(l));
  const b = new MerkleTree(20);
  b.load(leaves);
  assert.equal(a.root(), b.root());
});

test('client and server compute the same signals; the refund owner and refill amount are bound', () => {
  assert.equal(requestSignal('POST', '/v1/search', '{"q":1}'), serverSignal('POST', '/v1/search', '{"q":1}'));
  assert.equal(requestSignal('POST', '/v1/search', '{"q":1}', 77n), serverSignal('POST', '/v1/search', '{"q":1}', 77n));
  assert.notEqual(serverSignal('POST', '/v1/search', '{"q":1}', 77n), serverSignal('POST', '/v1/search', '{"q":1}', 78n)); // can't redirect a refund
  assert.equal(withdrawSignal('ABC', 'utest1x'), serverWithdraw('abc', 'utest1x'));
  assert.equal(convertSignal('id', 5n, 1_000n), serverConvert('id', 5n, 1_000n));
  assert.notEqual(serverConvert('id', 5n, 1_000n), serverConvert('id', 5n, 1_001n)); // can't change a refill's amount
});

test('testnet and mainnet can never be mixed up by configuration', () => {
  const base = { ...cfg, ZEEP_RECEIVE_UA: '', ZEEP_RESERVE_TADDR: '' };
  assert.deepEqual(networkProblems({ ...base, ZEEP_ENV: 'testnet', ZCASH_NETWORK: 'test' }), []);
  assert.match(networkProblems({ ...base, ZEEP_ENV: 'mainnet', ZCASH_NETWORK: 'test' }).join(), /needs ZCASH_NETWORK=main/);
  assert.match(networkProblems({ ...base, ZEEP_ENV: 'testnet', ZCASH_NETWORK: 'main' }).join(), /needs ZCASH_NETWORK=test/);
  // A testnet wallet address on mainnet (or the reverse) is refused.
  assert.match(networkProblems({ ...base, ZEEP_ENV: 'testnet', ZCASH_NETWORK: 'test', ZEEP_RECEIVE_UA: 'u1' + 'q'.repeat(100) }).join(), /ZEEP_RECEIVE_UA/);
  assert.match(networkProblems({ ...base, ZEEP_ENV: 'testnet', ZCASH_NETWORK: 'test', ZEEP_RESERVE_TADDR: 't1' + 'A'.repeat(33) }).join(), /ZEEP_RESERVE_TADDR/);
  const main = { ...base, ZEEP_ENV: 'mainnet' as const, ZCASH_NETWORK: 'main' as const, PUBLIC_API_BASE_URL: 'https://api.zeep.app' };
  const p = networkProblems({ ...main, TREASURY_RAILS: 'mock', MPP_MODE: 'mock', SPEND_VKEY_SHA256: '', ALLOW_PRICE_FALLBACK: true, REQUIRE_RELAY: false, ALLOW_NO_RELAY: false }).join();
  for (const m of [/TREASURY_RAILS=live/, /MPP_MODE=live/, /SPEND_VKEY_SHA256/, /ALLOW_PRICE_FALLBACK/, /REQUIRE_RELAY/]) assert.match(p, m);
  assert.match(networkProblems({ ...main, TREASURY_RAILS: 'live', RELAY_API_KEY: undefined }).join(), /RELAY_API_KEY/);
  // Testnet can never move real money.
  assert.match(networkProblems({ ...base, ZEEP_ENV: 'testnet', ZCASH_NETWORK: 'test', TREASURY_RAILS: 'live' }).join(), /TREASURY_RAILS=mock/);
  const ready = { ...main, TREASURY_RAILS: 'live' as const, RELAY_API_KEY: 'k', MPP_MODE: 'live' as const, SPEND_VKEY_SHA256: 'ab', ALLOW_PRICE_FALLBACK: false, REQUIRE_RELAY: true, OHTTP_PRIVATE_KEY: Buffer.alloc(32, 1).toString('base64'),
    ZEEP_RECEIVE_UA: 'u1' + 'q'.repeat(100), ZEEP_RESERVE_TADDR: 't1' + 'A'.repeat(33),
    TEMPO_PRIVATE_KEY: '0x' + '1'.repeat(64), NEAR_ONECLICK_JWT: 'jwt', CORS_ALLOWED_ORIGINS: ['https://zeep.app'],
    MODAL_LLM_BASE_URL: 'https://m.modal.run', MODAL_PROXY_TOKEN: 't' };
  assert.deepEqual(networkProblems(ready), []);
  assert.match(networkProblems({ ...ready, OHTTP_PRIVATE_KEY: undefined }).join(), /OHTTP_PRIVATE_KEY/);
  assert.match(networkProblems({ ...ready, OHTTP_PRIVATE_KEY: 'short' }).join(), /32 random bytes/);
  // Mainnet refuses to boot without the keys its money path and services need.
  assert.match(networkProblems({ ...ready, TEMPO_PRIVATE_KEY: undefined }).join(), /TEMPO_PRIVATE_KEY/);
  assert.match(networkProblems({ ...ready, NEAR_ONECLICK_JWT: undefined }).join(), /NEAR_ONECLICK_JWT/);
  assert.match(networkProblems({ ...ready, CORS_ALLOWED_ORIGINS: ['http://localhost:3001'] }).join(), /CORS_ALLOWED_ORIGINS/);
  assert.match(networkProblems({ ...ready, MODAL_LLM_BASE_URL: '' }).join(), /MODAL_LLM_BASE_URL/);
  assert.deepEqual(networkProblems({ ...ready, MODAL_LLM_BASE_URL: '', MODELS_JSON: ready.MODELS_JSON.filter((m) => m.host !== 'zeep') }), []);
});

test('public reserve books are rounded so single payments cannot be read off them', () => {
  assert.deepEqual(roundBooks({ usd: { owed_micro_usd: 12_345_678, coverage_bps: 10_113 }, zec: { notes_zats: 1_499_999 }, zec_usd: 50.12 }),
    { usd: { owed_micro_usd: 12_000_000, coverage_bps: 10_113 }, zec: { notes_zats: 1_000_000 }, zec_usd: 50.12 });
});

test('deposit intent proof of work: the SDK solves what the server checks', () => {
  const id = 'ab'.repeat(32);
  const nonce = solvePow(id, 12);
  const h = createHash('sha256').update(`zeep-intent-pow-v1:${id}:${nonce}`).digest();
  assert.equal(h[0], 0);
  assert.equal(h[1] >> 4, 0);
});

test('credits show dollars (1 credit = $1 by default); deposits split 50/50 with the fee only on the converted half', () => {
  assert.equal(formatCredits(1_000_000n), '1');
  assert.equal(formatCredits(2_090n), '0.0021'); // a $0.00209 response
  assert.equal(formatUsd(2_462_500n), '$2.46');
  // 0.05 ZEC at $50: 0.025 ZEC kept ($1.25), 0.025 ZEC → $1.25 − 1.5% = $1.23125
  assert.deepEqual(estimateDeposit(parseZec('0.05'), 50, 5000, 150), { zecZats: 2_500_000n, usdMicro: 1_231_250n, totalMicro: 2_481_250n });
});

test('prices: USD + 4.5% markup, charged in micro-USD; attachments metered per started MB', () => {
  assert.equal(requiredMicroUsd(0.01), 10_450); // $0.01 search → $0.01045
  assert.equal(zatsToMicroUsd(5_000_000, 50), 2_500_000);
  const m = { id: 'x', name: 'x', host: 'zeep' as const, usd: 0.002, vision: false, detail: '', testnet: true };
  assert.equal(chatUsd(m, 10_000), 0.002);
  assert.equal(chatUsd(m, 64 * 1024 + 1), 0.002 + 0.01);
  // Charged = exactly the published figures added up (each marked up and rounded on its own).
  const odd = { ...m, usd: 0.0021 };
  for (const mb of [0, 1, 3, 7]) {
    const bytes = mb === 0 ? 1000 : 64 * 1024 + mb * 1024 * 1024;
    assert.equal(chatMicroUsd(odd, bytes), requiredMicroUsd(0.0021) + mb * requiredMicroUsd(0.01));
  }
});

test('metered chat: server price = SDK price = gateway formula; the output cap is enforced', () => {
  const m = { id: 'anthropic/claude-sonnet-5.5', name: 'Claude', host: 'mpp' as const, usd: 0, vision: true, detail: '', testnet: false,
    in_usd_per_m: 2, out_usd_per_m: 10, min_usd: 0.012, default_output: 4096, max_output: 16_000 };
  const sheet = {
    markup_bps: cfg.PRICE_MARKUP_BPS, attachments: { micro_usd_per_mb: 10450 },
    models: [{ id: m.id, micro_usd: 0, metered: { in_usd_per_m: 2, out_usd_per_m: 10, min_usd: 0.012, default_output: 4096, max_output: 16_000,
      bytes_per_token: CHAT_BYTES_PER_TOKEN, image_tokens: CHAT_IMAGE_TOKENS, message_tokens: CHAT_MESSAGE_TOKENS } }],
  };
  const img = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,' + 'A'.repeat(200_000) } };
  const bodies = [
    { messages: [{ role: 'user', content: 'hi' }] },
    { messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 },
    { messages: [{ role: 'user', content: 'hi' }], max_tokens: 100_000 }, // above the cap
    { messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: '你好，世界'.repeat(500) }] },
    { messages: [{ role: 'user', content: [{ type: 'text' as const, text: 'what is this?' }, img] }] },
    { messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'word '.repeat(300) })) },
  ];
  for (const b of bodies) {
    const raw = JSON.stringify(b);
    const q = chatQuote(m, b as never, Buffer.byteLength(raw));
    assert.equal(BigInt(q.micro), chatCostMicro(sheet, m.id, raw), raw.slice(0, 60));
    assert.ok(q.maxTokens! <= 16_000);
  }
  // A text-only model: earlier images are priced as the short placeholder, same on both sides.
  const textOnly = { ...m, id: 'deepseek/x', vision: false };
  const sheet2 = { ...sheet, models: [{ ...sheet.models[0], id: textOnly.id, metered: { ...sheet.models[0].metered, image_tokens: 16 } }] };
  const withImg = { messages: [{ role: 'user', content: [{ type: 'text' as const, text: 'look' }, img] }, { role: 'user', content: 'and now?' }] };
  const rawImg = JSON.stringify(withImg);
  assert.equal(BigInt(chatQuote(textOnly, withImg as never, rawImg.length).micro), chatCostMicro(sheet2, textOnly.id, rawImg));
  // Images aren't billed by their bytes; a long output cap costs more; the floor applies.
  const one = chatQuote(m, { messages: [{ content: 'hi' }] }, 64);
  assert.equal(one.maxTokens, 4096);
  assert.equal(one.micro, requiredMicroUsd(((Math.ceil(2 / 3) + 8) * 2 + 4096 * 10) / 1e6)); // 9 input tokens + 4096 output
  assert.equal(chatQuote(m, { messages: [{ content: 'hi' }], max_tokens: 16 }, 64).micro, requiredMicroUsd(0.012));
  assert.equal(chatQuote(m, { messages: [{ content: 'hi' }], max_tokens: 100_000 }, 64).maxTokens, 16_000);
  // Always at least what the gateway charges for the same request (its estimate: ~4-5 bytes a token).
  const long = 'word '.repeat(20_000);
  const gateway = (long.length / 5) * 2 / 1e6 + 1024 * 10 / 1e6;
  assert.ok(chatQuote(m, { messages: [{ content: long }], max_tokens: 1024 }, long.length).micro / 1e6 >= gateway);
});

test('withdrawal maths and address checks (transparent only when opted in)', () => {
  // ZEC only: no conversion fee; the two network fees (20,000 zats) come out unless covered
  assert.deepEqual(withdrawalAmounts(5_000_000, 0, 20_000, false), { zecZats: 5_000_000, usdMicro: 0, conversionFee: 0, convert: 0, userNetworkZats: 20_000, zecNow: 4_980_000 });
  assert.deepEqual(withdrawalAmounts(5_000_000, 0, 20_000, true).zecNow, 5_000_000);
  // ZEC + $100 of credits: 1.5% only on the credits converted back
  assert.deepEqual(withdrawalAmounts(5_000_000, 100_000_000, 20_000, true), { zecZats: 5_000_000, usdMicro: 100_000_000, conversionFee: 1_500_000, convert: 98_500_000, userNetworkZats: 0, zecNow: 5_000_000 });
  const taddr = 'tm' + 'A'.repeat(33);
  assert.ok(isTransparent(taddr));
  assert.equal(validPayoutAddress(taddr), false);
  assert.equal(validPayoutAddress(taddr, true), true);
  assert.equal(validPayoutAddress('ztestsapling1' + 'q'.repeat(75)), true);
  assert.equal(decryptAddr(encryptAddr('utest1abc')), 'utest1abc');
});

test('markup: prices include it and the margin is recoverable from a charge', () => {
  assert.equal(withMarkup(1), 1.045); // PRICE_MARKUP_BPS = 450 (4.5%)
  assert.equal(marginOf(104_500n), 4_500n);
});

test('float: ZEC owed to ZEC notes stays ZEC; only the surplus is converted to USDC.e', () => {
  // 0.52 ZEC held, 0.02 pending payouts, 0.25 owed to ZEC notes → the rest converts, minus the
  // fee buffer (ZEC_FLOOR_ZATS 200,000) and the send's own fee room
  assert.deepEqual(decide({ zecSpendable: 52_000_000n, pendingZecPayouts: 2_000_000n, zecOwed: 25_000_000n, inflightToTempo: false }), { action: 'to_tempo', zats: 24_780_000n });
  assert.equal(decide({ zecSpendable: 52_000_000n, pendingZecPayouts: 0n, zecOwed: 52_000_000n, inflightToTempo: false }).action, 'none'); // all of it is users' ZEC
  assert.equal(decide({ zecSpendable: 52_000_000n, pendingZecPayouts: 0n, zecOwed: 0n, inflightToTempo: true }).action, 'none');
  assert.equal(decide({ zecSpendable: 50_000n, pendingZecPayouts: 0n, zecOwed: 0n, inflightToTempo: false }).action, 'none'); // below CONVERSION_MIN
});

test('keys and deposit slots are deterministic from the seed', () => {
  assert.deepEqual(depositSlot(deriveKeys(seed, 'testnet'), 3), depositSlot(keys, 3));
  assert.notEqual(depositSlot(keys, 3).intentId, depositSlot(keys, 4).intentId);
  assert.notEqual(depositSlot(keys, 3).d, depositSlot(keys, 3).dZec); // the deposit's dollar and ZEC notes
  assert.notEqual(deriveKeys(new Uint8Array(64).fill(1), 'testnet').vaultId, keys.vaultId);
  // Same phrase, other network: nothing in common.
  const main = deriveKeys(seed, 'mainnet');
  assert.notEqual(main.sk, keys.sk);
  assert.notEqual(main.vaultId, keys.vaultId);
  assert.notEqual(depositSlot(main, 3).intentId, depositSlot(keys, 3).intentId);
});

test('note backups decrypt only with the owner key', async () => {
  const e = await encryptNote(keys.noteKey, 123_456n, 42n, ZEC);
  assert.deepEqual(await decryptNote(keys.noteKey, e), { amount: 123_456n, rho: 42n, asset: ZEC });
  assert.equal(await decryptNote(deriveKeys(new Uint8Array(64).fill(2), 'testnet').noteKey, e), null);
});

test('note selection: per asset; one note, two notes, or merge first', () => {
  const b = new NoteBook();
  for (const [i, a] of [[0, 100n], [1, 50n], [2, 30n]] as const) b.add(noteFromKeys(keys, BigInt(i + 1), a, USD, 1, i, 'change'));
  b.add(noteFromKeys(keys, 99n, 1_000n, ZEC, 1, 3, 'deposit-zec:0'));
  assert.equal(b.balance(USD), 180n);
  assert.equal(b.balance(ZEC), 1_000n);
  assert.deepEqual((b.select(40n, USD) as { inputs: { amount: string }[] }).inputs.map((n) => n.amount), ['50']);
  assert.deepEqual((b.select(140n, USD) as { inputs: { amount: string }[] }).inputs.map((n) => n.amount), ['100', '50']);
  assert.ok('merge' in (b.select(170n, USD) as object));
  assert.equal(b.select(181n, USD), null); // ZEC notes never pay for services directly
});

test('a real spend proof verifies; value is conserved; balance stays hidden', { timeout: 120_000 }, async () => {
  const tree = new MerkleTree(20);
  const rho = 777n;
  const note = noteFromKeys(keys, rho, 1_000_000n, USD, 1, 0, 'deposit:0');
  tree.append(123n);
  tree.load([BigInt(note.commitment), 123n]);
  note.index = 0;
  const signal = requestSignal('POST', '/v1/search', '{"query":"x"}');
  const built = await buildSpend(
    keys,
    { asset: USD, inputs: [note], cost: 20_000n, signal },
    { path: (_t, i) => ({ ...tree.path(i), root: tree.root() }), anyRoot: () => tree.root() },
    nodeProve,
  );
  assert.equal(built.change.amount, 980_000n);
  assert.equal(built.bundle.nullifier[0], nullifierOf(keys.sk, rho).toString());
  const vk = JSON.parse(readFileSync(CIRCUIT.vkey, 'utf8'));
  const b = built.bundle;
  const publics = [...b.root, ...b.nullifier, b.out[0].c, b.out[1].c, b.cost, String(b.asset), signal.toString(), b.tag.value, b.tag.epoch, String(b.tag.purpose)];
  const proof = { pi_a: [b.proof[0], b.proof[1], '1'], pi_b: [[b.proof[2], b.proof[3]], [b.proof[4], b.proof[5]], ['1', '0']], pi_c: [b.proof[6], b.proof[7], '1'], protocol: 'groth16', curve: 'bn128' };
  assert.ok(await snarkjs.groth16.verify(vk, publics, proof));
  // Tampering with the cost, the asset or the bound request breaks the proof.
  assert.equal(await snarkjs.groth16.verify(vk, publics.map((p, i) => (i === 6 ? '1' : p)), proof), false);
  assert.equal(await snarkjs.groth16.verify(vk, publics.map((p, i) => (i === 7 ? '1' : p)), proof), false); // spend dollars as if ZEC
  assert.equal(await snarkjs.groth16.verify(vk, publics.map((p, i) => (i === 8 ? '5' : p)), proof), false);
  // A forged daily tag (e.g. to get a second free withdrawal) fails too.
  assert.equal(await snarkjs.groth16.verify(vk, publics.map((p, i) => (i === 9 ? '12345' : p)), proof), false);
  const paths = { path: (_t: number, i: number) => ({ ...tree.path(i), root: tree.root() }), anyRoot: () => tree.root() };
  // Spending more than the note holds can't be proven.
  await assert.rejects(buildSpend(keys, { asset: USD, inputs: [note], cost: 2_000_000n, signal }, paths, nodeProve));
  // A dollar note can't be spent as ZEC: its leaf doesn't match an asset-1 commitment.
  await assert.rejects(buildSpend(keys, { asset: ZEC, inputs: [{ ...note, asset: ZEC }], cost: 1n, signal }, paths, nodeProve));
  void zeros;
});

test('a failed request is refunded, unless Zeep already paid the upstream for it', async () => {
  const { withCharge } = await import('../src/routes/paid.js');
  const { chargeCtx } = await import('../src/services/mpp.js');
  const { errors } = await import('../src/lib/errors.js');
  const reply = { sent: false, raw: { headersSent: false } } as never;
  let refunds = 0;
  const s = { compensate: async () => (refunds++, { tree: 1, indexes: [5], root: '0' }) } as never;
  // Upstream failed before any payment: the user gets the money back as a new note.
  await assert.rejects(withCharge(s, reply, async () => { throw errors.busy(); }), (e: { extra?: { compensation?: unknown } }) => !!e.extra?.compensation);
  assert.equal(refunds, 1);
  // An MPP credential was signed (Zeep paid), then it failed: not refundable.
  await assert.rejects(withCharge(s, reply, async () => { chargeCtx.getStore()!.upstreamPaid = true; throw errors.busy(); }), (e: { extra?: { refunded?: boolean } }) => e.extra?.refunded === false);
  assert.equal(refunds, 1);
});

test('the SDK refuses a server on another network before sending anything key-derived', async () => {
  const sent: string[] = [];
  const fakeFetch = (async (url: string) => {
    sent.push(String(url));
    return new Response(JSON.stringify({ network: 'mainnet' }), { status: 200 });
  }) as unknown as typeof fetch;
  const { ZeepClient: Client } = await import('../sdk/client');
  const c = new Client({ baseUrl: 'https://api.example', keys, book: new NoteBook(), prove: nodeProve, fetch: fakeFetch });
  await assert.rejects(c.depositStatus(0), /on mainnet, but these keys are for testnet/);
  assert.deepEqual(sent, ['https://api.example/v1/config']); // the intent id never left the device
});

// ------------------------------------------------------------------ OHTTP
test('ohttp: the server and SDK share one identical implementation', () => {
  assert.equal(readFileSync(new URL('../src/lib/ohttp.ts', import.meta.url), 'utf8'), readFileSync(new URL('../sdk/ohttp.ts', import.meta.url), 'utf8'));
});

test('ohttp: HPKE interoperates with an independent implementation (@hpke/core) both ways', async () => {
  const { CipherSuite, Aes128Gcm, HkdfSha256 } = await import('@hpke/core');
  const { DhkemX25519HkdfSha256 } = await import('@hpke/dhkem-x25519');
  const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
  const info = new TextEncoder().encode('zeep test info');
  const aad = new TextEncoder().encode('aad');
  const msg = new TextEncoder().encode('hello across implementations');
  // Theirs → ours.
  const rkp = await suite.kem.generateKeyPair();
  const skRaw = new Uint8Array(await suite.kem.serializePrivateKey(rkp.privateKey));
  const pkRaw = new Uint8Array(await suite.kem.serializePublicKey(rkp.publicKey));
  assert.deepEqual(ohttp.publicKeyOf(skRaw), pkRaw);
  const sender = await suite.createSenderContext({ recipientPublicKey: rkp.publicKey, info });
  const ct = new Uint8Array(await sender.seal(msg, aad));
  const mine = ohttp.setupBaseR(new Uint8Array(sender.enc), skRaw, info);
  assert.deepEqual(mine.open(aad, ct), msg);
  // Ours → theirs, and both exporters agree (the chunked-response keys come from it).
  const { enc, ctx } = ohttp.setupBaseS(pkRaw, info);
  const ct2 = ctx.seal(aad, msg);
  const recipient = await suite.createRecipientContext({ recipientKey: rkp, enc, info });
  assert.deepEqual(new Uint8Array(await recipient.open(ct2, aad)), msg);
  const label = new TextEncoder().encode('message/bhttp chunked response');
  assert.deepEqual(ctx.export(label, 16), new Uint8Array(await recipient.export(label, 16)));
});

test('ohttp: request and response round-trip; key configs parse; tampering is caught', () => {
  const sk = new Uint8Array(32).fill(3);
  const cfgBytes = ohttp.encodeKeyConfig(1, ohttp.publicKeyOf(sk));
  assert.equal(cfgBytes.length, 41);
  const key = ohttp.parseKeyConfig(ohttp.b64(cfgBytes));
  assert.equal(key.keyId, 1);
  assert.deepEqual(ohttp.parseKeyConfig(ohttp.encodeKeyConfigs([cfgBytes])).publicKey, key.publicKey);
  const body = new TextEncoder().encode('{"query":"x"}');
  const msg = ohttp.encodeRequest('POST', '/v1/search?x=1', [['content-type', 'application/json'], ['x-zeep-proof', 'abc']], body);
  const { body: sealed, ctx, enc } = ohttp.sealRequest(key, msg);
  assert.equal(sealed.length, ohttp.bucket(sealed.length)); // exactly a bucket size
  const opened = ohttp.openRequest(sealed, (id) => (id === 1 ? sk : undefined));
  const req = ohttp.decodeRequest(opened.plaintext);
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/v1/search?x=1');
  assert.deepEqual(req.headers, [['content-type', 'application/json'], ['x-zeep-proof', 'abc']]);
  assert.deepEqual(req.body, body);
  // Response in three chunks, read back in odd-sized network pieces.
  const w = ohttp.responseWriter(opened.ctx, opened.enc);
  const wire = ohttp.concat(
    w.nonce,
    w.chunk(ohttp.concat(ohttp.encodeResponseHead(200, [['x-zeep-notes', 'n1']]), ohttp.encodeContent(new TextEncoder().encode('hel')))),
    w.chunk(ohttp.encodeContent(new TextEncoder().encode('lo'))),
    w.final(ohttp.encodeResponseEnd(40)),
  );
  const reader = new ohttp.ResponseReader(ctx, enc);
  const parser = new ohttp.ResponseParser();
  const out: Uint8Array[] = [];
  for (let i = 0; i < wire.length; i += 7) for (const pt of reader.push(wire.subarray(i, i + 7))) out.push(...parser.push(pt).content);
  out.push(...parser.push(reader.end()).content);
  assert.equal(parser.status, 200);
  assert.deepEqual(parser.headers, [['x-zeep-notes', 'n1']]);
  assert.equal(new TextDecoder().decode(ohttp.concat(...out)), 'hello');
  assert.ok(parser.complete);
  // Flipped bit in a chunk → refused; reply cut before the final chunk → refused.
  const bad = wire.slice(); bad[30] ^= 1;
  assert.throws(() => new ohttp.ResponseReader(ctx, enc).push(bad));
  const cut = new ohttp.ResponseReader(ctx, enc);
  cut.push(wire.subarray(0, wire.length - 60));
  assert.throws(() => cut.end());
  // Wrong key, wrong id, flipped request bit.
  assert.throws(() => ohttp.openRequest(sealed, () => new Uint8Array(32).fill(4)));
  assert.throws(() => ohttp.openRequest(sealed, () => undefined));
  const flipped = sealed.slice(); flipped[60] ^= 1;
  assert.throws(() => ohttp.openRequest(flipped, () => sk));
});

// ------------------------------------------------------------------ provider prices (money-loss guards)
test('providers: Zeep never pays a provider more than the user paid, and free routes pay nothing', async () => {
  const { mayPay } = await import('../src/services/mpp.js');
  assert.equal(mayPay(undefined, 0), true); // zero-amount auth challenges (AgentMail reads) are fine
  assert.equal(mayPay(undefined, 0.001), false); // a free route never pays
  assert.equal(mayPay({ maxUsd: 0.0418 }, 0.04), true);
  assert.equal(mayPay({ maxUsd: 0.0418 }, 0.0455), false); // gateway counted more tokens than we charged
  assert.equal(mayPay({ maxUsd: 2.09 }, 2.0), true);
  assert.equal(mayPay({ maxUsd: 0.3135 }, 2.0), false); // the old $0.30 inbox vs AgentMail's $2
  assert.equal(mayPay({ maxUsd: 0.05, spentUsd: 0.04 }, 0.02), false); // across several payments
});

test('providers: prices can never be set below what the provider charges', () => {
  const base = { ...cfg, ZEEP_ENV: 'testnet' as const, ZCASH_NETWORK: 'test' as const };
  assert.deepEqual(networkProblems(base).filter((m) => /provider|stableemail/i.test(m)), []); // defaults are safe
  for (const [route, low] of [['inbox', 0.3], ['health', 0.005], ['research_core', 0.04], ['search', 0.005]] as const) {
    const p = networkProblems({ ...base, SERVICE_PRICES_USD_JSON: { ...cfg.SERVICE_PRICES_USD_JSON, [route]: low } }).join();
    assert.match(p, new RegExp(`${route} is ${low}, below the provider`));
  }
  assert.match(networkProblems({ ...base, INBOX_PROVIDER: 'stableemail' }).join(), /stableemail charges for every inbox read/);
});

test('providers: the AI price check reads the USDC.e offer from a 402 without paying', async () => {
  const { createServer } = await import('node:http');
  const { mppQuoteUsd } = await import('../src/services/mpp.js');
  const offer = (intent: string, amount: string, currency: string) =>
    `Payment id="x", realm="r", method="tempo", intent="${intent}", request="${Buffer.from(JSON.stringify({ amount, currency })).toString('base64url')}"`;
  let mode = 402;
  let calls = 0;
  const srv = createServer((req, res) => {
    calls++;
    if (req.headers.authorization) throw new Error('the probe must never send a payment');
    if (mode === 402) {
      res.writeHead(402, { 'www-authenticate': [offer('charge', '41000', cfg.TEMPO_USDC_E), offer('session', '45484', cfg.TEMPO_USDC_E.toLowerCase()), offer('session', '99000000', '0x20c000000000000000000000f37de3740ADec032')].join(', ') });
      return res.end('{}');
    }
    res.writeHead(mode, { 'content-type': 'application/json' });
    res.end('{"error":"bad model"}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1/chat/completions`;
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  try {
    assert.equal(await mppQuoteUsd(url, init), 0.045484); // the dearest USDC.e offer; other tokens ignored
    mode = 400;
    await assert.rejects(mppQuoteUsd(url, init), (e: { status: number }) => e.status === 400); // refused before payment
    mode = 502;
    await assert.rejects(mppQuoteUsd(url, init), (e: { status: number }) => e.status === 503);
    assert.equal(calls, 3);
  } finally {
    srv.close();
  }
});

test('health: RxAtlas and TrialBase records become readable list items; empty results say so', async () => {
  const { healthItem } = await import('../src/routes/services.js');
  const d = healthItem('drug', { id: 1, brand_name: 'LIPITOR', generic_name: 'Atorvastatin calcium', strength: '20 mg/1', dosage_form: 'TABLET', route: 'ORAL', manufacturer_name: 'Pfizer', has_recall: false });
  assert.deepEqual(d, { id: 1, title: 'LIPITOR', snippet: 'Atorvastatin calcium · 20 mg/1 · TABLET · ORAL · Pfizer' });
  const t = healthItem('trial', { id: 2, registry_id: 'NCT01', brief_title: 'Asthma study', status: 'recruiting', phase: 'PHASE3', conditions: ['Asthma'], source_record_url: 'javascript:alert(1)' });
  assert.equal(t.title, 'Asthma study');
  assert.equal(t.snippet, 'NCT01 · Status: recruiting · PHASE3 · Asthma');
  assert.equal(t.url, undefined); // only https links pass through
  assert.equal(healthItem('drug', { id: 3 }).title, 'Drug product 3');
});
