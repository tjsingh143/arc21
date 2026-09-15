/**
 * The "Larger table text" type scale-up, kept apart from
 * `src/design/accessibility.tsx` so it can be imported by a plain Node test —
 * that file imports React and the settings store, which drag in React Native.
 *
 * Same split, and same reason, as `format-chips.ts`.
 */

import type { TypographyToken } from "./type-metrics";

/**
 * One step up the type scale, for the table's totals and seat/dealer labels.
 * Capped at `pageTitle` so a total never grows past the screen title itself.
 *
 * `overline` maps to `overlineLarge` and NOT to `caption`: caption has no
 * `textTransform`, so that mapping grew the text and silently rendered
 * "DEALER" as "Dealer" — a change to the rendered string rather than its size.
 * `tests/design/type-scale.test.ts` asserts no mapping may alter a token's
 * `textTransform`.
 */
export const TABLE_TEXT_SCALE_UP: Readonly<Record<TypographyToken, TypographyToken>> = {
  overline: "overlineLarge",
  overlineLarge: "overlineLarge",
  caption: "body",
  body: "bodyStrong",
  bodyStrong: "sectionTitle",
  sectionTitle: "pageTitle",
  pageTitle: "pageTitle",
  display: "display",
};
