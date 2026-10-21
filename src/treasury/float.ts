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
import { zatsToMicroUsd, zecQuotes } from '../services/prices.js';
import { rails } from './rails.js';

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
  const [p] = await q<{ z: string }>(`SELECT COALESCE(SUM(amount_zats),0) AS z FROM payouts WHERE status IN ('scheduled','sending')`);
  const open = await q<{ direction: string }>(`SELECT direction FROM conversions WHERE step NOT IN ('done','failed')`);
  const a = decide({ zecSpendable: BigInt(w.s ?? 0), pendingZecPayouts: BigInt(p.z), zecOwed: BigInt(await zecOwedZats()), inflightToTempo: open.some((o) => o.direction === 'to_tempo') });
  if (a.action === 'to_tempo') {
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

  // Each withdrawal waiting for ZEC gets its own conversion back.
  const waiting = await q<{ id: string; convert_micro_usd: string }>(
    `SELECT w.id, w.convert_micro_usd FROM withdrawals w
      WHERE w.status = 'converting' AND NOT EXISTS (SELECT 1 FROM conversions c WHERE c.withdrawal_id = w.id AND c.step <> 'failed')
      ORDER BY w.created_at LIMIT 20`);
  for (const wd of waiting) {
    const usdc = BigInt(wd.convert_micro_usd); // USDC has 6 decimals: 1 unit = 1 micro-USD
    if (usdc > tempoUsdc) {
      log.error({ withdrawal: wd.id }, 'ALERT Tempo float too small for a withdrawal; top up USDC.e');
      continue;
    }
    const req = await r.bridge('tempo_to_base', usdc);
    await q(
      `INSERT INTO conversions (direction, reason, step, usdc_units, zec_usd, relay_request, withdrawal_id)
       VALUES ('to_zec', 'withdrawal', 'bridging_back', $1, $2, $3, $4)`,
      [usdc.toString(), px, req, wd.id]);
    log.info({ withdrawal: wd.id }, 'float: converting USDC.e → ZEC for a withdrawal');
  }

  await advance();
  return a;
}

async function advance(): Promise<void> {
  const r = rails();
  const open = await q<{
    id: string; direction: string; step: string; zec_zats: string | null; usdc_units: string | null; zec_usd: string;
    oneclick_deposit: string | null; payout_id: string | null; relay_request: string | null; withdrawal_id: string | null;
  }>(`SELECT * FROM conversions WHERE step NOT IN ('done','failed') ORDER BY id`);
  for (const c of open) {
    try {
      const set = (step: string, extra = '', params: unknown[] = []) =>
        q(`UPDATE conversions SET step = $2${extra}, updated_at = now() WHERE id = $1`, [c.id, step, ...params]);
      const px = Number(c.zec_usd);
      if (c.direction === 'to_tempo') {
        if (c.step === 'zec_sending') {
          const [p] = await q<{ status: string }>('SELECT status FROM payouts WHERE id = $1', [c.payout_id]);
          if (p.status === 'sent' || p.status === 'confirmed') await set('swapping');
          else if (p.status === 'failed') await set('failed', ', error = $3', ['ZEC send failed']);
        } else if (c.step === 'swapping') {
          const s = await r.swapStatus(c.oneclick_deposit!);
          if (s.status === 'success') {
            const req = await r.bridge('base_to_tempo', s.amountOut!);
            await set('bridging', ', usdc_units = $3, relay_request = $4', [s.amountOut!.toString(), req]);
          } else if (s.status === 'failed') await set('failed', ', error = $3', ['swap refunded; ZEC returns to the reserve t-address']);
        } else if (c.step === 'bridging') {
          const s = await r.bridgeStatus(c.relay_request!);
          if (s === 'success') {
            await tx(async (db) => {
              await db.query(`UPDATE conversions SET step = 'done', updated_at = now() WHERE id = $1`, [c.id]);
              await addBooks(db, 'to_tempo_zats', BigInt(c.zec_zats!));
              const cost = zatsToMicroUsd(Number(c.zec_zats), px) - Number(c.usdc_units);
              if (cost > 0) await addBooks(db, 'conversion_cost', cost);
            });
            log.info({ conversion: c.id }, 'deposits now held as USDC.e on Tempo');
          } else if (s === 'failed') await set('failed', ', error = $3', ['bridge to Tempo failed; USDC stays on Base']);
        }
      } else {
        if (c.step === 'bridging_back') {
          const s = await r.bridgeStatus(c.relay_request!);
          if (s === 'success') {
            const { depositAddress } = await r.quoteBaseToZec(BigInt(c.usdc_units!));
            await r.payBaseUsdc(depositAddress, BigInt(c.usdc_units!));
            await set('swapping_back', ', oneclick_deposit = $3', [depositAddress]);
          } else if (s === 'failed') await set('failed', ', error = $3', ['bridge back failed; USDC.e stays on Tempo']);
        } else if (c.step === 'swapping_back') {
          const s = await r.swapStatus(c.oneclick_deposit!);
          if (s.status === 'success') {
            const received = Number(s.amountOut!);
            await tx(async (db) => {
              await db.query(`UPDATE conversions SET step = 'done', zec_zats = $2, updated_at = now() WHERE id = $1`, [c.id, received]);
              await addBooks(db, 'to_zec_zats', received);
              const cost = Number(c.usdc_units) - zatsToMicroUsd(received, px);
              if (cost > 0) await addBooks(db, 'conversion_cost', cost);
              if (c.withdrawal_id) {
                const [wd] = (await db.query<{ zec_zats: string; network_fee_zats: string }>(
                  'SELECT zec_zats, network_fee_zats FROM withdrawals WHERE id = $1', [c.withdrawal_id])).rows;
                await scheduleTranches(db, c.withdrawal_id, Number(wd.zec_zats) - Number(wd.network_fee_zats) + received, received);
              }
            });
            log.info({ conversion: c.id }, 'ZEC back for a withdrawal; tranches scheduled');
          } else if (s.status === 'failed') await set('failed', ', error = $3', ['swap back refunded; USDC returns to Base']);
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
  const [w] = await q<{ z: string }>(`SELECT COALESCE(SUM(zec_zats),0) AS z FROM withdrawals WHERE status = 'converting'`);
  const notes = sum('zec_deposit') - sum('zec_to_usd') - sum('zec_withdrawal');
  return Math.max(0, notes) + Number(u.z) + Number(w.z);
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
  const t1 = Math.floor((payableZats * cfg.REFUND_SPLIT_BPS) / 10_000);
  const jitter = () => Math.floor(Math.random() * (cfg.REFUND_JITTER_SEC + 1));
  await db.query(
    `INSERT INTO payouts (kind, withdrawal_id, tranche, amount_zats, scheduled_at) VALUES
       ('withdrawal', $1, 1, $2, now() + make_interval(secs => $4)),
       ('withdrawal', $1, 2, $3, now() + make_interval(secs => $5))`,
    [withdrawalId, t1, payableZats - t1, jitter(), cfg.TRANCHE_GAP_SEC + jitter()]);
  await db.query(`UPDATE withdrawals SET status = 'scheduled', zec_received = $2 WHERE id = $1`, [withdrawalId, receivedZats]);
}
