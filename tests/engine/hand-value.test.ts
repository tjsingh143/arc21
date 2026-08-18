import { describe, expect, it } from "vitest";

import { evaluateHand, describeHandValue } from "../../shared/blackjack/hand-value.js";
import { cards } from "../helpers/engine-harness.js";

describe("ace normalisation", () => {
  it("treats A + 6 as soft 17", () => {
    const value = evaluateHand(cards("AS 6D"));
    expect(value.bestTotal).toBe(17);
    expect(value.hardTotal).toBe(7);
    expect(value.isSoft).toBe(true);
    expect(value.isBust).toBe(false);
  });

  it("treats A + A + 9 as 21", () => {
    const value = evaluateHand(cards("AS AD 9C"));
    expect(value.bestTotal).toBe(21);
    expect(value.isSoft).toBe(true);
    expect(value.isTwentyOne).toBe(true);
    // Three cards, so never a natural.
    expect(value.isNaturalBlackjack).toBe(false);
  });

  it("downgrades the soft ace when a further card would bust: A + A + 9 + 10 = 21", () => {
    const value = evaluateHand(cards("AS AD 9C 10H"));
    expect(value.bestTotal).toBe(21);
    expect(value.isSoft).toBe(false);
    expect(value.isBust).toBe(false);
  });

  it("never counts two aces as eleven each", () => {
    const value = evaluateHand(cards("AS AD"));
    expect(value.bestTotal).toBe(12);
    expect(value.hardTotal).toBe(2);
    expect(value.isSoft).toBe(true);
  });

  it("handles four aces", () => {
    const value = evaluateHand(cards("AS AD AC AH"));
    expect(value.bestTotal).toBe(14);
    expect(value.isSoft).toBe(true);
  });

  it("downgrades through multiple aces as cards arrive", () => {
    expect(evaluateHand(cards("AS 5D")).bestTotal).toBe(16);
    expect(evaluateHand(cards("AS 5D 10C")).bestTotal).toBe(16);
    expect(evaluateHand(cards("AS 5D 10C 9H")).bestTotal).toBe(25);
    expect(evaluateHand(cards("AS 5D 10C 9H")).isBust).toBe(true);
  });

  it("reports hard totals without aces", () => {
    const value = evaluateHand(cards("10S 7D"));
    expect(value.bestTotal).toBe(17);
    expect(value.isSoft).toBe(false);
    expect(value.hardTotal).toBe(17);
  });

  it("reports soft 18 and hard 17 distinctly", () => {
    expect(describeHandValue(evaluateHand(cards("AS 7D")))).toBe("Soft 18");
    expect(describeHandValue(evaluateHand(cards("10S 7D")))).toBe("Hard 17");
  });

  it("detects bust", () => {
    const value = evaluateHand(cards("10S 9D 5C"));
    expect(value.bestTotal).toBe(24);
    expect(value.isBust).toBe(true);
  });
});

describe("natural blackjack recognition", () => {
  it("recognises A + K", () => {
    expect(evaluateHand(cards("AS KD")).isNaturalBlackjack).toBe(true);
  });

  it("recognises A + 10", () => {
    expect(evaluateHand(cards("AS 10D")).isNaturalBlackjack).toBe(true);
  });

  it("rejects a three-card 21", () => {
    expect(evaluateHand(cards("7S 7D 7C")).isNaturalBlackjack).toBe(false);
    expect(evaluateHand(cards("7S 7D 7C")).isTwentyOne).toBe(true);
  });

  it("rejects a split hand's two-card 21 by default", () => {
    const value = evaluateHand(cards("AS 10D"), { cameFromSplit: true });
    expect(value.isTwentyOne).toBe(true);
    expect(value.isNaturalBlackjack).toBe(false);
  });

  it("rejects split-ace 21 unless the ruleset opts in", () => {
    const base = { cameFromSplit: true, cameFromSplitAces: true };
    expect(evaluateHand(cards("AS 10D"), base).isNaturalBlackjack).toBe(false);
    expect(
      evaluateHand(cards("AS 10D"), { ...base, splitAceTwentyOneIsBlackjack: true })
        .isNaturalBlackjack,
    ).toBe(true);
  });

  it("rejects a split non-ace two-card 21", () => {
    // Splitting ten-value cards then drawing an ace gives 21, not blackjack.
    const value = evaluateHand(cards("KS AD"), { cameFromSplit: true });
    expect(value.isNaturalBlackjack).toBe(false);
  });
});
