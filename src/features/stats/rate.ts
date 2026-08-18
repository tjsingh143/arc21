/**
 * Arc 21 — rates, samples, and the rules for showing a percentage honestly.
 *
 * Three failure modes this module exists to prevent:
 *
 * 1. **A percentage from a zero denominator.** `0/0` is not `0%`. It means
 *    "nothing has happened yet", and rendering it as `0%` tells a player who has
 *    not made a single decision that they got everything wrong. A `Rate` with no
 *    denominator carries `value: null`, and the formatter renders a dash.
 *
 * 2. **A percentage detached from its sample.** "100% accuracy" after three
 *    decisions is noise. A `Rate` therefore always carries the counts it was
 *    computed from, so no caller can render the percentage without being able to
 *    render the sample size beside it.
 *
 * 3. **Impossible percentages from corrupt storage.** Practice statistics are
 *    restored from disk and validated only as numbers, so a damaged blob could
 *    claim more correct decisions than decisions. That is clamped here rather
 *    than rendered as "140% accurate".
 *
 * Runtime-neutral: no React, React Native or Expo imports, so the aggregation
 * layer above it is testable in a plain Node process.
 */

export interface Rate {
  /** Successes, clamped to `[0, denominator]`. */
  readonly numerator: number;
  /** Attempts, clamped to `>= 0`. */
  readonly denominator: number;
  /** Fraction in `[0, 1]`, or **null** when there is nothing to divide. */
  readonly value: number | null;
}

/** The rate of something that has never been attempted. Not zero — unknown. */
export const NO_RATE: Rate = { numerator: 0, denominator: 0, value: null };

/**
 * Builds a rate, guarding the denominator and any non-finite input.
 *
 * Negative or fractional counters cannot arise from the store, but they can
 * arise from a corrupt save, so they are normalised rather than trusted.
 */
export function rate(numerator: number, denominator: number): Rate {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return NO_RATE;

  const attempts = Math.max(0, Math.trunc(denominator));
  if (attempts === 0) return NO_RATE;

  const successes = Math.min(attempts, Math.max(0, Math.trunc(numerator)));
  return { numerator: successes, denominator: attempts, value: successes / attempts };
}

/** Percentage in `[0, 100]`, or null when the rate has no denominator. */
export function percentValue(input: Rate): number | null {
  return input.value === null ? null : input.value * 100;
}

/**
 * Renders a rate as a whole-number percentage, or `placeholder` when there is
 * no sample. Never rounds an unknown into a number.
 */
export function formatPercent(input: Rate, placeholder = "—"): string {
  const percent = percentValue(input);
  return percent === null ? placeholder : `${Math.round(percent)}%`;
}

/**
 * How much weight a sample can bear.
 *
 * These are presentation thresholds, not statistics: they decide how loudly the
 * UI qualifies a number, and nothing else depends on them. Blackjack basic
 * strategy has roughly 300 distinct decision cells, so a few dozen decisions
 * genuinely cannot characterise a player.
 */
export type SampleStrength = "empty" | "thin" | "moderate" | "solid";

export const SAMPLE_THRESHOLDS = { moderate: 30, solid: 200 } as const;

export function sampleStrength(count: number): SampleStrength {
  if (!Number.isFinite(count) || count <= 0) return "empty";
  if (count < SAMPLE_THRESHOLDS.moderate) return "thin";
  if (count < SAMPLE_THRESHOLDS.solid) return "moderate";
  return "solid";
}

/**
 * A short caveat to sit under a percentage, or null when the sample speaks for
 * itself. Deliberately plain: it describes the sample, it does not scold.
 */
export function sampleCaveat(count: number): string | null {
  switch (sampleStrength(count)) {
    case "empty":
      return null;
    case "thin":
      return "Too few decisions to mean much yet.";
    case "moderate":
      return "Still a small sample.";
    case "solid":
      return null;
  }
}

/** e.g. `describeSample(1, "decision")` → "1 decision". */
export function describeSample(count: number, singular: string, plural = `${singular}s`): string {
  const safe = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return `${safe.toLocaleString("en-US")} ${safe === 1 ? singular : plural}`;
}

/** Division that answers "unknown" instead of `Infinity` or `NaN`. */
export function safeDivide(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator === 0) return null;
  return numerator / denominator;
}

/**
 * Two decimals with a true minus sign, or `placeholder` when unknown.
 *
 * Used for expected-value figures, which are fractions of a bet rather than
 * chips. Two decimals is the precision the solver's documented approximations
 * actually support.
 */
export function formatDecimal(value: number | null, placeholder = "—"): string {
  if (value === null || !Number.isFinite(value)) return placeholder;
  const rounded = Math.round(value * 100) / 100;
  const safe = Object.is(rounded, -0) ? 0 : rounded;
  return `${safe < 0 ? "−" : ""}${Math.abs(safe).toFixed(2)}`;
}
