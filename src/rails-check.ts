// Live dry run of every money rail and paid provider. NOTHING is signed or sent:
// quotes, balance reads, transaction simulations and unpaid 402 price checks only.
//
//   heroku run -a <app> -- node dist/rails-check.js
//
// Prints PASS / WARN / FAIL lines in plain text, never keys, seeds or full addresses.
import { OneClickService, OpenAPI, QuoteRequest } from '@defuse-protocol/one-click-sdk-typescript';
import { createPublicClient, encodeFunctionData, erc20Abi, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, tempo } from 'viem/chains';
import { cfg, PROVIDER_COST_USD } from './config.js';
import { pool, q } from './lib/db.js';
import { mppQuoteUsd } from './services/mpp.js';
import { requiredMicroUsd, zecQuotes } from './services/prices.js';

let fails = 0;
let warns = 0;
const out = (s: string) => process.stdout.write(s + '\n');
const pass = (m: string) => out(`PASS  ${m}`);
const warn = (m: string) => { warns++; out(`WARN  ${m}`); };
const fail = (m: string) => { fails++; out(`FAIL  ${m}`); };
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const usd = (micro: bigint | number) => `$${(Number(micro) / 1e6).toFixed(4)}`;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    fail(`${name}: ${(e as Error).message.split('\n')[0].slice(0, 300)}`);
  }
}

const account = privateKeyToAccount(cfg.TEMPO_PRIVATE_KEY as Hex);
const who = account.address;
const tempoChain = { ...tempo, rpcUrls: { default: { http: [cfg.TEMPO_RPC_URL ?? tempo.rpcUrls.default.http[0]] } } };
const t = createPublicClient({ chain: tempoChain, transport: http() });
const b = createPublicClient({ chain: base, transport: http(cfg.BASE_RPC_URL) });
const relayHeaders = (h: Record<string, string>) => (cfg.RELAY_API_KEY ? { ...h, 'x-api-key': cfg.RELAY_API_KEY } : h);

async function main() {
  out(`Zeep rails check (${cfg.ZEEP_ENV}), treasury ${short(who)}. Nothing is sent.\n`);
  let tempoUsdc = 0n;
  let baseEth = 0n;

  await step('price', async () => {
    const p = await zecQuotes();
    pass(`ZEC price $${p.current.usd} from ${p.current.source ?? 'feed'}`);
  });

  await step('balances', async () => {
    const [tu, bu, be] = await Promise.all([
      t.readContract({ address: cfg.TEMPO_USDC_E as Hex, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
      b.readContract({ address: cfg.BASE_USDC as Hex, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
      b.getBalance({ address: who }),
    ]);
    tempoUsdc = tu;
    baseEth = be;
    pass(`Tempo USDC.e ${usd(tu)}, Base USDC ${usd(bu)}, Base ETH ${(Number(be) / 1e18).toFixed(6)}`);
    if (tu < 2_100_000n) warn(`the float (${usd(tu)}) is below $2.10: anonymous inboxes ($2.00 at AgentMail) can't be bought until it grows`);
    if (cfg.MPP_SESSION_MAX_USD * 1e6 > Number(tu)) warn(`MPP_SESSION_MAX_USD ($${cfg.MPP_SESSION_MAX_USD}) is above the float; AI sessions may fail to open`);
  });

  await step('Base gas', async () => {
    const gas = await b.estimateGas({
      account: who,
      to: cfg.BASE_USDC as Hex,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [who, 0n] }),
    });
    const price = await b.getGasPrice();
    const perTx = gas * price * 2n; // headroom
    const txs = perTx > 0n ? baseEth / perTx : 0n;
    if (txs < 10n) fail(`Base ETH covers only ~${txs} transactions; top it up`);
    else pass(`Base ETH covers ~${txs} USDC transfers (bridge legs)`);
  });

  // ---------------------------------------------------------------- NEAR Intents 1Click (dry quotes)
  OpenAPI.BASE = cfg.NEAR_ONECLICK_BASE_URL;
  OpenAPI.TOKEN = cfg.NEAR_ONECLICK_JWT;
  const reserve = cfg.TREASURY_REFUND_TO || cfg.ZEEP_RESERVE_TADDR!;
  const deadline = new Date(Date.now() + 3600_000).toISOString();
  await step('1Click ZEC → Base USDC', async () => {
    const r = await OneClickService.getQuote({
      dry: true, swapType: QuoteRequest.swapType.EXACT_INPUT, slippageTolerance: cfg.TREASURY_SLIPPAGE_BPS,
      originAsset: cfg.TREASURY_SWAP_ORIGIN_ASSET, depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
      destinationAsset: cfg.TREASURY_SWAP_DEST_ASSET, amount: '5000000', refundTo: reserve,
      refundType: QuoteRequest.refundType.ORIGIN_CHAIN, recipient: who, recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN, deadline,
    } as QuoteRequest);
    pass(`1Click: 0.05 ZEC → ${usd(BigInt(r.quote.amountOut ?? '0'))} USDC on Base (refunds to the reserve ${short(reserve)})`);
  });
  await step('1Click Base USDC → ZEC', async () => {
    const r = await OneClickService.getQuote({
      dry: true, swapType: QuoteRequest.swapType.EXACT_INPUT, slippageTolerance: cfg.TREASURY_SLIPPAGE_BPS,
      originAsset: cfg.TREASURY_SWAP_DEST_ASSET, depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
      destinationAsset: cfg.TREASURY_SWAP_ORIGIN_ASSET, amount: '5000000', refundTo: who,
      refundType: QuoteRequest.refundType.ORIGIN_CHAIN, recipient: cfg.ZEEP_RESERVE_TADDR!, recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN, deadline,
    } as QuoteRequest);
    pass(`1Click: $5 USDC → ${(Number(r.quote.amountOut ?? 0) / 1e8).toFixed(6)} ZEC to the reserve ${short(cfg.ZEEP_RESERVE_TADDR!)}`);
  });

  // ---------------------------------------------------------------- Relay (quotes + simulation)
  const relayQuote = async (toTempo: boolean, amount: bigint) => {
    const res = await fetch(`${cfg.RELAY_API_URL}/quote/v2`, {
      method: 'POST',
      headers: relayHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        user: who, recipient: who,
        originChainId: toTempo ? base.id : cfg.TEMPO_CHAIN_ID, destinationChainId: toTempo ? cfg.TEMPO_CHAIN_ID : base.id,
        originCurrency: toTempo ? cfg.BASE_USDC : cfg.TEMPO_USDC_E, destinationCurrency: toTempo ? cfg.TEMPO_USDC_E : cfg.BASE_USDC,
        amount: amount.toString(), tradeType: 'EXACT_INPUT',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Relay ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as { steps: { kind: string; items: { data: { to: Hex; data: Hex; value?: string } }[] }[]; details?: { currencyOut?: { amount?: string } } };
  };
  await step('Relay Base → Tempo', async () => {
    const qt = await relayQuote(true, 5_000_000n);
    if (qt.steps.some((s) => s.kind !== 'transaction')) throw new Error('quote has a non-transaction step');
    pass(`Relay: $5 Base USDC → ${usd(BigInt(qt.details?.currencyOut?.amount ?? '0'))} USDC.e on Tempo (${qt.steps.length} step(s))`);
  });
  await step('Relay Tempo → Base', async () => {
    const amount = tempoUsdc > 600_000n ? 500_000n : 0n;
    if (!amount) return warn('the float is too small to simulate a bridge back; skipped');
    const qt = await relayQuote(false, amount);
    if (qt.steps.some((s) => s.kind !== 'transaction')) throw new Error('quote has a non-transaction step');
    // Simulate the first transaction from the treasury (no signature, nothing sent).
    const tx = qt.steps[0].items[0].data;
    await t.call({ account: who, to: tx.to, data: tx.data, value: BigInt(tx.value ?? '0') });
    pass(`Relay: $0.50 USDC.e → ${usd(BigInt(qt.details?.currencyOut?.amount ?? '0'))} on Base; the Tempo transaction simulates OK`);
  });

  // ---------------------------------------------------------------- reserve wallet (ZEC in and out)
  await step('reserve wallet', async () => {
    const [w] = await q<{ chain_height: number; scanned_height: number; reserve_balance_zats: string; reserve_spendable_zats: string; updated_at: Date }>(
      'SELECT chain_height, scanned_height, reserve_balance_zats, reserve_spendable_zats, updated_at FROM wallet_state WHERE id = 1');
    const age = (Date.now() - new Date(w.updated_at).getTime()) / 1000;
    if (age > 600) fail(`the wallet dyno last reported ${Math.round(age / 60)} min ago; is it running?`);
    else if ((w.chain_height ?? 0) - (w.scanned_height ?? 0) > 3) warn(`the wallet is ${w.chain_height - w.scanned_height} blocks behind`);
    else pass(`wallet synced to ${w.scanned_height}; reserve ${(Number(w.reserve_balance_zats ?? 0) / 1e8).toFixed(8)} ZEC (${(Number(w.reserve_spendable_zats ?? 0) / 1e8).toFixed(8)} spendable)`);
    const [p] = await q<{ stuck: number; waiting: number }>(`SELECT count(*) FILTER (WHERE status IN ('stuck','failed'))::int AS stuck, count(*) FILTER (WHERE status IN ('scheduled','sending','sent'))::int AS waiting FROM payouts`);
    if (p.stuck) fail(`${p.stuck} payout(s) stuck: manual review`);
    else pass(`payouts: ${p.waiting} in progress, none stuck`);
    const [c] = await q<{ failed: number; open: number }>(`SELECT count(*) FILTER (WHERE step = 'failed')::int AS failed, count(*) FILTER (WHERE step NOT IN ('done','failed'))::int AS open FROM conversions`);
    if (c.failed) fail(`${c.failed} conversion(s) failed: check the conversions table`);
    else pass(`conversions: ${c.open} in progress, none failed`);
  });

  // ---------------------------------------------------------------- paid providers: live price vs Zeep's price
  const probes: [string, string, string, RequestInit][] = [
    ['search', 'Exa', `${cfg.MPP_EXA_URL}/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"x","numResults":8}' }],
    ['research_base', 'Parallel answer (low)', `${cfg.MPP_PARALLEL_URL}/api/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"input":"x","reasoning":{"effort":"low"}}' }],
    ['research_core', 'Parallel answer (medium)', `${cfg.MPP_PARALLEL_URL}/api/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"input":"x","reasoning":{"effort":"medium"}}' }],
    ['research_pro', 'Parallel task (pro)', `${cfg.MPP_PARALLEL_URL}/api/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"input":"x","processor":"pro"}' }],
    ['health', 'RxAtlas', `${cfg.MPP_RXATLAS_URL}/v1/drugs?q=aspirin&limit=5`, { method: 'GET' }],
    ['health', 'TrialBase', `${cfg.MPP_TRIALBASE_URL}/v1/trials?q=asthma&limit=5`, { method: 'GET' }],
    ['inbox', 'AgentMail inbox', `${cfg.MPP_AGENTMAIL_URL}/v0/inboxes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
  ];
  for (const [route, name, url, init] of probes) {
    await step(name, async () => {
      const cost = await mppQuoteUsd(url, init);
      const ours = requiredMicroUsd(cfg.SERVICE_PRICES_USD_JSON[route] ?? 0) / 1e6;
      if (ours < cost) fail(`${name}: provider charges $${cost}, Zeep charges $${ours.toFixed(4)} (${route}): raise the price`);
      else pass(`${name}: provider $${cost} ≤ Zeep $${ours.toFixed(4)}`);
      if (PROVIDER_COST_USD[route] !== undefined && cost > PROVIDER_COST_USD[route]) warn(`${name} now costs more than the built-in floor ($${PROVIDER_COST_USD[route]}); update PROVIDER_COST_USD`);
    });
  }
  await step('AI gateway', async () => {
    const m = cfg.MODELS_JSON.find((x) => x.id === cfg.DEFAULT_MODEL) ?? cfg.MODELS_JSON[0];
    const cost = await mppQuoteUsd(`${cfg.MPP_OPENROUTER_URL}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: m.upstream ?? m.id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
    });
    pass(`AI gateway answers with a price for ${m.id} ($${cost} for a tiny request); every reply is priced from this quote`);
  });

  out(`\n${fails ? `${fails} FAIL` : 'No failures'}, ${warns} warning(s).`);
}

main()
  .catch((e) => fail(`check crashed: ${(e as Error).message}`))
  .finally(async () => {
    await pool.end().catch(() => {});
    process.exit(fails ? 1 : 0);
  });
