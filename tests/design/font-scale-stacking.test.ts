/**
 * A fixed-count control row at an accessibility text size.
 *
 * There is no React Testing Library in this project — `src/design/typography.ts`
 * calls `Platform.select` at module load, which is the wall `type-metrics.ts`
 * exists to put plain constants on the near side of. So the predicate is tested
 * directly and the SHAPE of the two call sites is tested by reading them, which
 * is what `19_rate_limits.test.sql` does to function bodies and
 * `every-command-has-a-caller.test.ts` does to the client.
 *
 * The defect being pinned was found by LOOKING at a rendered screen at
 * `accessibility-extra-extra-extra-large`: the four assistance pills were
 * `flex: 1`, so each got a quarter of the screen, and their labels broke
 * mid-word and were drawn OUTSIDE the pill outlines — "Lear/n", "Anal/ysis",
 * "Chal/leng/e". A view does not clip by default and `alignItems: "center"`
 * leaves a child at its intrinsic width, so nothing anywhere reported an error.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MAX_FIXED_CONTROL_FONT_SCALE,
  rowStacksAtFontScale,
  STACK_ABOVE_FONT_SCALE,
} from "../../src/design/type-metrics";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const SELECTOR = read("../../src/components/table/StrategyPanel.tsx");
const HEADER = read("../../src/components/ui/ScreenHeader.tsx");

/**
 * iOS's own multipliers for the content size categories, in order. The
 * threshold's whole claim is that it separates the ordinary sizes from the
 * accessibility ones, so the boundary is asserted against the real values
 * rather than against numbers either side of it.
 */
const IOS_FONT_SCALES = {
  large: 1.0,
  extraLarge: 1.12,
  extraExtraLarge: 1.23,
  extraExtraExtraLarge: 1.35,
  accessibilityMedium: 1.6,
  accessibilityLarge: 1.9,
  accessibilityExtraLarge: 2.35,
  accessibilityExtraExtraLarge: 2.76,
  accessibilityExtraExtraExtraLarge: 3.12,
} as const;

describe("rowStacksAtFontScale", () => {
  it("does not reflow at any ordinary content size", () => {
    for (const size of ["large", "extraLarge", "extraExtraLarge", "extraExtraExtraLarge"] as const) {
      expect(rowStacksAtFontScale(IOS_FONT_SCALES[size]), size).toBe(false);
    }
  });

  it("reflows at every one of iOS's accessibility sizes", () => {
    for (const size of [
      "accessibilityMedium",
      "accessibilityLarge",
      "accessibilityExtraLarge",
      "accessibilityExtraExtraLarge",
      "accessibilityExtraExtraExtraLarge",
    ] as const) {
      expect(rowStacksAtFontScale(IOS_FONT_SCALES[size]), size).toBe(true);
    }
  });

  it("sits between the largest ordinary size and the smallest accessibility one", () => {
    expect(STACK_ABOVE_FONT_SCALE).toBeGreaterThan(IOS_FONT_SCALES.extraExtraExtraLarge);
    expect(STACK_ABOVE_FONT_SCALE).toBeLessThan(IOS_FONT_SCALES.accessibilityMedium);
  });

  it("treats a missing or nonsense scale as no reflow, never as a crash", () => {
    // `useWindowDimensions().fontScale` is a number on both platforms, but a
    // component rendered by a test double or an older runtime can hand over
    // undefined. The layout that ships to everybody is the one to fall back to.
    expect(rowStacksAtFontScale(Number.NaN)).toBe(false);
    expect(rowStacksAtFontScale(undefined as unknown as number)).toBe(false);
    expect(rowStacksAtFontScale(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("the assistance mode selector's geometry", () => {
  it("gives its pills a flex BASIS, because a basis of 0 can never wrap", () => {
    /*
     * `app/profile/index.tsx` writes this down at length: `flexWrap` does
     * nothing to a `flex: 1` child, which has a flex-basis of 0, never
     * overflows its line and so only ever shrinks. Reintroducing `flex: 1`
     * here would silently restore the overflow.
     */
    const chip = SELECTOR.slice(SELECTOR.indexOf("modeChip: {"), SELECTOR.indexOf("modeChipActive"));
    expect(chip).not.toMatch(/\bflex:\s*1\b/);
    expect(SELECTOR).toMatch(/modeChipAcross:[\s\S]*?flexBasis:/);
    expect(SELECTOR).toMatch(/modeChipStacked:[\s\S]*?flexBasis:/);
    expect(SELECTOR).toMatch(/modeRow:[\s\S]*?flexWrap:\s*"wrap"/);
  });

  it("caps the pill label, because a single word cannot wrap except mid-word", () => {
    expect(SELECTOR).toMatch(/maxFontSizeMultiplier=\{MAX_FIXED_CONTROL_FONT_SCALE\}/);
    // Two columns is about 193pt of a 440pt screen. The 13pt caption at the cap
    // sets "Challenge" at roughly 103pt; uncapped at 3.12 it would need ~200pt.
    expect(MAX_FIXED_CONTROL_FONT_SCALE).toBeLessThan(2);
  });

  it("chooses its layout from the shared predicate, not a literal of its own", () => {
    expect(SELECTOR).toMatch(/rowStacksAtFontScale\(fontScale\)/);
    expect(SELECTOR).not.toMatch(/fontScale\s*>\s*1\.\d/);
  });
});

describe("the screen header", () => {
  it("reads the same threshold rather than keeping a second copy of it", () => {
    // The two used to hold 1.5 independently. CLAUDE.md's rule for a genuinely
    // duplicated constant is a test asserting the copies are equal; one shared
    // export is the version with nothing to assert.
    expect(HEADER).toMatch(/rowStacksAtFontScale\(fontScale\)/);
    expect(HEADER).not.toMatch(/const STACK_ABOVE_FONT_SCALE/);
  });
});
