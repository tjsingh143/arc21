/**
 * Arc 21 — the type scale, without the font families.
 *
 * Split from `typography.ts` for the same reason `format-chips.ts` is split
 * from it: that file calls `Platform.select` at module load, which drags React
 * Native in and cannot be imported by a plain Node test. The metrics — sizes,
 * weights, letter spacing, and crucially `textTransform` — are the part worth
 * asserting on, so they live here where a test can reach them.
 *
 * `typography.ts` composes a `fontFamily` onto each of these and is still the
 * only thing components import.
 */

/** Which system face a token uses. Resolved to a platform family in typography.ts. */
export type TypeFamily = "regular" | "medium";

export interface TypeMetric {
  family: TypeFamily;
  fontSize: number;
  lineHeight: number;
  fontWeight: "400" | "600";
  letterSpacing?: number;
  textTransform?: "uppercase";
}

export const typeMetrics = {
  display: { family: "medium", fontSize: 30, lineHeight: 36, fontWeight: "600", letterSpacing: -0.4 },
  pageTitle: { family: "medium", fontSize: 26, lineHeight: 32, fontWeight: "600", letterSpacing: -0.3 },
  sectionTitle: { family: "medium", fontSize: 19, lineHeight: 24, fontWeight: "600" },
  body: { family: "regular", fontSize: 16, lineHeight: 22, fontWeight: "400" },
  bodyStrong: { family: "medium", fontSize: 16, lineHeight: 22, fontWeight: "600" },
  caption: { family: "regular", fontSize: 13, lineHeight: 18, fontWeight: "400" },
  /** Small all-caps label. Always pair with an accessible full-text label. */
  overline: {
    family: "medium",
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  /**
   * `overline` one step up, for "Larger table text".
   *
   * It exists rather than mapping overline→caption because caption has no
   * `textTransform`: that mapping grew the text and silently rendered "DEALER"
   * as "Dealer" — a change to the RENDERED STRING, not just its size. Maestro
   * matches text case-sensitively against what is rendered, so a flow
   * asserting on an uppercase label would have begun failing for anyone with
   * the setting on. `tests/design/type-scale.test.ts` pins this.
   */
  overlineLarge: {
    family: "medium",
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "600",
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
} as const satisfies Record<string, TypeMetric>;

export type TypographyToken = keyof typeof typeMetrics;

/**
 * Upper bound on Dynamic Type scaling for text in a FIXED-GEOMETRY control —
 * an action button, a three-column table header — passed as React Native's
 * `maxFontSizeMultiplier`.
 *
 * Body copy is never capped: it reflows, so it should scale all the way. This
 * is only for text whose container cannot grow without destroying the layout
 * around it. At iOS's largest accessibility size (~310%) the uncapped action
 * dock truncated "Stand" to "Sta…", and raising `numberOfLines` then split it
 * across lines as "Stan / d" — both less legible than the same word one step
 * smaller. 1.6 is the largest multiplier at which "Surrender", the longest
 * label in the dock, still sets on one line at the dock's half-screen width.
 *
 * Measured on the simulator at `accessibility-extra-extra-extra-large`, not
 * chosen by eye from a spec.
 */
export const MAX_FIXED_CONTROL_FONT_SCALE = 1.6;

/**
 * The text scale at which iOS's own "accessibility sizes" begin, and therefore
 * the point above which a row of FIXED-COUNT controls should reflow onto more
 * rows instead of squeezing each one narrower.
 *
 * It lives here, on the React-Native-free side of the wall, because two
 * components need the same number: `ScreenHeader` stacks its title above the
 * balance, and `AssistanceModeSelector` goes from four pills across to two.
 * `CLAUDE.md` asks for a test whenever a constant is duplicated; sharing one
 * export is the version that cannot drift.
 *
 * Measured on the simulator at `accessibility-extra-extra-extra-large`, not
 * chosen from a table.
 */
export const STACK_ABOVE_FONT_SCALE = 1.5;

/**
 * Whether a fixed-count control row should reflow at this text scale.
 *
 * A predicate rather than a bare comparison at each call site, so the rule can
 * be asserted by a test that never imports React Native — the shape
 * `betting-affordance.ts` and `lobby-affordance.ts` already use.
 */
export function rowStacksAtFontScale(fontScale: number): boolean {
  return Number.isFinite(fontScale) && fontScale > STACK_ABOVE_FONT_SCALE;
}
