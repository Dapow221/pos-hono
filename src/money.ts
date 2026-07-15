/**
 * Money primitives.
 *
 * RULE: every monetary value in this system is an INTEGER in the smallest
 * currency unit (1 = Rp 1). We never store money in a floating-point number,
 * because `0.1 + 0.2 !== 0.3` in IEEE-754 — and a cashier system that loses a
 * rupiah on rounding loses the operator's trust. All percentage maths round
 * back to a whole rupiah explicitly, in one place, so rounding is predictable.
 */

/** A whole-rupiah amount. Kept as a plain number, but always an integer. */
export type Rupiah = number;

/** Tax rate applied at checkout (Indonesian PPN). */
export const TAX_RATE_PERCENT = 11;

/** Final totals are rounded to the nearest Rp 100 ("pembulatan"). */
export const ROUNDING_STEP = 100;

/** Apply a percentage (0–100) to an integer amount, rounding to a whole rupiah. */
export function percentageOf(amount: Rupiah, percent: number): Rupiah {
  return Math.round((amount * percent) / 100);
}

/** Clamp a percentage into the valid 0–100 range so a bad discount can't go negative. */
export function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

/**
 * Round an amount to the nearest `step` rupiah. Used for the final grand total
 * so the cashier never has to make change in coins smaller than Rp 100.
 */
export function roundToNearest(amount: Rupiah, step: number): Rupiah {
  if (step <= 1) return amount;
  return Math.round(amount / step) * step;
}
