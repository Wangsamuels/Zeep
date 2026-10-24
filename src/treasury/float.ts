// The Tempo float. The reserve holds each asset against its own notes:
//
//   ZEC notes     kept as shielded ZEC in the reserve wallet (users carry ZEC's price moves).
//   dollar notes  held as USDC.e on Tempo; MPP providers are paid straight from it.
//
//   to_tempo  each tick, ZEC above what ZEC notes (and pending payouts) need — the dollar half
//             of new deposits and the ZEC of refills — is converted:
//             ZEC → NEAR Intents → USDC on Base → Relay → USDC.e on Tempo.
//   to_zec    a withdrawal that converts credits converts its own dollars back:
//             USDC.e → Relay → USDC on Base → NEAR Intents → ZEC (reserve t-address,
//             shielded automatically) → paid with the withdrawal's ZEC part in two tranches.
//
// Conversion costs are paid by the conversion fees; the books record each conversion's real
// cost next to the fee that paid for it.
import { cfg } from '../config.js';
import { q, tx, type Tx } from '../lib/db.js';
import { log } from '../lib/log.js';
import { addBooks, bookTotals } from '../services/books.js';
import { moneyQuote, zatsToMicroUsd, zecQuotes } from '../services/prices.js';
import { NotSent, rails } from './rails.js';

export interface FloatInputs {
  zecSpendable: bigint;
  pendingZecPayouts: bigint; // scheduled / sending ZEC payouts (withdrawal tranches, conversions)
  /** ZEC the reserve must keep: ZEC notes + ZEC halves of deposits not yet credited + ZEC parts of converting withdrawals. */
  zecOwed: bigint;
  inflightToTempo: boolean;
}

export type FloatAction = { action: 'none'; why: string } | { action: 'to_tempo'; zats: bigint };

/** Pure decision (unit-tested): convert the ZEC that no ZEC note needs, above the floor. */
export function decide(i: FloatInputs): FloatAction {
  if (i.inflightToTempo) return { action: 'none', why: 'a conversion to Tempo is already running' };
  // Leave room for the network fee of the send itself.
  const convertible = i.zecSpendable - i.pendingZecPayouts - i.zecOwed - BigInt(cfg.ZEC_FLOOR_ZATS) - 2n * BigInt(cfg.REFUND_NETWORK_FEE_ZATS);
  if (convertible < BigInt(cfg.CONVERSION_MIN_ZATS)) return { action: 'none', why: 'not enough ZEC to convert' };
  return { action: 'to_tempo', zats: convertible };
}

/** One float tick: convert new deposits, start conversions for new withdrawals, advance all. */
export async function floatTick(): Promise<FloatAction> {
  if (cfg.FLOAT_MODE !== 'auto') return { action: 'none', why: 'FLOAT_MODE=off' };
  const r = rails();
  const { tempoUsdc, baseUsdc } = await r.balances();
  await q('UPDATE float_state SET tempo_usdc = $1, base_usdc = $2, updated_at = now() WHERE id = 1', [tempoUsdc.toString(), baseUsdc.toString()]);
  const px = (await zecQuotes()).current.usd;

  const [w] = await q<{ s: string | null }>('SELECT reserve_spendable_zats AS s FROM wallet_state WHERE id = 1');
  // 'stuck' payouts may still need their ZEC: never convert it away.
  const [p] = await q<{ z: string }>(`SELECT COALESCE(SUM(amount_zats),0) AS z FROM payouts WHERE status IN ('scheduled','sending','stuck')`);
  const open = await q<{ direction: string }>(`SELECT direction FROM conversions WHERE step NOT IN ('done','failed')`);
  const a = decide({ zecSpendable: BigInt(w.s ?? 0), pendingZecPayouts: BigInt(p.z), zecOwed: BigInt(await zecOwedZats()), inflightToTempo: open.some((o) => o.direction === 'to_tempo') });
  if (a.action === 'to_tempo') {
    const px = (await moneyQuote().catch(() => null))?.usd; // books the conversion at a live price
    if (px === undefined) return { action: 'none', why: 'no live ZEC price' };
    const { depositAddress } = await r.quoteZecToBase(a.zats);
    await tx(async (c) => {
      const pay = await c.query<{ id: string }>(
        `INSERT INTO payouts (kind, dest_address, amount_zats, scheduled_at) VALUES ('conversion', $1, $2, now()) RETURNING id`,
        [depositAddress, a.zats.toString()]);
      await c.query(
        `INSERT INTO conversions (direction, reason, step, zec_zats, zec_usd, oneclick_deposit, payout_id)
         VALUES ('to_tempo', 'surplus', 'zec_sending', $1, $2, $3, $4)`,
        [a.zats.toString(), px, depositAddress, pay.rows[0].id]);
    });
    log.info({ zats: a.zats.toString() }, 'float: converting surplus ZEC → USDC.e');
  }

  // Each withdrawal waiting for ZEC gets its own conversion back. One attempt only: a
  // conversion that fails or stops halfway is left for a human (never re-bridged blindly).
  const waiting = await q<{ id: string; convert_micro_usd: string }>(
    `SELECT w.id, w.convert_micro_usd FROM withdrawals w
      WHERE w.status = 'converting' AND NOT EXISTS (SELECT 1 FROM conversions c WHERE c.withdrawal_id = w.id)
      ORDER BY w.created_at LIMIT 20`);
  for (const wd of waiting) {
    const usdc = BigInt(wd.convert_micro_usd); // USDC has 6 decimals: 1 unit = 1 micro-USD
    if (usdc > tempoUsdc) {
      log.error({ withdrawal: wd.id }, 'ALERT Tempo float too small for a withdrawal; top up USDC.e');
      continue;
    }
    // Record the intent BEFORE moving money, so a crash mid-bridge can't cause a second bridge.
    const [row] = await q<{ id: string }>(
      `INSERT INTO conversions (direction, reason, step, usdc_units, zec_usd, withdrawal_id)
       VALUES ('to_zec', 'withdrawal', 'bridge_back_starting', $1, $2, $3) RETURNING id`,
      [usdc.toString(), px, wd.id]);
    let b: Awaited<ReturnType<typeof r.bridge>>;
    try {
      b = await r.bridge('tempo_to_base', usdc);
    } catch (e) {
      if (e instanceof NotSent) {
        await q('DELETE FROM conversions WHERE id = $1', [row.id]); // nothing moved: retry next tick
        log.warn({ withdrawal: wd.id, err: e.message }, 'bridge quote failed; will retry');
        continue;
      }
      // Unknown outcome: the row stays "in flight" and is flagged for review, never re-bridged.
      log.error({ withdrawal: wd.id, err: (e as Error).message }, 'bridge back failed after sending may have started');
      continue;
    }
    await q(`UPDATE conversions SET step = 'bridging_back', relay_request = $2, usdc_out = $3, updated_at = now() WHERE id = $1`,
      [row.id, b.requestId, b.amountOut.toString()]);
    log.info({ withdrawal: wd.id }, 'float: converting USDC.e → ZEC for a withdrawal');
  }

  await advance();
  return a;
}

/** Steps that move money before they record the result. Found open on a later tick = interrupted. */
const IN_FLIGHT = new Set(['bridge_back_starting', 'paying_base', 'bridge_starting']);

async function advance(): Promise<void> {
  const r = rails();
  const open = await q<{
    id: string; direction: string; step: string; zec_zats: string | null; usdc_units: string | null; usdc_out: string | null;
    zec_usd: string; oneclick_deposit: string | null; payout_id: string | null; relay_request: string | null;
    withdrawal_id: string | null; updated_at: Date;
  }>(`SELECT * FROM conversions WHERE step NOT IN ('done','failed') ORDER BY id`);
  for (const c of open) {
    try {
      const set = (step: string, extra = '', params: unknown[] = []) =>
        q(`UPDATE conversions SET step = $2${extra}, updated_at = now() WHERE id = $1`, [c.id, step, ...params]);
      const px = Number(c.zec_usd);
      if (IN_FLIGHT.has(c.step)) {
        // The process stopped (or an RPC timed out) between sending money and recording it.
        // Retrying could pay twice, so stop and ask for a manual check.
        if (Date.now() - c.updated_at.getTime() > 10 * 60_000) {
          await set('failed', ', error = $3', [`interrupted at ${c.step}; check the EVM wallet and Relay/1Click by hand`]);
          log.error({ conversion: c.id, step: c.step, withdrawal: c.withdrawal_id }, 'ALERT conversion interrupted mid-payment; manual review');
        }
        continue;
      }
      if (c.direction === 'to_tempo') {
        if (c.step === 'zec_sending') {
          const [p] = await q<{ status: string }>('SELECT status FROM payouts WHERE id = $1', [c.payout_id]);
          if (p.status === 'sent' || p.status === 'confirmed') await set('swapping');
          else if (p.status === 'failed') await set('failed', ', error = $3', ['ZEC send failed']);
        } else if (c.step === 'swapping') {
          const s = await r.swapStatus(c.oneclick_deposit!);
          if (s.status === 'success') {
            await set('bridge_starting', ', usdc_units = $3', [s.amountOut!.toString()]);
            const b = await r.bridge('base_to_tempo', s.amountOut!).catch(async (e) => {
              if (e instanceof NotSent) await set('swapping'); // nothing moved: retry next tick
              throw e;
            });
            await set('bridging', ', relay_request = $3, usdc_out = $4', [b.requestId, b.amountOut.toString()]);
          } else if (s.status === 'failed') await set('failed', ', error = $3', ['swap refunded; ZEC returns to the reserve t-address']);
        } else if (c.step === 'bridging') {
          const s = await r.bridgeStatus(c.relay_request!);
          if (s === 'success') {
            await tx(async (db) => {
              await db.query(`UPDATE conversions SET step = 'done', updated_at = now() WHERE id = $1`, [c.id]);
              await addBooks(db, 'to_tempo_zats', BigInt(c.zec_zats!));
              // Zeep's real cost: ZEC's value going in minus the USDC.e that arrived on Tempo.
              const cost = zatsToMicroUsd(Number(c.zec_zats), px) - Number(c.usdc_out ?? c.usdc_units);
              if (cost > 0) await addBooks(db, 'conversion_cost', cost);
            });
            log.info({ conversion: c.id }, 'surplus ZEC now held as USDC.e on Tempo');
          } else if (s === 'failed') await set('failed', ', error = $3', ['bridge to Tempo failed; USDC stays on Base']);
        }
      } else {
        if (c.step === 'bridging_back') {
          const s = await r.bridgeStatus(c.relay_request!);
          if (s === 'success') {
            // Pay what actually arrived on Base (exact-input bridge minus Relay's fee), never more.
            const quoted = BigInt(c.usdc_out ?? '0');
            if (quoted <= 0n) throw new Error('unknown bridged amount');
            // If Relay delivered a little less than quoted, pay what is there (within 1%);
            // otherwise wait — never dip into USDC that belongs to another conversion.
            // Base USDC is shared: leave what other bridged-back conversions are owed untouched.
            const { baseUsdc } = await r.balances();
            const [o] = await q<{ s: string }>(
              `SELECT COALESCE(SUM(usdc_out),0) AS s FROM conversions WHERE direction = 'to_zec' AND step = 'bridging_back' AND id <> $1`, [c.id]);
            const available = baseUsdc - BigInt(o.s);
            if (available * 100n < quoted * 99n) {
              if (Date.now() - c.updated_at.getTime() > 60 * 60_000) {
                await set('failed', ', error = $3', ['bridged USDC never showed up on Base; check Relay by hand']);
                log.error({ conversion: c.id, withdrawal: c.withdrawal_id }, 'ALERT bridge back delivered too little; manual review');
                continue;
              }
              throw new Error('bridged USDC not on Base yet');
            }
            const arrived = available < quoted ? available : quoted;
            const { depositAddress } = await r.quoteBaseToZec(arrived);
            await set('paying_base', ', oneclick_deposit = $3, usdc_out = $4', [depositAddress, arrived.toString()]);
            await r.payBaseUsdc(depositAddress, arrived);
            await set('swapping_back');
          } else if (s === 'failed') await set('failed', ', error = $3', ['bridge back failed; USDC.e stays on Tempo']);
        } else if (c.step === 'swapping_back') {
          const s = await r.swapStatus(c.oneclick_deposit!);
          if (s.status === 'success') {
            const received = Number(s.amountOut!);
            await tx(async (db) => {
              await db.query(`UPDATE conversions SET step = 'done', zec_zats = $2, updated_at = now() WHERE id = $1`, [c.id, received]);
              await addBooks(db, 'to_zec_zats', received);
              // The user receives whatever this conversion produced, so its slippage is theirs,
              // not a treasury cost (their 1.5% conversion fee is the treasury's income).
              if (c.withdrawal_id) {
                const [wd] = (await db.query<{ zec_zats: string; network_fee_zats: string }>(
                  'SELECT zec_zats, network_fee_zats FROM withdrawals WHERE id = $1', [c.withdrawal_id])).rows;
                await scheduleTranches(db, c.withdrawal_id, Number(wd.zec_zats) - Number(wd.network_fee_zats) + received, received);
              }
            });
            log.info({ conversion: c.id }, 'ZEC back for a withdrawal; tranches scheduled');
          } else if (s.status === 'failed') {
            await set('failed', ', error = $3', ['swap back refunded; USDC returns to Base']);
            log.error({ conversion: c.id, withdrawal: c.withdrawal_id }, 'ALERT withdrawal conversion refunded; finish it by hand');
          }
        }
      }
    } catch (e) {
      log.warn({ conversion: c.id, err: (e as Error).message }, 'conversion step failed; will retry');
    }
  }
}

/**
 * ZEC owed to ZEC notes, which the float must not convert: what the notes hold, the ZEC
 * halves of confirmed deposits the activator hasn't credited yet, and the ZEC parts of
 * withdrawals still converting their credits (their tranches aren't scheduled yet).
 */
export async function zecOwedZats(): Promise<number> {
  const sum = await bookTotals();
  const [u] = await q<{ z: string }>(`SELECT COALESCE(SUM(amount_zats),0) AS z FROM deposits WHERE status IN ('confirmed','unclaimed')`);
  // Deposits still confirming are in the wallet too (and may be spendable); they are owed as well.
  const [s] = await q<{ z: string }>(
    `SELECT COALESCE(SUM(s.amount_zats),0) AS z FROM deposit_sightings s
      WHERE NOT EXISTS (SELECT 1 FROM deposits d WHERE d.txid_hash = s.txid_hash)`);
  const [w] = await q<{ z: string }>(`SELECT COALESCE(SUM(zec_zats),0) AS z FROM withdrawals WHERE status = 'converting'`);
  const notes = sum('zec_deposit') - sum('zec_to_usd') - sum('zec_withdrawal');
  return Math.max(0, notes) + Number(u.z) + Number(s.z) + Number(w.z);
}

/**
 * Pay a withdrawal in two tranches. `payableZats` already has the user's network fees taken
 * out (or Zeep pays them). `receivedZats`: ZEC the credit conversion produced, if any.
 */
export async function scheduleTranches(db: Pick<Tx, 'query'>, withdrawalId: string, payableZats: number, receivedZats: number | null) {
  if (payableZats < 2) {
    await db.query(`UPDATE withdrawals SET status = 'failed', zec_received = $2 WHERE id = $1`, [withdrawalId, receivedZats]);
    log.error({ withdrawal: withdrawalId }, 'ALERT withdrawal too small after conversion; manual review');
    return;
  }
  // Split around REFUND_SPLIT_BPS with ±10% jitter, so the two tranches aren't exact halves
  // that are easy to pair up on-chain.
  const splitBps = cfg.REFUND_SPLIT_BPS + Math.floor((Math.random() * 2 - 1) * 1000);
  const t1 = Math.min(payableZats - 1, Math.max(1, Math.floor((payableZats * splitBps) / 10_000)));
  const jitter = () => Math.floor(Math.random() * (cfg.REFUND_JITTER_SEC + 1));
  await db.query(
    `INSERT INTO payouts (kind, withdrawal_id, tranche, amount_zats, scheduled_at) VALUES
       ('withdrawal', $1, 1, $2, now() + make_interval(secs => $4)),
       ('withdrawal', $1, 2, $3, now() + make_interval(secs => $5))`,
    [withdrawalId, t1, payableZats - t1, jitter(), cfg.TRANCHE_GAP_SEC + jitter()]);
  await db.query(`UPDATE withdrawals SET status = 'scheduled', zec_received = $2 WHERE id = $1`, [withdrawalId, receivedZats]);
}
