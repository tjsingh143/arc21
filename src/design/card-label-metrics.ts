/**
 * How big the rank and suit are on a card face.
 *
 * A PLAIN MODULE ON THE TESTABLE SIDE OF THE REACT NATIVE WALL, for the same
 * reason `type-metrics.ts`, `type-scale.ts`, `format-chips.ts` and
 * `motion-timing.ts` are: `src/design/typography.ts` calls `Platform.select` at
 * module load, so anything that reaches it fails to parse under Node with
 * "Flow is not supported". `PlayingCard.tsx` imports these numbers and adds
 * nothing to them.
 *
 * WHY THE FACE DOES NOT FOLLOW DYNAMIC TYPE. `allowFontScaling` is false on all
 * three labels, deliberately: a card is fixed geometry — 5:7, and only 40pt
 * wide at the compact size used for other players' seats — and text that grows
 * past it does not reflow, it truncates a rank. "Sta…" on the action dock was
 * the same lesson. So the accessibility answer here is a bounded SETTING,
 * `largeCardLabels`, and this file is where the bound is computed.
 *
 * THE TRADE, and it is the whole design. Making the corner bigger is what helps
 * somebody read a card; the centre glyph is a decorative repeat of information
 * the corner already carries. Growing both would run the corner block into the
 * centre glyph at the compact size, where the default layout has only ~3pt
 * between them to begin with. So the corner grows by `LARGE_CARD_LABEL_SCALE`
 * and the centre glyph SHRINKS to `CARD_LABEL_RATIOS.centreGlyphLarge` — and
 * the two were chosen together so that the enlarged layout has exactly the same
 * clearance as the default one at every card size. `tests/design` asserts that
 * equality rather than a number somebody typed, so changing either constant
 * fails there instead of clipping a card for the person who turned the setting
 * on — which is exactly the person least able to tolerate one.
 */

/** Ratios of font size to card width. */
export const CARD_LABEL_RATIOS = {
  /** Two glyphs, so it starts smaller. */
  rankWide: 0.3,
  rankNarrow: 0.36,
  cornerGlyph: 0.2,
  centreGlyph: 0.46,
  /** The decorative repeat gives way so the corner can grow. */
  centreGlyphLarge: 0.32,
} as const;

/** How much bigger "Large card labels" makes the rank and the corner glyph. */
export const LARGE_CARD_LABEL_SCALE = 1.25;

/**
 * The geometry constants this module reasons with, kept here so the model is
 * inspectable rather than buried in an expression.
 *
 * `LINE_HEIGHT` is the ratio of a `Text`'s laid-out height to its font size
 * with `includeFontPadding: false`; 1.2 is the platform default and what the
 * card face gets. `CORNER_GLYPH_OFFSET` and `CENTRE_GLYPH_BOTTOM` mirror
 * `marginTop: -2` and `bottom: 2` in `PlayingCard`'s stylesheet, and
 * `CARD_FACE_PADDING` mirrors its `padding: 4`. If any of those change in the
 * component, they change here — which is what makes the assertion mean
 * something.
 */
export const LINE_HEIGHT = 1.2;
export const CARD_FACE_PADDING = 4;
export const CORNER_GLYPH_OFFSET = -2;
export const CENTRE_GLYPH_BOTTOM = 2;

/** Card proportions, duplicated from `tokens.ts` — see the note in the test. */
export const CARD_ASPECT_RATIO = 5 / 7;

export interface CardLabelSizes {
  readonly rank: number;
  readonly cornerGlyph: number;
  readonly centreGlyph: number;
}

/**
 * The three font sizes a card face renders at.
 *
 * `rank` is the only one that depends on which rank it is: "10" is two glyphs
 * and every other rank is one.
 */
export function cardLabelSizes(
  cardWidth: number,
  rank: string,
  large: boolean,
): CardLabelSizes {
  const scale = large ? LARGE_CARD_LABEL_SCALE : 1;
  const rankRatio = rank.length > 1 ? CARD_LABEL_RATIOS.rankWide : CARD_LABEL_RATIOS.rankNarrow;
  return {
    rank: cardWidth * rankRatio * scale,
    cornerGlyph: cardWidth * CARD_LABEL_RATIOS.cornerGlyph * scale,
    centreGlyph:
      cardWidth *
      (large ? CARD_LABEL_RATIOS.centreGlyphLarge : CARD_LABEL_RATIOS.centreGlyph),
  };
}

/**
 * Vertical space between the bottom of the corner block and the top of the
 * centre glyph, in points. Negative means they overlap.
 *
 * Measured for the TALL rank — a single glyph, which takes the larger ratio —
 * because that is the one that reaches furthest down the card.
 */
export function labelClearance(cardWidth: number, large: boolean): number {
  const cardHeight = cardWidth / CARD_ASPECT_RATIO;
  const sizes = cardLabelSizes(cardWidth, "K", large);
  const cornerBlock =
    sizes.rank * LINE_HEIGHT + sizes.cornerGlyph * LINE_HEIGHT + CORNER_GLYPH_OFFSET;
  const centreTop = cardHeight - CENTRE_GLYPH_BOTTOM - sizes.centreGlyph * LINE_HEIGHT;
  return centreTop - (CARD_FACE_PADDING + cornerBlock);
}

/**
 * Conservative advance width of one bold rank glyph, as a fraction of the font
 * size. Above every rank that ships (A, 2–10, J, Q, K) on the system faces.
 */
export const GLYPH_ADVANCE = 0.62;

/** The width the rank text needs, in points. */
export function rankWidth(cardWidth: number, rank: string, large: boolean): number {
  return cardLabelSizes(cardWidth, rank, large).rank * GLYPH_ADVANCE * rank.length;
}

/** Points available for the rank inside the face's padding. */
export function usableWidth(cardWidth: number): number {
  return cardWidth - CARD_FACE_PADDING * 2;
}
