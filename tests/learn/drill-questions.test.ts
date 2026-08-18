/**
 * Decision Drill question generation.
 *
 * The property that matters is the one the specification names: a question can
 * never be asked that the tables cannot grade. That is tested three ways —
 * against the advisor, against the strategy table's key space, and against the
 * real engine, which is asked whether it would actually have offered the buttons
 * the drill draws.
 */

import { describe, expect, it } from "vitest";

import { cardShorthand } from "../../shared/blackjack/cards.js";
import { getLegalActions } from "../../shared/blackjack/legal-actions.js";
import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";
import {
  adviseAction,
  ARC_STANDARD_STRATEGY_TABLE,
  describeStrategyState,
  normalizeStrategyKey,
} from "../../shared/strategy/index.js";
import type { StrategyAction } from "../../shared/strategy/index.js";
import {
  buildDrillQuestions,
  DRILL_CATEGORIES,
  drillLegalActions,
  explainDrillQuestion,
  gradeDrillAnswer,
  parseDrillCategory,
  questionsForCategory,
  twoCardValuesFor,
  type DrillQuestion,
} from "../../src/features/learn/drill-questions.js";
import { betAndDeal, harness } from "../helpers/engine-harness.js";

const QUESTIONS = buildDrillQuestions();

describe("the question bank", () => {
  it("is not empty and covers all three hand classes", () => {
    expect(QUESTIONS.length).toBeGreaterThan(200);
    for (const handClass of ["hard", "soft", "pair"] as const) {
      expect(QUESTIONS.some((question) => question.handClass === handClass)).toBe(true);
    }
  });

  it("asks every dealer upcard for every hand it asks about", () => {
    const byRow = new Map<string, Set<number>>();
    for (const question of QUESTIONS) {
      const row = `${question.handClass}:${question.handLabel}`;
      const upcards = byRow.get(row) ?? new Set<number>();
      upcards.add(question.state.dealerUpcardValue);
      byRow.set(row, upcards);
    }
    for (const upcards of byRow.values()) {
      expect(upcards.size).toBe(10);
    }
  });

  it("builds the same bank every time, in a stable order", () => {
    const again = buildDrillQuestions();
    expect(again.map((question) => question.key)).toEqual(QUESTIONS.map((q) => q.key));
  });

  it("gives every question two real cards and a real upcard", () => {
    for (const question of QUESTIONS) {
      expect(question.playerCards).toHaveLength(2);
      expect(question.playerCards[0].id).not.toBe(question.playerCards[1].id);
      expect(question.dealerUpcard.id).not.toBe(question.playerCards[0].id);
    }
  });

  it("never poses a hand that has no decision in it", () => {
    for (const question of QUESTIONS) {
      // A natural or a bust is not a decision; `describeStrategyState` returns
      // null for both, so surviving the round trip already proves it — this
      // states the consequence directly.
      expect(question.state.playerTotal).toBeLessThanOrEqual(20);
      expect(question.actions.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("every question is gradeable", () => {
  it("addresses a key the table actually holds", () => {
    for (const question of QUESTIONS) {
      expect(ARC_STANDARD_STRATEGY_TABLE.entries[question.key]).toBeDefined();
    }
  });

  it("has an expected answer that is exactly what adviseAction returns", () => {
    for (const question of QUESTIONS) {
      const recommendation = adviseAction({
        rules: ARC_STANDARD_RULES,
        state: question.state,
        legalActions: [...question.actions],
      });
      expect(recommendation).not.toBeNull();
      expect(recommendation?.action).toBe(question.answer);
    }
  });

  it("only ever expects an action it actually offers as a button", () => {
    for (const question of QUESTIONS) {
      expect(question.actions).toContain(question.answer);
    }
  });

  it("round-trips: the cards on screen normalise back to the key being asked", () => {
    for (const question of QUESTIONS) {
      const derived = describeStrategyState(
        [...question.playerCards],
        question.dealerUpcard,
        { splitPolicy: ARC_STANDARD_RULES.splitPolicy },
      );
      expect(derived).not.toBeNull();
      if (derived) expect(normalizeStrategyKey(derived)).toBe(question.key);
    }
  });
});

describe("the buttons match what the engine would offer", () => {
  /**
   * Deals the question's exact cards through the real engine and reports what
   * `getLegalActions` says. Deal order is player, dealer up, player, dealer hole.
   * The hole card is a five so the dealer never has a natural, which would end
   * the hand before any decision existed.
   */
  function engineActions(question: DrillQuestion): StrategyAction[] {
    const shoe = [
      cardShorthand(question.playerCards[0]),
      cardShorthand(question.dealerUpcard),
      cardShorthand(question.playerCards[1]),
      "5D",
    ].join(" ");

    let h = betAndDeal(harness({ shoe }), 100);
    // An ace upcard offers insurance before anyone may act.
    if (h.state.phase === "INSURANCE_OFFER") {
      h = h.send({ type: "DECLINE_INSURANCE", seatId: "s1" });
    }
    expect(h.state.phase).toBe("PLAYER_TURNS");
    return getLegalActions(h.state, "s1").actions;
  }

  it("agrees with getLegalActions on every question in the bank", () => {
    for (const question of QUESTIONS) {
      expect(sorted(engineActions(question))).toEqual(sorted([...question.actions]));
    }
  });

  it("drops the split button when the ruleset forbids splitting aces", () => {
    const pair = QUESTIONS.find((question) => question.state.pairValue === 11);
    expect(pair).toBeDefined();
    if (!pair) return;

    const actions = drillLegalActions(
      { ...ARC_STANDARD_RULES, splitAcesAllowed: false },
      pair.state,
    );
    expect(actions).not.toContain("SPLIT");
    expect(drillLegalActions(ARC_STANDARD_RULES, pair.state)).toContain("SPLIT");
  });

  it("drops the surrender button when the ruleset forbids it", () => {
    const question = QUESTIONS[0];
    expect(question).toBeDefined();
    if (!question) return;
    expect(
      drillLegalActions({ ...ARC_STANDARD_RULES, lateSurrenderAllowed: false }, question.state),
    ).not.toContain("SURRENDER");
  });
});

describe("cells two cards cannot make are skipped, not faked", () => {
  it("has no question for hard 4, hard 20 or hard 21", () => {
    // 4 is 2,2 and 20 is 10,10 — both pairs. 21 in two cards is a natural.
    expect(twoCardValuesFor("hard", 4)).toBeNull();
    expect(twoCardValuesFor("hard", 20)).toBeNull();
    expect(twoCardValuesFor("hard", 21)).toBeNull();
    for (const total of [4, 20, 21]) {
      expect(
        QUESTIONS.some(
          (question) => question.handClass === "hard" && question.state.playerTotal === total,
        ),
      ).toBe(false);
    }
  });

  it("has no question for soft 12 or soft 21", () => {
    // Soft 12 is A,A (a pair) and soft 21 is A,10 (a natural).
    expect(twoCardValuesFor("soft", 12)).toBeNull();
    expect(twoCardValuesFor("soft", 21)).toBeNull();
  });

  it("still realises every pair the table solves, aces included", () => {
    for (let value = 2; value <= 11; value++) {
      expect(twoCardValuesFor("pair", value)).toEqual([value, value]);
    }
  });

  it("keeps the cells it skips out of the bank rather than mislabelling them", () => {
    // The table is larger than the bank precisely because of those cells.
    expect(ARC_STANDARD_STRATEGY_TABLE.metadata.entryCount).toBeGreaterThan(QUESTIONS.length);
  });
});

describe("categories", () => {
  it("filters to a single hand class where one is defined", () => {
    for (const category of DRILL_CATEGORIES) {
      const subset = questionsForCategory(QUESTIONS, category.id);
      if (category.handClass === null) {
        expect(subset).toHaveLength(QUESTIONS.length);
      } else {
        expect(subset.length).toBeGreaterThan(0);
        for (const question of subset) {
          expect(question.handClass).toBe(category.handClass);
        }
      }
    }
  });

  it("partitions the bank across the three hand-class categories", () => {
    const total =
      questionsForCategory(QUESTIONS, "hard").length +
      questionsForCategory(QUESTIONS, "soft").length +
      questionsForCategory(QUESTIONS, "pairs").length;
    expect(total).toBe(QUESTIONS.length);
  });

  it("falls back to Mixed for an unknown or missing route parameter", () => {
    expect(parseDrillCategory(undefined)).toBe("mixed");
    expect(parseDrillCategory("nonsense")).toBe("mixed");
    expect(parseDrillCategory("pairs")).toBe("pairs");
  });
});

describe("grading and explanations", () => {
  function questionFor(key: string): DrillQuestion {
    const found = QUESTIONS.find((question) => question.key === key);
    if (!found) throw new Error(`No drill question for ${key}`);
    return found;
  }

  it("marks the advisor's own answer correct at zero cost", () => {
    const question = questionFor("hard:17:9");
    const verdict = gradeDrillAnswer(question, question.answer);
    expect(verdict.correct).toBe(true);
    expect(verdict.evLost).toBe(0);
  });

  it("prices a mistake from the solver's own EVs", () => {
    const question = questionFor("hard:17:9");
    const wrong: StrategyAction = question.answer === "STAND" ? "HIT" : "STAND";
    const verdict = gradeDrillAnswer(question, wrong);
    expect(verdict.correct).toBe(false);
    expect(verdict.evLost).not.toBeNull();
    expect(verdict.evLost ?? 0).toBeGreaterThan(0);
    expect(verdict.explanation).toMatch(/\d\.\d\d/);
  });

  it("explains using numbers rather than written-out prose per cell", () => {
    for (const key of ["hard:11:6", "soft:18:9", "pair:8:10"]) {
      const explanation = explainDrillQuestion(questionFor(key));
      expect(explanation).toMatch(/\d\.\d\d/);
    }
  });

  it("never reports a negative cost for a wrong answer", () => {
    for (const question of QUESTIONS) {
      for (const action of question.actions) {
        const verdict = gradeDrillAnswer(question, action);
        if (verdict.evLost !== null) expect(verdict.evLost).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

function sorted(actions: readonly string[]): string[] {
  return [...actions].sort();
}
