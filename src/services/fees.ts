// Fee policy (all amounts in micro-USD unless named *_zats). Fees apply only to what is
// actually converted; ZEC kept and paid out as ZEC pays no conversion fee.
//
//   service     upstream price + PRICE_MARKUP_BPS (4.5%)
//   ZEC → $     DEPOSIT_FEE_BPS of the converted value (the dollar half of a deposit, refills):
//               pays ZEC → USDC (NEAR Intents) → Tempo (Relay) + gas, with a margin
//   $ → ZEC     WITHDRAWAL_FEE_BPS of the credits converted back in a withdrawal: pays
//               Tempo → Base → ZEC, with a margin
//   withdrawal  the two payout network fees (zats), except on the user's first withdrawal of
//               the day (then Zeep pays them)
//   first deposit of the day: the user's own network fee is credited back
//
// Covered network fees come only from profit above PROFIT_FLOOR_BPS of volume over the last
// SUBSIDY_WINDOW_DAYS (plus a one-off launch allowance). When that budget is spent, everyone
// pays their own network fees until profit builds up again.
import { cfg } from '../config.js';
import { pool, type Tx } from '../lib/db.js';
import { addBooks, bookTotals } from './books.js';
import { zatsToMicroUsd, zecQuotes } from './prices.js';

/** Markup portion of a marked-up service charge. */
export function marginOf(cost: bigint): bigint {
  const bps = BigInt(cfg.PRICE_MARKUP_BPS);
  return (cost * bps) / (10_000n + bps);
}

export const bpsOf = (amount: number, bps: number) => Math.ceil((amount * bps) / 10_000);

/** The two payout network fees of a withdrawal, in micro-USD at today's price. */
export async function payoutNetworkFeeMicroUsd(): Promise<number> {
  return zatsToMicroUsd(2 * cfg.REFUND_NETWORK_FEE_ZATS, (await zecQuotes()).current.usd);
}
/** One deposit network fee (what the user's wallet paid), in micro-USD. */
export async function depositNetworkFeeMicroUsd(): Promise<number> {
  return zatsToMicroUsd(cfg.REFUND_NETWORK_FEE_ZATS, (await zecQuotes()).current.usd);
}

/** Micro-USD Zeep can spend on covered fees without dropping below the profit floor. */
export async function subsidyBudget(c: Pick<Tx, 'query'> = pool): Promise<number> {
  const w = await bookTotals(c, cfg.SUBSIDY_WINDOW_DAYS);
  const all = await bookTotals(c);
  const bootstrapLeft = Math.max(0, cfg.SUBSIDY_BOOTSTRAP_MICRO_USD - all('subsidy'));
  const volume = w('service') + w('deposit') + w('usd_from_zec') + w('withdrawal');
  const profit = w('margin') + w('conversion_fee') + w('network_fee') - w('subsidy') - w('conversion_cost');
  const floor = (volume * cfg.PROFIT_FLOOR_BPS) / 10_000;
  return Math.floor(Math.max(0, profit - floor) + bootstrapLeft);
}

/** Reserve `amount` of subsidy inside a transaction; false if the budget can't cover it. */
export async function takeSubsidy(c: Tx, amount: number): Promise<boolean> {
  await c.query('SELECT pg_advisory_xact_lock(727700)');
  if ((await subsidyBudget(c)) < amount) return false;
  await addBooks(c, 'subsidy', amount);
  return true;
}

export async function feeSheet() {
  const [budget, payoutFee, depFee] = await Promise.all([subsidyBudget(), payoutNetworkFeeMicroUsd(), depositNetworkFeeMicroUsd()]);
  return {
    unit: 'micro_usd',
    service_markup_bps: cfg.PRICE_MARKUP_BPS,
    deposit: {
      zec_share_bps: cfg.ZEC_SHARE_BPS, // kept as ZEC, no fee
      all_credits_below_micro_usd: cfg.ALL_CREDITS_BELOW_MICRO_USD, // smaller deposits become credits only
      fee_bps: cfg.DEPOSIT_FEE_BPS, // on the converted half
      first_today_network_fee_back_micro_usd: depFee,
      min_micro_usd_for_free: cfg.FREE_FEE_MIN_MICRO_USD,
    },
    refill: { fee_bps: cfg.DEPOSIT_FEE_BPS, min_zats: cfg.MIN_CONVERT_ZATS },
    withdrawal: {
      fee_bps: cfg.WITHDRAWAL_FEE_BPS, // only on credits converted back to ZEC
      network_fee_zats: 2 * cfg.REFUND_NETWORK_FEE_ZATS, // 0 on the first withdrawal of the day
      network_fees_micro_usd: payoutFee,
      min_micro_usd: cfg.MIN_WITHDRAWAL_MICRO_USD,
      min_micro_usd_for_free: cfg.FREE_FEE_MIN_MICRO_USD,
    },
    // False when the covered-fee budget is spent: first-of-day network fees are charged too.
    free_network_fees_available: budget >= Math.max(payoutFee, depFee),
  };
}
