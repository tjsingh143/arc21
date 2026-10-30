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
  MAX_TITLE_FONT_SCALE,
  rowStacksAtFontScale,
  STACK_ABOVE_FONT_SCALE,
  typeMetrics,
} from "../../src/design/type-metrics";
import {
  HOME_CHIP_FORMAT_LINKS,
  homeLinks,
  PLAY_MODES,
  PLAY_SUPPORT_LINKS,
} from "../../src/features/home/product-hierarchy";

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

/**
 * A card or tile title names a product, and a single word cannot wrap except
 * mid-word. At React Native's largest multiplier, "Tournament" in the 19pt
 * Play card title is ~359pt wide and "Leaderboards" in the 16pt link tile title
 * ~350pt, against a 324pt text column on the 390pt iPhone 17e — which drew
 * "Sprin / t / Tourn / amen / t" and "Lear / n". Stacking the badge and the
 * tiles gives a title the whole column; only a cap makes the widest word fit it.
 */
describe("the product title cap", () => {
  /*
   * React Native's OWN multipliers (`RCTAccessibilityManager.mm`), which is
   * what `fontScale` and `maxFontSizeMultiplier` work in. They are not iOS's
   * table above: the largest is 3.571, not 3.12.
   */
  const RN_ACCESSIBILITY_EXTRA_LARGE = 2.643;
  const RN_LARGEST = 3.571;

  /*
   * Each word's width in the system semibold face, per point of font size:
   * CoreText at 1000pt, which is the display optical size these titles reach
   * when the cap matters. A title word missing here fails the first test —
   * measure it before shipping it.
   */
  const SEMIBOLD_EM: Record<string, number> = {
    Public: 2.727, Table: 2.349, Private: 3.07, Sprint: 2.659, Tournament: 5.294,
    Quick: 2.578, Play: 1.88, Daily: 2.197, Challenge: 4.471, AI: 0.921,
    Practice: 3.625, Career: 2.977, Learn: 2.497, Leaderboards: 6.128, Friends: 3.286,
  };

  /** A 375pt iPhone (SE, mini) less 2 × (16 screen padding + 1 border + 16 card padding). */
  const NARROWEST_COLUMN = 375 - 2 * (16 + 1 + 16);
  /** The iPhone 17e's column, where the break was photographed. */
  const IPHONE_17E_COLUMN = 390 - 2 * (16 + 1 + 16);

  const links = [...HOME_CHIP_FORMAT_LINKS, ...PLAY_SUPPORT_LINKS, ...homeLinks({ kind: "unconfigured", message: "" })];
  const FACES = [
    { face: "Play card title", size: typeMetrics.sectionTitle.fontSize, titles: Object.values(PLAY_MODES).map((m) => m.title) },
    { face: "link tile title", size: typeMetrics.bodyStrong.fontSize, titles: links.map((l) => l.label) },
  ];
  const widest = (titles: readonly string[]) =>
    Math.max(...titles.flatMap((title) => title.split(" ")).map((word) => SEMIBOLD_EM[word] ?? Number.NaN));

  it("has a measurement for every word a title can show", () => {
    for (const { titles } of FACES) {
      for (const word of titles.flatMap((title) => title.split(" "))) {
        expect(SEMIBOLD_EM[word], word).toBeTypeOf("number");
      }
    }
  });

  it("sets the widest word of every title on one line in the narrowest column", () => {
    for (const { face, size, titles } of FACES) {
      expect(widest(titles) * size * MAX_TITLE_FONT_SCALE, face).toBeLessThanOrEqual(NARROWEST_COLUMN);
    }
  });

  it("is needed: uncapped at the largest size, the widest word misses even the 17e's column", () => {
    for (const { face, size, titles } of FACES) {
      expect(widest(titles) * size * RN_LARGEST, face).toBeGreaterThan(IPHONE_17E_COLUMN);
    }
  });

  it("leaves every size below the two largest alone", () => {
    expect(MAX_TITLE_FONT_SCALE).toBeGreaterThan(RN_ACCESSIBILITY_EXTRA_LARGE);
  });
});
