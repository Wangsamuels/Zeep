// The money rails between the ZEC reserve and the Tempo float.
//
//   to Tempo:  ZEC ──NEAR Intents 1Click──▶ USDC on Base ──Relay──▶ USDC.e on Tempo
//   to ZEC:    USDC.e on Tempo ──Relay──▶ USDC on Base ──NEAR Intents 1Click──▶ ZEC (reserve t-addr)
//
// NEAR Intents does not list Tempo, hence Base in the middle; and NEAR Intents' Zcash
// support is transparent-only, so ZEC leaves to (and returns at) transparent addresses.
// The payouts worker shields returned ZEC back into the reserve automatically.
//
// `mock` rails simulate all of this instantly (tests, testnet without a funded EVM wallet).
import { OneClickService, OpenAPI, QuoteRequest } from '@defuse-protocol/one-click-sdk-typescript';
import { createPublicClient, createWalletClient, erc20Abi, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, tempo } from 'viem/chains';
import { cfg, need } from '../config.js';
import { q } from '../lib/db.js';

export type Status = 'pending' | 'success' | 'failed';

export interface Rails {
  balances(): Promise<{ tempoUsdc: bigint; baseUsdc: bigint }>;
  /** 1Click quote ZEC → Base USDC. Returns the transparent ZEC deposit address to pay. */
  quoteZecToBase(zats: bigint): Promise<{ depositAddress: string }>;
  /** 1Click quote Base USDC → ZEC delivered to the reserve's t-address. Returns an EVM deposit address. */
  quoteBaseToZec(usdc: bigint): Promise<{ depositAddress: string }>;
  swapStatus(depositAddress: string): Promise<{ status: Status; amountOut?: bigint }>;
  /** Send Base USDC to a 1Click deposit address. */
  payBaseUsdc(depositAddress: string, usdc: bigint): Promise<void>;
  bridge(direction: 'base_to_tempo' | 'tempo_to_base', usdc: bigint): Promise<string>;
  bridgeStatus(requestId: string): Promise<Status>;
}

// ------------------------------------------------------------------------------ live
function oneClick() {
  OpenAPI.BASE = cfg.NEAR_ONECLICK_BASE_URL;
  OpenAPI.TOKEN = need('NEAR_ONECLICK_JWT');
}
const account = () => privateKeyToAccount(need('TEMPO_PRIVATE_KEY') as Hex);
const tempoChain = () => ({ ...tempo, rpcUrls: { default: { http: [cfg.TEMPO_RPC_URL ?? tempo.rpcUrls.default.http[0]] } } });
const baseUsdcAsset = () => cfg.TREASURY_SWAP_DEST_ASSET; // nep141 id of USDC on Base
const reserveTaddr = () => cfg.TREASURY_REFUND_TO || need('ZEEP_RESERVE_TADDR');
const deadline = () => new Date(Date.now() + 2 * 3600_000).toISOString();

const live: Rails = {
  async balances() {
    const who = account().address;
    const t = createPublicClient({ chain: tempoChain(), transport: http() });
    const b = createPublicClient({ chain: base, transport: http(cfg.BASE_RPC_URL) });
    const [tempoUsdc, baseUsdc] = await Promise.all([
      t.readContract({ address: cfg.TEMPO_USDC_E as Hex, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
      b.readContract({ address: cfg.BASE_USDC as Hex, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
    ]);
    return { tempoUsdc, baseUsdc };
  },

  async quoteZecToBase(zats) {
    oneClick();
    const qr = await OneClickService.getQuote({
      dry: false,
      swapType: QuoteRequest.swapType.EXACT_INPUT,
      slippageTolerance: cfg.TREASURY_SLIPPAGE_BPS,
      originAsset: cfg.TREASURY_SWAP_ORIGIN_ASSET,
      depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
      destinationAsset: baseUsdcAsset(),
      amount: zats.toString(),
      refundTo: reserveTaddr(),
      refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
      recipient: account().address,
      recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
      deadline: deadline(),
    } as QuoteRequest);
    if (!qr.quote.depositAddress) throw new Error('1Click returned no deposit address');
    return { depositAddress: qr.quote.depositAddress };
  },

  async quoteBaseToZec(usdc) {
    oneClick();
    const qr = await OneClickService.getQuote({
      dry: false,
      swapType: QuoteRequest.swapType.EXACT_INPUT,
      slippageTolerance: cfg.TREASURY_SLIPPAGE_BPS,
      originAsset: baseUsdcAsset(),
      depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
      destinationAsset: cfg.TREASURY_SWAP_ORIGIN_ASSET,
      amount: usdc.toString(),
      refundTo: account().address,
      refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
      recipient: need('ZEEP_RESERVE_TADDR'),
      recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
      deadline: deadline(),
    } as QuoteRequest);
    if (!qr.quote.depositAddress) throw new Error('1Click returned no deposit address');
    return { depositAddress: qr.quote.depositAddress };
  },

  async swapStatus(depositAddress) {
    oneClick();
    const st = await OneClickService.getExecutionStatus(depositAddress);
    if (st.status === 'SUCCESS') return { status: 'success', amountOut: BigInt(st.swapDetails?.amountOut ?? '0') };
    if (st.status === 'REFUNDED' || st.status === 'FAILED') return { status: 'failed' };
    return { status: 'pending' };
  },

  async payBaseUsdc(depositAddress, usdc) {
    const w = createWalletClient({ account: account(), chain: base, transport: http(cfg.BASE_RPC_URL) });
    const p = createPublicClient({ chain: base, transport: http(cfg.BASE_RPC_URL) });
    const hash = await w.writeContract({ address: cfg.BASE_USDC as Hex, abi: erc20Abi, functionName: 'transfer', args: [depositAddress as Hex, usdc] });
    await p.waitForTransactionReceipt({ hash, timeout: 120_000 });
    oneClick();
    await OneClickService.submitDepositTx({ txHash: hash, depositAddress }).catch(() => {}); // speeds detection
  },

  async bridge(direction, usdc) {
    const toTempo = direction === 'base_to_tempo';
    const origin = toTempo ? base : tempoChain();
    const who = account();
    const res = await fetch(`${cfg.RELAY_API_URL}/quote/v2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user: who.address,
        recipient: who.address,
        originChainId: toTempo ? base.id : cfg.TEMPO_CHAIN_ID,
        destinationChainId: toTempo ? cfg.TEMPO_CHAIN_ID : base.id,
        originCurrency: toTempo ? cfg.BASE_USDC : cfg.TEMPO_USDC_E,
        destinationCurrency: toTempo ? cfg.TEMPO_USDC_E : cfg.BASE_USDC,
        amount: usdc.toString(),
        tradeType: 'EXACT_INPUT',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`relay quote failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const quote = (await res.json()) as { steps: { kind: string; requestId?: string; items: { status?: string; data: { to: Hex; data: Hex; value?: string } }[] }[] };
    const w = createWalletClient({ account: who, chain: origin, transport: http(toTempo ? cfg.BASE_RPC_URL : undefined) });
    const p = createPublicClient({ chain: origin, transport: http(toTempo ? cfg.BASE_RPC_URL : undefined) });
    let requestId = '';
    for (const step of quote.steps) {
      if (step.requestId) requestId ||= step.requestId;
      if (step.kind !== 'transaction') throw new Error(`unsupported Relay step: ${step.kind}`);
      for (const item of step.items) {
        if (item.status === 'complete') continue;
        const hash = await w.sendTransaction({ to: item.data.to, data: item.data.data, value: BigInt(item.data.value ?? '0'), chain: origin } as never);
        await p.waitForTransactionReceipt({ hash, timeout: 120_000 });
      }
    }
    if (!requestId) throw new Error('relay quote had no request id');
    return requestId;
  },

  async bridgeStatus(requestId) {
    const r = await fetch(`${cfg.RELAY_API_URL}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return 'pending';
    const s = ((await r.json()) as { status?: string }).status ?? 'pending';
    return s === 'success' ? 'success' : ['failure', 'refund', 'refunded'].includes(s) ? 'failed' : 'pending';
  },
};

// ------------------------------------------------------------------------------ mock
// Simulates the rails at the live ZEC price minus 1% (fees + slippage). ZEC coming back is
// written to dev_incoming at the reserve t-address, so the dev chain's balance rises.
const MOCK_COST_BPS = 100n;
const pendingSwaps = new Map<string, { kind: 'zec_to_base' | 'base_to_zec'; amount: bigint }>();
let mockBase = 0n;

async function mockPrice(): Promise<number> {
  const { zecQuotes } = await import('../services/prices.js');
  return (await zecQuotes()).current.usd;
}
const devHeight = () => Math.floor((Date.now() / 1000 - Number(process.env.DEV_GENESIS_UNIX ?? 1_760_000_000)) / Number(process.env.DEV_BLOCK_SECS ?? 75));

const mock: Rails = {
  async balances() {
    const [r] = await q<{ tempo_usdc: string }>('SELECT tempo_usdc FROM dev_rails WHERE id = 1');
    return { tempoUsdc: BigInt(r.tempo_usdc), baseUsdc: mockBase };
  },
  async quoteZecToBase(zats) {
    const addr = `tmMockDeposit${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    pendingSwaps.set(addr, { kind: 'zec_to_base', amount: zats });
    return { depositAddress: addr };
  },
  async quoteBaseToZec(usdc) {
    const addr = `0xmock${Date.now().toString(16)}${Math.floor(Math.random() * 1e6)}`;
    pendingSwaps.set(addr, { kind: 'base_to_zec', amount: usdc });
    return { depositAddress: addr };
  },
  async swapStatus(addr) {
    const s = pendingSwaps.get(addr);
    if (!s) return { status: 'failed' };
    const px = await mockPrice();
    if (s.kind === 'zec_to_base') {
      const usdc = (BigInt(Math.floor((Number(s.amount) / 1e8) * px * 1e6)) * (10_000n - MOCK_COST_BPS)) / 10_000n;
      mockBase += usdc;
      pendingSwaps.delete(addr);
      return { status: 'success', amountOut: usdc };
    }
    const zats = (BigInt(Math.floor((Number(s.amount) / 1e6 / px) * 1e8)) * (10_000n - MOCK_COST_BPS)) / 10_000n;
    await q('INSERT INTO dev_incoming (txid, to_address, height, amount_zats) VALUES ($1, $2, $3, $4)',
      [`mock-back-${addr}`, cfg.ZEEP_RESERVE_TADDR || 'tmMockReserve', devHeight() - 1, zats.toString()]);
    pendingSwaps.delete(addr);
    return { status: 'success', amountOut: zats };
  },
  async payBaseUsdc(_addr, usdc) {
    mockBase -= usdc;
  },
  async bridge(direction, usdc) {
    if (direction === 'base_to_tempo') {
      mockBase -= usdc;
      await q('UPDATE dev_rails SET tempo_usdc = tempo_usdc + $1 WHERE id = 1', [usdc.toString()]);
    } else {
      await q('UPDATE dev_rails SET tempo_usdc = tempo_usdc - $1 WHERE id = 1', [usdc.toString()]);
      mockBase += usdc;
    }
    return `mock-relay-${Date.now()}`;
  },
  async bridgeStatus() {
    return 'success';
  },
};

export const rails = (): Rails => (cfg.TREASURY_RAILS === 'live' ? live : mock);
