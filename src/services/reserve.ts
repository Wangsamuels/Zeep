// The public reserve books. Two assets, each held against its own notes:
//
//   ZEC     owed  = ZEC notes + uncredited deposits + ZEC parts of withdrawals not yet sent
//           held  = the reserve wallet's ZEC
//   dollars owed  = dollar notes + credits of withdrawals still converting
//           held  = USDC.e on Tempo + USDC on Base + conversions in flight
//                   + ZEC in the wallet above what ZEC is owed (waiting to be converted)
//   profit  = service margin + conversion fees − covered fees − real conversion costs (micro-USD)
//
// ZEC owed is held as ZEC, so ZEC's price moves change what users' ZEC is worth but never
// the coverage. Dollars owed are held as dollars.
import { cfg } from '../config.js';
import { q } from '../lib/db.js';
import { bookTotals } from './books.js';
import { zatsToMicroUsd, zecQuotes } from './prices.js';

const ratio = (held: number, owed: number) => (owed === 0 ? 1_000_000 : Math.floor((held / owed) * 10_000));

export async function reserveBooks() {
  const sum = await bookTotals();
  const px = (await zecQuotes()).current.usd;
  const [cv] = await q<{ m: string; z: string }>(
    `SELECT COALESCE(SUM(convert_micro_usd),0) AS m, COALESCE(SUM(zec_zats),0) AS z FROM withdrawals WHERE status = 'converting'`);
  const [pz] = await q<{ z: string }>(
    `SELECT COALESCE(SUM(amount_zats),0) AS z FROM payouts WHERE kind = 'withdrawal' AND status IN ('scheduled','sending','stuck')`);
  const [pc] = await q<{ z: string }>(
    `SELECT COALESCE(SUM(amount_zats),0) AS z FROM payouts WHERE kind = 'conversion' AND status IN ('scheduled','sending','stuck')`);
  const [u] = await q<{ z: string }>(`SELECT COALESCE(SUM(amount_zats),0) AS z FROM deposits WHERE status IN ('unclaimed','confirmed')`);
  const [w] = await q<{ reserve_balance_zats: string | null; updated_at: Date }>('SELECT reserve_balance_zats, updated_at FROM wallet_state WHERE id = 1');
  const [f] = await q<{ tempo_usdc: string; base_usdc: string }>('SELECT tempo_usdc, base_usdc FROM float_state WHERE id = 1');
  const inflight = await q<{ direction: string; zec_zats: string | null; usdc_units: string | null }>(
    `SELECT direction, zec_zats, usdc_units FROM conversions WHERE step IN ('swapping','bridging','bridging_back','swapping_back')`);

  // ---- ZEC ----
  const zecNotes = Math.max(0, sum('zec_deposit') - sum('zec_to_usd') - sum('zec_withdrawal'));
  const zecOwed = zecNotes + Number(u.z) + Number(cv.z) + Number(pz.z);
  const zecWallet = w?.reserve_balance_zats == null ? null : Number(w.reserve_balance_zats);
  // ZEC already earmarked for a conversion send isn't available for ZEC notes.
  const zecHeld = zecWallet == null ? 0 : Math.max(0, zecWallet - Number(pc.z));
  const zecSurplus = Math.max(0, zecHeld - zecOwed);

  // ---- dollars ----
  const usdNotes = Math.max(0, sum('deposit') + sum('usd_from_zec') + sum('compensation') - sum('service') - sum('withdrawal'));
  const usdOwed = usdNotes + Number(cv.m);
  const inFlight = inflight.reduce((acc, c) =>
    acc + (c.direction === 'to_tempo' ? (c.usdc_units ? Number(c.usdc_units) : zatsToMicroUsd(Number(c.zec_zats ?? 0), px)) : Number(c.usdc_units ?? 0)), 0)
    + zatsToMicroUsd(Number(pc.z), px);
  const usdHeld = Number(f.tempo_usdc) + Number(f.base_usdc) + inFlight + zatsToMicroUsd(zecSurplus, px);

  const income = sum('margin') + sum('conversion_fee');
  const net = income - sum('subsidy') - sum('conversion_cost');
  // Dollar volume (what fees are charged on), same as the covered-fee budget in fees.ts.
  const volume = sum('service') + sum('deposit') + sum('usd_from_zec') + sum('withdrawal');
  const owedTotal = usdOwed + zatsToMicroUsd(zecOwed, px);
  const heldTotal = usdHeld + zatsToMicroUsd(Math.min(zecHeld, zecOwed), px);

  return {
    micro_usd_per_credit: cfg.MICRO_USD_PER_CREDIT,
    zec_usd: px,
    zec: {
      unit: 'zats',
      notes_zats: zecNotes,
      unconfirmed_deposits_zats: Number(u.z),
      pending_withdrawals_zats: Number(cv.z) + Number(pz.z),
      owed_zats: zecOwed,
      held_zats: zecWallet == null ? null : zecHeld,
      surplus_zats: zecSurplus, // dollar halves / refills waiting to be converted to USDC.e
      coverage_bps: ratio(zecHeld, zecOwed),
    },
    usd: {
      unit: 'micro_usd',
      notes_micro_usd: usdNotes,
      converting_withdrawals_micro_usd: Number(cv.m),
      owed_micro_usd: usdOwed,
      held: {
        tempo_usdc_micro_usd: Number(f.tempo_usdc),
        base_usdc_micro_usd: Number(f.base_usdc),
        in_flight_micro_usd: inFlight,
        zec_surplus_micro_usd: zatsToMicroUsd(zecSurplus, px),
        total_micro_usd: usdHeld,
      },
      coverage_bps: ratio(usdHeld, usdOwed),
    },
    // Everything in dollars at the live ZEC price.
    owed_micro_usd: owedTotal,
    owed_credits: owedTotal / cfg.MICRO_USD_PER_CREDIT,
    held_micro_usd: heldTotal,
    coverage_bps: ratio(heldTotal, owedTotal),
    coverage_pct: ratio(heldTotal, owedTotal) / 100,
    profit: {
      service_margin_micro_usd: sum('margin'),
      conversion_fees_micro_usd: sum('conversion_fee'),
      covered_fees_micro_usd: sum('subsidy'),
      conversion_costs_micro_usd: sum('conversion_cost'),
      net_micro_usd: net,
      net_bps_of_volume: volume ? Math.round((net / volume) * 10_000) : null,
    },
    totals: {
      usd_deposits_micro_usd: sum('deposit'),
      zec_deposits_zats: sum('zec_deposit'),
      refills_zats: sum('zec_to_usd'),
      refills_micro_usd: sum('usd_from_zec'),
      services_micro_usd: sum('service'),
      usd_withdrawals_micro_usd: sum('withdrawal'),
      zec_withdrawals_zats: sum('zec_withdrawal'),
      to_tempo_zats: sum('to_tempo_zats'),
      to_zec_zats: sum('to_zec_zats'),
    },
    wallet_updated_at: w?.updated_at?.toISOString() ?? null,
    as_of: new Date().toISOString(),
  };
}
