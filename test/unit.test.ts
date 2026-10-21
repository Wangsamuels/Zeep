// Unit tests (no DB/Redis): tree, signals, units, keys, note backups, real spend proofs.
import './setup.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import * as snarkjs from 'snarkjs';
import { decryptAddr, encryptAddr } from '../src/lib/crypto.js';
import { MerkleTree } from '../src/notes/tree.js';
import { requestSignal as serverSignal, withdrawSignal as serverWithdraw } from '../src/notes/spend.js';
import { isTransparent, validPayoutAddress, withdrawalAmounts } from '../src/routes/money.js';
import { marginOf } from '../src/services/fees.js';
import { decide } from '../src/treasury/float.js';
import { chatUsd, requiredMicroUsd, withMarkup, zatsToMicroUsd } from '../src/services/prices.js';
import { decryptNote, deriveKeys, depositSlot, encryptNote, estimateDeposit, formatCredits, formatUsd, NoteBook, noteFromKeys, nullifierOf, parseZec, requestSignal, USD, withdrawSignal, ZEC, zeros } from '../sdk/index';
import { buildSpend } from '../sdk/spend';
import { CIRCUIT, nodeProve } from './helpers/prove.js';

after(async () => {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

const seed = new Uint8Array(64).fill(9);
const keys = deriveKeys(seed);

test('incremental tree matches bulk load', () => {
  const leaves = Array.from({ length: 37 }, (_, i) => BigInt(i * 7919 + 1));
  const a = new MerkleTree(20);
  leaves.forEach((l) => a.append(l));
  const b = new MerkleTree(20);
  b.load(leaves);
  assert.equal(a.root(), b.root());
});

test('client and server compute the same signals', () => {
  assert.equal(requestSignal('POST', '/v1/search', '{"q":1}'), serverSignal('POST', '/v1/search', '{"q":1}'));
  assert.equal(withdrawSignal('ABC', 'utest1x'), serverWithdraw('abc', 'utest1x'));
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
  assert.deepEqual(depositSlot(deriveKeys(seed), 3), depositSlot(keys, 3));
  assert.notEqual(depositSlot(keys, 3).intentId, depositSlot(keys, 4).intentId);
  assert.notEqual(depositSlot(keys, 3).d, depositSlot(keys, 3).dZec); // the deposit's dollar and ZEC notes
  assert.notEqual(deriveKeys(new Uint8Array(64).fill(1)).vaultId, keys.vaultId);
});

test('note backups decrypt only with the owner key', async () => {
  const e = await encryptNote(keys.noteKey, 123_456n, 42n, ZEC);
  assert.deepEqual(await decryptNote(keys.noteKey, e), { amount: 123_456n, rho: 42n, asset: ZEC });
  assert.equal(await decryptNote(deriveKeys(new Uint8Array(64).fill(2)).noteKey, e), null);
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
