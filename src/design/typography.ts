/**
 * Arc 21 — typography.
 *
 * System fonts, for speed and correct platform rendering. No condensed "casino"
 * faces. Numeric displays (bankroll, bet, totals) use tabular figures so digits
 * do not jitter as values change.
 *
 * The scale itself lives in `type-metrics.ts` — sizes, weights and
 * `textTransform`, with no React Native import — so a plain Node test can
 * assert on it. This file is the only thing components import: it composes a
 * platform font family onto each metric.
 */

import { Platform, type TextStyle } from "react-native";

import { typeMetrics, type TypeFamily, type TypographyToken } from "./type-metrics";

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

function fontFamilyFor(family: TypeFamily): string | undefined {
  return family === "medium" ? systemFontMedium : systemFont;
}

export const typography = Object.fromEntries(
  Object.entries(typeMetrics).map(([token, { family, ...metric }]) => [
    token,
    { ...metric, fontFamily: fontFamilyFor(family) },
  ]),
) as Record<TypographyToken, TextStyle>;

export type { TypographyToken };

/**
 * Tabular figures for any number that updates in place. Without this, chip
 * counts visibly shift width as digits change, which reads as instability.
 */
export const tabularNumbers: TextStyle = {
  fontVariant: ["tabular-nums"],
};

// Re-exported from `format-chips.ts`, which has no React Native import, so a
// module that wants only chip formatting — not fonts — need not pull it in.
// See that file's own comment.
export { formatChipDelta, formatChips } from "./format-chips";
