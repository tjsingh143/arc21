import { describe, expect, it } from "vitest";

import { typeMetrics, type TypographyToken } from "../../src/design/type-metrics";
import { TABLE_TEXT_SCALE_UP as SCALE_UP } from "../../src/design/type-scale";

describe("Larger table text — the type scale-up", () => {
  it("covers every typography token, so a new one cannot be silently unscalable", () => {
    const tokens = Object.keys(typeMetrics) as TypographyToken[];
    for (const token of tokens) {
      expect(SCALE_UP[token], `no scale-up defined for "${token}"`).toBeDefined();
    }
    expect(Object.keys(SCALE_UP).sort()).toEqual(tokens.sort());
  });

  it("never scales a token DOWN", () => {
    for (const [from, to] of Object.entries(SCALE_UP) as [TypographyToken, TypographyToken][]) {
      expect(
        typeMetrics[to].fontSize,
        `"${from}" scales up to "${to}", which is smaller`,
      ).toBeGreaterThanOrEqual(typeMetrics[from].fontSize as number);
    }
  });

  it("preserves the rendered STRING — an uppercased token stays uppercased", () => {
    // The bug this pins: overline → caption grew the text and silently
    // rendered "DEALER" as "Dealer". Maestro matches rendered text
    // case-sensitively, so that is a behaviour change, not a size change.
    for (const [from, to] of Object.entries(SCALE_UP) as [TypographyToken, TypographyToken][]) {
      const fromTransform = (typeMetrics[from] as { textTransform?: string }).textTransform;
      const toTransform = (typeMetrics[to] as { textTransform?: string }).textTransform;
      expect(toTransform, `"${from}" → "${to}" changes textTransform`).toBe(fromTransform);
    }
  });

  it("keeps a scaled total no larger than the screen title it sits under", () => {
    expect(typeMetrics[SCALE_UP.sectionTitle].fontSize).toBeLessThanOrEqual(
      typeMetrics.pageTitle.fontSize,
    );
  });
});
