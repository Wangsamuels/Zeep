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

/** Thrown when a rail step failed before any money moved (safe to retry). */
export class NotSent extends Error {}

export interface Rails {
  balances(): Promise<{ tempoUsdc: bigint; baseUsdc: bigint }>;
  /** 1Click quote ZEC → Base USDC. Returns the transparent ZEC deposit address to pay. */
  quoteZecToBase(zats: bigint): Promise<{ depositAddress: string }>;
  /** 1Click quote Base USDC → ZEC delivered to the reserve's t-address. Returns an EVM deposit address. */
  quoteBaseToZec(usdc: bigint): Promise<{ depositAddress: string }>;
  swapStatus(depositAddress: string): Promise<{ status: Status; amountOut?: bigint }>;
  /** Dry 1Click quote (nothing created): would Base USDC → ZEC accept this amount? */
  canSwapBaseToZec(usdc: bigint): Promise<boolean>;
  /** Send Base USDC to a 1Click deposit address. */
  payBaseUsdc(depositAddress: string, usdc: bigint): Promise<void>;
  /** Bridge `usdc` (exact input). Returns the Relay request id and the USDC the destination will receive. */
  bridge(direction: 'base_to_tempo' | 'tempo_to_base', usdc: bigint): Promise<{ requestId: string; amountOut: bigint }>;
  bridgeStatus(requestId: string): Promise<Status>;
}

// ------------------------------------------------------------------------------ live
/** Relay.link needs `x-api-key` on quotes (since 2 Oct 2026); also sent on status calls for higher limits. */
const relayHeaders = (h: Record<string, string>): Record<string, string> =>
  cfg.RELAY_API_KEY ? { ...h, 'x-api-key': cfg.RELAY_API_KEY } : h;
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

  async canSwapBaseToZec(usdc) {
    oneClick();
    try {
      await OneClickService.getQuote({
        dry: true,
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
      return true;
    } catch (e) {
      if (/too low/i.test(String((e as { body?: { message?: string } }).body?.message ?? (e as Error).message))) return false;
      throw e;
    }
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
    // Everything up to the first transaction is safe to retry: any failure here is NotSent.
    type Quote = {
      steps: { kind: string; requestId?: string; items: { status?: string; data: { to: Hex; data: Hex; value?: string } }[] }[];
      details?: { currencyOut?: { amount?: string } };
    };
    const getQuote = async (): Promise<Quote> => {
      const res = await fetch(`${cfg.RELAY_API_URL}/quote/v2`, {
        method: 'POST',
        headers: relayHeaders({ 'content-type': 'application/json' }),
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
      if (!res.ok) throw new NotSent(`relay quote failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as Quote;
    };
    let quote: Quote;
    try {
      quote = await getQuote();
    } catch (e) {
      throw e instanceof NotSent ? e : new NotSent(`relay quote failed: ${(e as Error).message}`);
    }
    const amountOut = BigInt(quote.details?.currencyOut?.amount ?? '0');
    if (amountOut <= 0n || amountOut > usdc) throw new NotSent('relay quote has no usable output amount');
    if (quote.steps.some((s) => s.kind !== 'transaction')) throw new NotSent('unsupported Relay step');
    const requestId = quote.steps.find((s) => s.requestId)?.requestId;
    if (!requestId) throw new NotSent('relay quote had no request id');
    const w = createWalletClient({ account: who, chain: origin, transport: http(toTempo ? cfg.BASE_RPC_URL : undefined) });
    const p = createPublicClient({ chain: origin, transport: http(toTempo ? cfg.BASE_RPC_URL : undefined) });
    for (const step of quote.steps) {
      for (const item of step.items) {
        if (item.status === 'complete') continue;
        const hash = await w.sendTransaction({ to: item.data.to, data: item.data.data, value: BigInt(item.data.value ?? '0'), chain: origin } as never);
        await p.waitForTransactionReceipt({ hash, timeout: 120_000 });
      }
    }
    return { requestId, amountOut };
  },

  async bridgeStatus(requestId) {
    const r = await fetch(`${cfg.RELAY_API_URL}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`, {
      headers: relayHeaders({}),
      signal: AbortSignal.timeout(15_000),
    });
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
  async canSwapBaseToZec(usdc) {
    return usdc >= 1_000_000n; // NEAR's live minimum is ~$1.70
  },
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
    // Relay keeps a small fee (0.05%): what arrives is less than what was sent.
    const out = usdc - (usdc * 5n) / 10_000n;
    if (direction === 'base_to_tempo') {
      mockBase -= usdc;
      await q('UPDATE dev_rails SET tempo_usdc = tempo_usdc + $1 WHERE id = 1', [out.toString()]);
    } else {
      await q('UPDATE dev_rails SET tempo_usdc = tempo_usdc - $1 WHERE id = 1', [usdc.toString()]);
      mockBase += out;
    }
    return { requestId: `mock-relay-${Date.now()}`, amountOut: out };
  },
  async bridgeStatus() {
    return 'success';
  },
};

export const rails = (): Rails => (cfg.TREASURY_RAILS === 'live' ? live : mock);
