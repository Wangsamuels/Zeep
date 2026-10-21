// Display units. Two balances: dollars (micro-USD, 1e-6 USD, like USDC) and ZEC (zats).
// Credits are how the app shows everything the user owns: dollars + ZEC at the live price,
// with micro_usd_per_credit from /v1/config (default 1,000,000 → 1 credit = $1, so a
// $0.0021 response shows as 0.0021 credits).
export const MICRO_PER_USD = 1_000_000;

export function microToCredits(micro: bigint | number, microPerCredit = 1_000_000): number {
  return Number(micro) / microPerCredit;
}

/** Up to 4 decimals, trailing zeros trimmed: "12.3456". */
export function formatCredits(micro: bigint | number, microPerCredit = 1_000_000): string {
  return microToCredits(micro, microPerCredit).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

export function formatUsd(micro: bigint | number): string {
  const v = Number(micro) / MICRO_PER_USD;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 });
}

export function creditsToMicro(credits: number, microPerCredit = 1_000_000): bigint {
  return BigInt(Math.round(credits * microPerCredit));
}

// ---- ZEC (deposits are made in ZEC; payouts arrive in ZEC) ----
export const ZATS_PER_ZEC = 100_000_000n;

export function formatZec(zats: bigint | number): string {
  const z = BigInt(zats);
  const whole = z / ZATS_PER_ZEC;
  const frac = (z % ZATS_PER_ZEC).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function parseZec(input: string): bigint {
  const t = input.trim();
  if (!/^\d+(\.\d{0,8})?$/.test(t)) throw new Error("Enter an amount in ZEC with up to 8 decimals.");
  const [w, f = ""] = t.split(".");
  return BigInt(w) * ZATS_PER_ZEC + BigInt((f + "00000000").slice(0, 8));
}

// Must match the server's arithmetic exactly (src/services/prices.ts, fees.ts).
export const zatsToMicroUsd = (zats: bigint | number, zecUsd: number): number => Math.floor((Number(zats) / 1e8) * zecUsd * 1e6);
export const bpsOf = (amount: number, bps: number): number => Math.ceil((amount * bps) / 10_000);

/** What a ZEC deposit will add (estimate before it confirms): the ZEC kept, and the dollars from the rest. */
export function estimateDeposit(zats: bigint, zecUsd: number, zecShareBps: number, feeBps: number): { zecZats: bigint; usdMicro: bigint; totalMicro: bigint } {
  const kept = (zats * BigInt(zecShareBps)) / 10_000n;
  const value = zatsToMicroUsd(zats - kept, zecUsd);
  const usd = BigInt(value - bpsOf(value, feeBps));
  return { zecZats: kept, usdMicro: usd, totalMicro: usd + BigInt(zatsToMicroUsd(kept, zecUsd)) };
}
