/**
 * Arc 21 — typography.
 *
 * System fonts, for speed and correct platform rendering. No condensed "casino"
 * faces. Numeric displays (bankroll, bet, totals) use tabular figures so digits
 * do not jitter as values change.
 */

import { Platform, type TextStyle } from "react-native";

const systemFont = Platform.select({
  ios: "System",
  android: "sans-serif",
  default: "System",
});

const systemFontMedium = Platform.select({
  ios: "System",
  android: "sans-serif-medium",
  default: "System",
});

export const typography = {
  display: {
    fontFamily: systemFontMedium,
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "600",
    letterSpacing: -0.4,
  },
  pageTitle: {
    fontFamily: systemFontMedium,
    fontSize: 26,
    lineHeight: 32,
    fontWeight: "600",
    letterSpacing: -0.3,
  },
  sectionTitle: {
    fontFamily: systemFontMedium,
    fontSize: 19,
    lineHeight: 24,
    fontWeight: "600",
  },
  body: {
    fontFamily: systemFont,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "400",
  },
  bodyStrong: {
    fontFamily: systemFontMedium,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "600",
  },
  caption: {
    fontFamily: systemFont,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "400",
  },
  /** Small all-caps label. Always pair with an accessible full-text label. */
  overline: {
    fontFamily: systemFontMedium,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
} satisfies Record<string, TextStyle>;

export type TypographyToken = keyof typeof typography;

/**
 * Tabular figures for any number that updates in place. Without this, chip
 * counts visibly shift width as digits change, which reads as instability.
 */
export const tabularNumbers: TextStyle = {
  fontVariant: ["tabular-nums"],
};

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
