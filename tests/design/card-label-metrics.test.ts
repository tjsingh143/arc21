/**
 * "Large card labels" — the bound, not the taste.
 *
 * A card face is fixed geometry: 5:7, and 40pt wide at the compact size used
 * for other players' seats. `allowFontScaling` is false on all three labels
 * because text that outgrows a card does not reflow, it TRUNCATES — and a rank
 * rendered as "1…" is a card a player cannot read. The action dock taught this
 * project the same lesson with "Sta…".
 *
 * So the setting is a bounded step, and these are the bounds. The one that
 * matters asserts an EQUALITY rather than a number somebody typed: the enlarged
 * layout leaves exactly as much room between the corner block and the centre
 * glyph as the default layout does. Change either constant and this fails,
 * instead of clipping a card for whoever turned the setting on.
 */

import { describe, expect, it } from "vitest";

import {
  CARD_ASPECT_RATIO,
  CARD_LABEL_RATIOS,
  LARGE_CARD_LABEL_SCALE,
  cardLabelSizes,
  labelClearance,
  rankWidth,
  usableWidth,
} from "../../src/design/card-label-metrics.js";
import { cardAspectRatio, cardSizes } from "../../src/design/tokens.js";

/** Every rank the shoe contains. "10" is the wide one. */
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SIZES = Object.values(cardSizes).map((size) => size.width);

/**
 * `tokens.ts` reaches React Native through its neighbours, so the aspect ratio
 * is duplicated on the testable side. The project's rule for a genuinely
 * duplicated constant is a test asserting the two are equal — see
 * `tests/progression/settlement-accounting.test.ts`.
 */
it("keeps its copy of the card aspect ratio equal to the token", () => {
  expect(CARD_ASPECT_RATIO).toBe(cardAspectRatio);
});

describe("large card labels", () => {
  it("is off by default and changes nothing when off", () => {
    for (const width of SIZES) {
      expect(cardLabelSizes(width, "K", false)).toEqual({
        rank: width * CARD_LABEL_RATIOS.rankNarrow,
        cornerGlyph: width * CARD_LABEL_RATIOS.cornerGlyph,
        centreGlyph: width * CARD_LABEL_RATIOS.centreGlyph,
      });
    }
  });

  /** If this ever passes trivially, the setting governs nothing again. */
  it("actually makes the rank and the corner glyph bigger", () => {
    for (const width of SIZES) {
      for (const rank of RANKS) {
        const off = cardLabelSizes(width, rank, false);
        const on = cardLabelSizes(width, rank, true);
        expect(on.rank).toBeGreaterThan(off.rank);
        expect(on.cornerGlyph).toBeGreaterThan(off.cornerGlyph);
      }
    }
  });

  /** The decorative repeat gives way. That is what makes the room. */
  it("shrinks the centre glyph rather than growing everything", () => {
    for (const width of SIZES) {
      expect(cardLabelSizes(width, "K", true).centreGlyph).toBeLessThan(
        cardLabelSizes(width, "K", false).centreGlyph,
      );
    }
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * The compact card has only about 3pt between the corner block and the centre
   * glyph in the DEFAULT layout, so "it fits" is not a useful bar — the bar is
   * that turning the setting on takes nothing away. The two constants were
   * chosen together to make this exact, so a strict equality is honest here.
   */
  it("leaves exactly as much room as the default layout, at every card size", () => {
    for (const width of SIZES) {
      expect(labelClearance(width, true)).toBeCloseTo(labelClearance(width, false), 6);
      // And that the room is positive in the first place.
      expect(labelClearance(width, false)).toBeGreaterThan(0);
    }
  });

  /** Raising the scale alone, without the centre glyph giving way, collides. */
  it("would collide at the compact size if the corner simply grew", () => {
    const compact = Math.min(...SIZES);
    const cardHeight = compact / CARD_ASPECT_RATIO;
    const grownCorner =
      compact * CARD_LABEL_RATIOS.rankNarrow * LARGE_CARD_LABEL_SCALE * 1.2 +
      compact * CARD_LABEL_RATIOS.cornerGlyph * LARGE_CARD_LABEL_SCALE * 1.2 -
      2;
    const unchangedCentreTop =
      cardHeight - 2 - compact * CARD_LABEL_RATIOS.centreGlyph * 1.2;
    expect(unchangedCentreTop - (4 + grownCorner)).toBeLessThan(0);
  });

  it("keeps every rank inside the card at every size, enlarged", () => {
    for (const width of SIZES) {
      for (const rank of RANKS) {
        expect(rankWidth(width, rank, true)).toBeLessThanOrEqual(usableWidth(width));
      }
    }
  });

  /** "10" is two glyphs, so it starts smaller and must stay smaller. */
  it("gives the two-glyph rank a smaller size than the one-glyph ranks", () => {
    for (const width of SIZES) {
      for (const large of [false, true]) {
        expect(cardLabelSizes(width, "10", large).rank).toBeLessThan(
          cardLabelSizes(width, "K", large).rank,
        );
      }
    }
  });
});
