import { describe, expect, it } from "vitest";

import {
  bar,
  CONTRAST_PAIRINGS,
  contrastRatio,
  DEFERRED_TO_INCREASED_CONTRAST,
  INCREASED_CONTRAST_PAIRINGS,
} from "../../scripts/check-contrast";

describe("WCAG contrast — the default palette", () => {
  it.each(CONTRAST_PAIRINGS)("$name clears its bar", ({ fg, bg, kind }) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(bar(kind));
  });

  it("checks a non-trivial number of pairings — a gate over zero rows is not a gate", () => {
    expect(CONTRAST_PAIRINGS.length).toBeGreaterThan(30);
  });
});

describe("WCAG contrast — Increased contrast accessibility setting", () => {
  it("documents every default-palette pairing that stays under 3:1 by design", () => {
    for (const pairing of DEFERRED_TO_INCREASED_CONTRAST) {
      expect(contrastRatio(pairing.fg, pairing.bg)).toBeLessThan(bar(pairing.kind));
    }
  });

  it.each(INCREASED_CONTRAST_PAIRINGS)("$name clears 3:1 once the setting is on", ({ fg, bg, kind }) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(bar(kind));
  });
});

describe("contrastRatio", () => {
  it("is 1:1 for identical colours and 21:1 for pure black on white", () => {
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
  });

  it("is symmetric — foreground and background can be swapped", () => {
    expect(contrastRatio("#0B0D10", "#F5F3EE")).toBeCloseTo(contrastRatio("#F5F3EE", "#0B0D10"), 5);
  });

  it("composites a translucent rgba colour over its background before measuring", () => {
    // Fully transparent white over black measures as black-on-black: 1:1.
    expect(contrastRatio("rgba(255,255,255,0)", "#000000")).toBeCloseTo(1, 5);
    // Fully opaque white over black is the maximum: 21:1.
    expect(contrastRatio("rgba(255,255,255,1)", "#000000")).toBeCloseTo(21, 1);
  });
});
