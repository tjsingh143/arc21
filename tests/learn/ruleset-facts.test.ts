/**
 * How to Play, checked against the ruleset it describes.
 *
 * A rules article is the easiest surface in a product to turn into a lie: the
 * sentence is written once, the ruleset changes later, and the article keeps
 * confidently teaching a game nobody is playing. Every rule-dependent sentence
 * on that screen is therefore a function of `BlackjackRules`, and this file
 * feeds it VARIANT rulesets — H17, no surrender, no DAS, split-by-rank — so the
 * branches are proved to be real rather than assumed from the one shipped
 * configuration.
 *
 * The shipped assertions are pinned against `ARC_STANDARD_RULES` and
 * `docs/BLACKJACK_RULES.md`. If a rule changes without the article changing with
 * it, this fails.
 */

import { describe, expect, it } from "vitest";

import { ARC_STANDARD_RULES, type BlackjackRules } from "../../shared/blackjack/rules.js";
import {
  blackjackPayoutRatio,
  dealerRuleSentence,
  doubleRuleSentence,
  insurancePayoutRatio,
  insuranceStakeDescription,
  NO_PROFIT_CLAIM,
  rulesetFacts,
  settlementRows,
  splitAceTwentyOneSentence,
  splitRuleSentence,
  surrenderRuleSentence,
  VIRTUAL_CHIPS_DISCLAIMER,
} from "../../src/features/learn/ruleset-facts.js";

const RULES = ARC_STANDARD_RULES;

function variant(overrides: Partial<BlackjackRules>): BlackjackRules {
  return { ...RULES, ...overrides };
}

/** Every sentence the article can render, for the sweeps below. */
function allSentences(rules: BlackjackRules): string[] {
  return [
    dealerRuleSentence(rules),
    doubleRuleSentence(rules),
    splitRuleSentence(rules),
    surrenderRuleSentence(rules),
    splitAceTwentyOneSentence(rules),
  ];
}

// ---------------------------------------------------------------------------

describe("payout ratios come from the ruleset", () => {
  it("states 3:2 for Arc Standard", () => {
    expect(blackjackPayoutRatio(RULES)).toBe("3:2");
    expect(insurancePayoutRatio(RULES)).toBe("2:1");
  });

  it("follows the ruleset to a worse payout rather than staying at 3:2", () => {
    // 6:5 is the change a real product would make quietly. The article must not
    // keep advertising 3:2 when the table no longer pays it.
    expect(blackjackPayoutRatio(variant({ blackjackPayoutNumerator: 6, blackjackPayoutDenominator: 5 })))
      .toBe("6:5");
  });

  it("describes the insurance stake as a fraction of the bet", () => {
    expect(insuranceStakeDescription(RULES)).toBe("half your original bet");
    expect(
      insuranceStakeDescription(
        variant({ insuranceFractionNumerator: 1, insuranceFractionDenominator: 3 }),
      ),
    ).toBe("1/3 of your original bet");
  });
});

// ---------------------------------------------------------------------------

describe("the dealer sentence", () => {
  it("says the dealer stands on all 17s under Arc Standard", () => {
    const sentence = dealerRuleSentence(RULES);
    expect(sentence).toContain("stands on all 17s");
    expect(sentence).toContain("soft 17");
    expect(sentence).not.toContain("must draw again");
  });

  it("changes to hitting soft 17 when the rule does", () => {
    const sentence = dealerRuleSentence(variant({ dealerHitsSoft17: true }));
    expect(sentence).toContain("must draw again on a soft 17");
    expect(sentence).not.toContain("stands on all 17s");
  });

  it("never claims the dealer reacts to the player", () => {
    for (const rules of [RULES, variant({ dealerHitsSoft17: true })]) {
      expect(dealerRuleSentence(rules).toLowerCase()).not.toContain("adapt");
    }
  });
});

// ---------------------------------------------------------------------------

describe("the doubling sentence", () => {
  it("describes any-two-cards doubling with DAS under Arc Standard", () => {
    const sentence = doubleRuleSentence(RULES);
    expect(sentence).toContain("any first two cards");
    expect(sentence).toContain("including hands you have just split");
    expect(sentence).toContain("exactly one more card");
  });

  it("says so when doubling after a split is not allowed", () => {
    expect(doubleRuleSentence(variant({ doubleAfterSplit: false }))).toContain("not after a split");
  });

  it("says so when doubling is not offered at all", () => {
    expect(doubleRuleSentence(variant({ doubleAllowed: false }))).toBe(
      "Doubling is not offered in this ruleset.",
    );
  });
});

// ---------------------------------------------------------------------------

describe("the splitting sentence", () => {
  it("describes equal-value splitting, the four-hand cap and one-card split aces", () => {
    const sentence = splitRuleSentence(RULES);
    expect(sentence).toContain("equal point value");
    expect(sentence).toContain("king and a queen");
    expect(sentence).toContain("as many as 4 hands");
    expect(sentence).toContain("exactly one card each");
  });

  it("drops the king-and-queen example when splitting is by rank", () => {
    const sentence = splitRuleSentence(variant({ splitPolicy: "same_rank" }));
    expect(sentence).toContain("same rank");
    expect(sentence).not.toContain("king and a queen");
  });

  it("follows the ruleset on hitting split aces", () => {
    expect(splitRuleSentence(variant({ hitSplitAcesAllowed: true }))).toContain(
      "may be hit normally",
    );
    expect(splitRuleSentence(variant({ splitAcesAllowed: false }))).toContain(
      "Aces cannot be split",
    );
  });

  it("follows the hand cap rather than hardcoding four", () => {
    expect(splitRuleSentence(variant({ maxSplitHands: 2 }))).toContain("as many as 2 hands");
  });
});

// ---------------------------------------------------------------------------

describe("surrender and split-ace 21", () => {
  it("describes late surrender for Arc Standard", () => {
    const sentence = surrenderRuleSentence(RULES);
    expect(sentence).toContain("Late surrender");
    expect(sentence).toContain("half your bet");
    expect(sentence).toContain("after the dealer has checked");
  });

  it("says surrender is not offered when it is not", () => {
    expect(surrenderRuleSentence(variant({ lateSurrenderAllowed: false }))).toBe(
      "Surrender is not offered in this ruleset.",
    );
  });

  it("states that 21 on a split ace is not a blackjack", () => {
    // The rule players most often assume the other way round.
    expect(splitAceTwentyOneSentence(RULES)).toContain("not a blackjack");
    expect(splitAceTwentyOneSentence(variant({ splitAceTwentyOneIsBlackjack: true }))).toContain(
      "counts as blackjack",
    );
  });
});

// ---------------------------------------------------------------------------

describe("the at-a-glance table", () => {
  it("reports Arc Standard exactly as docs/BLACKJACK_RULES.md describes it", () => {
    const facts = new Map(rulesetFacts(RULES).map((fact) => [fact.label, fact.value]));
    expect(facts.get("Decks")).toBe("6, shuffled together");
    expect(facts.get("Dealer")).toBe("Stands on all 17s");
    expect(facts.get("Blackjack pays")).toBe("3:2");
    expect(facts.get("Double")).toBe("Any two cards, including after a split");
    expect(facts.get("Split")).toBe("Equal values, up to 4 hands");
    expect(facts.get("Surrender")).toBe("Late surrender, half your bet back");
    expect(facts.get("Insurance")).toBe("half your original bet, pays 2:1");
  });

  it("says 'Not offered' rather than omitting a rule that is switched off", () => {
    const facts = new Map(
      rulesetFacts(
        variant({ lateSurrenderAllowed: false, insuranceAllowed: false, doubleAllowed: false }),
      ).map((fact) => [fact.label, fact.value]),
    );
    expect(facts.get("Surrender")).toBe("Not offered");
    expect(facts.get("Insurance")).toBe("Not offered");
    expect(facts.get("Double")).toBe("Not offered");
  });

  it("never renders an empty value", () => {
    for (const rules of [RULES, variant({ dealerHitsSoft17: true, splitPolicy: "same_rank" })]) {
      for (const fact of rulesetFacts(rules)) {
        expect(fact.label.length).toBeGreaterThan(0);
        expect(fact.value.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("the settlement table", () => {
  it("states what returns to the stack, derived from the payout ratios", () => {
    const rows = new Map(settlementRows(RULES).map((row) => [row.result, row.returns]));
    expect(rows.get("Blackjack")).toBe("2.5× your bet");
    expect(rows.get("Win")).toBe("2× your bet");
    expect(rows.get("Push")).toBe("1× your bet");
    expect(rows.get("Loss or bust")).toBe("Nothing");
    expect(rows.get("Surrender")).toBe("0.5× your bet");
    expect(rows.get("Insurance")).toBe("3× the insurance stake");
  });

  it("moves the blackjack row with the payout rather than pinning 2.5", () => {
    const rows = new Map(
      settlementRows(variant({ blackjackPayoutNumerator: 6, blackjackPayoutDenominator: 5 })).map(
        (row) => [row.result, row.returns],
      ),
    );
    expect(rows.get("Blackjack")).toBe("2.2× your bet");
  });

  it("omits rows for rules that are switched off", () => {
    const results = settlementRows(
      variant({ lateSurrenderAllowed: false, insuranceAllowed: false }),
    ).map((row) => row.result);
    expect(results).not.toContain("Surrender");
    expect(results).not.toContain("Insurance");
  });
});

// ---------------------------------------------------------------------------

describe("the claims the product is not allowed to soften", () => {
  it("states plainly that virtual chips have no monetary value", () => {
    expect(VIRTUAL_CHIPS_DISCLAIMER).toContain("no monetary value");
    expect(VIRTUAL_CHIPS_DISCLAIMER).toContain("cannot be withdrawn");
    expect(VIRTUAL_CHIPS_DISCLAIMER).toContain("money or prizes");
  });

  it("never claims a strategy makes blackjack profitable", () => {
    expect(NO_PROFIT_CLAIM).toContain("does not remove it");
    expect(NO_PROFIT_CLAIM).toContain("No strategy");
  });

  it("keeps promissory language out of every rule sentence", () => {
    const forbidden = [/guarantee/i, /\bwin more\b/i, /\bprofit/i, /\bbeat the house\b/i, /\bedge over the house\b/i];
    const rulesets = [
      RULES,
      variant({ dealerHitsSoft17: true }),
      variant({ lateSurrenderAllowed: false, doubleAllowed: false, insuranceAllowed: false }),
      variant({ splitPolicy: "same_rank", hitSplitAcesAllowed: true }),
    ];

    for (const rules of rulesets) {
      const text = [
        ...allSentences(rules),
        ...rulesetFacts(rules).map((fact) => `${fact.label} ${fact.value}`),
        ...settlementRows(rules).map((row) => `${row.result} ${row.returns} ${row.note}`),
      ].join(" ");

      for (const pattern of forbidden) {
        expect(text, `matched ${pattern} for ${rules.id}`).not.toMatch(pattern);
      }
    }
  });

  it("produces a complete sentence for every rule under every variant", () => {
    const rulesets = [
      RULES,
      variant({ dealerHitsSoft17: true }),
      variant({ doubleAllowed: false }),
      variant({ doubleAfterSplit: false }),
      variant({ lateSurrenderAllowed: false }),
      variant({ splitAcesAllowed: false }),
      variant({ hitSplitAcesAllowed: true }),
      variant({ splitPolicy: "same_rank" }),
      variant({ splitAceTwentyOneIsBlackjack: true }),
    ];

    for (const rules of rulesets) {
      for (const sentence of allSentences(rules)) {
        expect(sentence.length).toBeGreaterThan(20);
        expect(sentence.trim().endsWith(".")).toBe(true);
      }
    }
  });
});
