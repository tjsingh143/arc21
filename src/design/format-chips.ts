/**
 * Chip-amount formatting, split out of `typography.ts` so it can be imported
 * without pulling in React Native.
 *
 * `typography.ts` imports `Platform` for its font selection, which has no
 * meaningful behaviour under Node and fails to even parse there (RN ships
 * Flow syntax). A module that only wants `formatChips` — like
 * `outcome-announcement.ts`, built to be unit-testable without a device —
 * must not import anything that drags `react-native` in as a side effect.
 * `typography.ts` re-exports both functions, so existing imports from there
 * are unaffected.
 */

/** Formats a chip amount with thousands separators, e.g. 25000 → "25,000". */
export function formatChips(amount: number): string {
  return Math.trunc(amount).toLocaleString("en-US");
}

/** Signed delta for result overlays, e.g. +150 / −100. Uses a true minus sign. */
export function formatChipDelta(amount: number): string {
  if (amount === 0) return "0";
  const sign = amount > 0 ? "+" : "−";
  return `${sign}${formatChips(Math.abs(amount))}`;
}
