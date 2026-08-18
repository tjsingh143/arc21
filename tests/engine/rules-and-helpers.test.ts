import { describe, expect, it } from "vitest";

import {
  cardAccessibilityLabel,
  cardShorthand,
  cardValue,
  isAce,
  isSplitEligible,
  isTenValue,
  parseCardShorthand,
  rankValue,
} from "../../shared/blackjack/cards.js";
import {
  describeHandValue,
  evaluateHand,
  handValueAccessibilityLabel,
  visibleDealerValue,
} from "../../shared/blackjack/hand-value.js";
import {
  ARC_STANDARD_RULES,
  assertRulesAreCoherent,
  rulesForTier,
  rulesetKey,
  TABLE_TIERS,
} from "../../shared/blackjack/rules.js";
import {
  findSeat,
  getLegalActions,
  isBetAmountValid,
  maxPlaceableBet,
} from "../../shared/blackjack/legal-actions.js";
import { betAndDeal, cards, harness } from "../helpers/engine-harness.js";

describe("card helpers", () => {
  it("values ranks with aces as eleven", () => {
    expect(rankValue("A")).toBe(11);
    expect(rankValue("K")).toBe(10);
    expect(rankValue("7")).toBe(7);
  });

  it("identifies aces and ten-value cards", () => {
    const [ace, king, seven] = cards("AS KD 7H");
    expect(isAce(ace!)).toBe(true);
    expect(isAce(king!)).toBe(false);
    expect(isTenValue(king!)).toBe(true);
    expect(isTenValue(seven!)).toBe(false);
    expect(cardValue(ace!)).toBe(11);
  });

  it("compares split eligibility by policy", () => {
    const [king, queen, eight, otherEight] = cards("KS QD 8H 8C");
    expect(isSplitEligible(king!, queen!, "same_value")).toBe(true);
    expect(isSplitEligible(king!, queen!, "same_rank")).toBe(false);
    expect(isSplitEligible(eight!, otherEight!, "same_rank")).toBe(true);
  });

  it("produces accessible labels that never rely on colour", () => {
    const [ace, ten] = cards("AS 10H");
    expect(cardAccessibilityLabel(ace!)).toBe("Ace of Spades");
    expect(cardAccessibilityLabel(ten!)).toBe("Ten of Hearts");
    expect(cardShorthand(ace!)).toBe("AS");
  });

  it("parses shorthand and rejects nonsense", () => {
    expect(parseCardShorthand("10d").rank).toBe("10");
    expect(parseCardShorthand("10d").suit).toBe("D");
    expect(() => parseCardShorthand("1S")).toThrow(/Unparseable/);
    expect(() => parseCardShorthand("AX")).toThrow(/Unparseable/);
    expect(() => parseCardShorthand("")).toThrow(/Unparseable/);
  });
});

describe("hand value presentation", () => {
  it("describes hands in plain language", () => {
    expect(describeHandValue(evaluateHand(cards("AS KD")))).toBe("Blackjack");
    expect(describeHandValue(evaluateHand(cards("AS 6D")))).toBe("Soft 17");
    expect(describeHandValue(evaluateHand(cards("10S 6D")))).toBe("Hard 16");
    expect(describeHandValue(evaluateHand(cards("10S 6D 9C")))).toBe("Bust · 25");
  });

  it("gives screen readers unabbreviated phrasing", () => {
    expect(handValueAccessibilityLabel(evaluateHand(cards("AS KD")))).toBe("Blackjack");
    expect(handValueAccessibilityLabel(evaluateHand(cards("AS 6D")))).toBe("Soft 17");
    expect(handValueAccessibilityLabel(evaluateHand(cards("10S 6D")))).toBe("16");
    expect(handValueAccessibilityLabel(evaluateHand(cards("10S 6D 9C")))).toBe("Bust, 25");
  });

  it("evaluates only the dealer's face-up cards", () => {
    expect(visibleDealerValue(cards("10S")).bestTotal).toBe(10);
    expect(visibleDealerValue(cards("AS")).bestTotal).toBe(11);
  });
});

describe("ruleset validation", () => {
  it("accepts the shipped default", () => {
    expect(() => assertRulesAreCoherent(ARC_STANDARD_RULES)).not.toThrow();
  });

  it("rejects an invalid deck count", () => {
    expect(() => assertRulesAreCoherent({ ...ARC_STANDARD_RULES, deckCount: 0 })).toThrow(
      /deckCount/,
    );
  });

  it("rejects a bet increment that does not divide the limits", () => {
    expect(() => assertRulesAreCoherent({ ...ARC_STANDARD_RULES, minBet: 55 })).toThrow(
      /minBet must be a multiple/,
    );
    expect(() => assertRulesAreCoherent({ ...ARC_STANDARD_RULES, maxBet: 1005 })).toThrow(
      /maxBet must be a multiple/,
    );
  });

  it("rejects a non-positive bet increment", () => {
    expect(() => assertRulesAreCoherent({ ...ARC_STANDARD_RULES, betIncrement: 0 })).toThrow(
      /betIncrement/,
    );
  });

  it("rejects min above max", () => {
    expect(() =>
      assertRulesAreCoherent({ ...ARC_STANDARD_RULES, minBet: 2000, maxBet: 1000 }),
    ).toThrow(/minBet must not exceed maxBet/);
  });

  it("rejects an impossible split cap", () => {
    expect(() => assertRulesAreCoherent({ ...ARC_STANDARD_RULES, maxSplitHands: 0 })).toThrow(
      /maxSplitHands/,
    );
  });

  it("rejects penetration outside (0,1)", () => {
    expect(() => assertRulesAreCoherent({ ...ARC_STANDARD_RULES, targetPenetration: 0 })).toThrow(
      /targetPenetration/,
    );
    expect(() => assertRulesAreCoherent({ ...ARC_STANDARD_RULES, targetPenetration: 1 })).toThrow(
      /targetPenetration/,
    );
  });

  it("rejects peeking without a hole card", () => {
    expect(() =>
      assertRulesAreCoherent({ ...ARC_STANDARD_RULES, dealerHoleCard: false }),
    ).toThrow(/cannot peek without a hole card/);
  });

  it("keys strategy tables by id and version", () => {
    expect(rulesetKey(ARC_STANDARD_RULES)).toBe("arc-standard@1");
  });

  it("derives tier rules that change stakes and nothing else", () => {
    const high = TABLE_TIERS.find((tier) => tier.id === "high")!;
    const derived = rulesForTier(high);
    expect(derived.minBet).toBe(200);
    expect(derived.maxBet).toBe(5_000);
    expect(derived.dealerHitsSoft17).toBe(ARC_STANDARD_RULES.dealerHitsSoft17);
    expect(derived.deckCount).toBe(ARC_STANDARD_RULES.deckCount);
    expect(() => assertRulesAreCoherent(derived)).not.toThrow();
  });

  it("keeps every shipped tier coherent", () => {
    for (const tier of TABLE_TIERS) {
      expect(() => assertRulesAreCoherent(rulesForTier(tier))).not.toThrow();
    }
  });
});

describe("bet bounds", () => {
  const seat = (stack: number) => ({
    seatId: "s1",
    userId: null,
    displayName: "T",
    stack,
    originalBet: 0,
    insuranceBet: 0,
    insuranceDecision: "NOT_OFFERED" as const,
    hands: [],
    currentHandIndex: 0,
    connected: true,
    betLocked: false,
    sittingOut: false,
  });

  it("rounds the affordable maximum down to the increment", () => {
    expect(maxPlaceableBet(seat(337), ARC_STANDARD_RULES)).toBe(330);
    expect(maxPlaceableBet(seat(100_000), ARC_STANDARD_RULES)).toBe(1_000);
  });

  it("names the reason a bet is invalid", () => {
    expect(isBetAmountValid(10, seat(5_000), ARC_STANDARD_RULES).reason).toBe("BET_BELOW_MINIMUM");
    expect(isBetAmountValid(5_000, seat(9_000), ARC_STANDARD_RULES).reason).toBe("BET_ABOVE_MAXIMUM");
    expect(isBetAmountValid(155, seat(5_000), ARC_STANDARD_RULES).reason).toBe(
      "BET_NOT_MULTIPLE_OF_INCREMENT",
    );
    expect(isBetAmountValid(500, seat(100), ARC_STANDARD_RULES).reason).toBe("INSUFFICIENT_STACK");
    expect(isBetAmountValid(100.5, seat(5_000), ARC_STANDARD_RULES).reason).toBe(
      "BET_NOT_MULTIPLE_OF_INCREMENT",
    );
    expect(isBetAmountValid(100, seat(5_000), ARC_STANDARD_RULES).valid).toBe(true);
  });
});

describe("legal action lookup", () => {
  it("returns nothing for an unknown seat", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" });
    expect(getLegalActions(h.state, "ghost").actions).toEqual([]);
    expect(findSeat(h.state, "ghost")).toBeUndefined();
  });

  it("offers betting controls during BETTING_OPEN", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" });
    const legal = getLegalActions(h.state, "s1");
    expect(legal.canPlaceBet).toBe(true);
    expect(legal.betBounds).toEqual({ min: 50, max: 1_000, increment: 10 });
    expect(legal.canLockBet).toBe(false); // nothing staged yet
  });

  it("cannot bet when the stack is below the table minimum", () => {
    const h = harness({
      shoe: "5S 6D 7H 8C",
      seats: [{ seatId: "s1", displayName: "T", stack: 20 }],
    });
    const legal = getLegalActions(h.state, "s1");
    expect(legal.canPlaceBet).toBe(false);
    expect(legal.betBounds).toBeNull();
  });

  it("offers no actions once a hand is settled", () => {
    const h = betAndDeal(harness({ shoe: "AS 7D KH 9C" }), 100);
    expect(h.state.phase).toBe("HAND_COMPLETE");
    expect(getLegalActions(h.state, "s1").actions).toEqual([]);
  });

  it("offers no actions to a seat that is sitting out", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" }).patch((state) => ({
      ...state,
      seats: state.seats.map((seat) => ({ ...seat, sittingOut: true })),
    }));
    expect(getLegalActions(h.state, "s1").actions).toEqual([]);
  });
});
