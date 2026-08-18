/**
 * Table advice — the bridge from authoritative game state to the validated
 * strategy tables.
 *
 * The property that matters most here is the fail-safe: when the tables cannot
 * answer, the advisor must stay silent rather than guess. A confidently wrong
 * recommendation in a teaching product is worse than no recommendation at all.
 */

import { describe, expect, it } from "vitest";

import { getLegalActions } from "../../shared/blackjack/legal-actions.js";
import {
  computeAdvice,
  explainRecommendation,
  format,
  formatMagnitude,
  gradeDecision,
  actionLabel,
} from "../../src/features/practice/advice.js";
import { betAndDeal, harness } from "../helpers/engine-harness.js";

function adviceFor(shoe: string, bet = 100) {
  const h = betAndDeal(harness({ shoe }), bet);
  const seat = h.seat();
  const legal = getLegalActions(h.state, "s1");
  return { h, advice: computeAdvice(h.state, seat, legal.actions), legal };
}

describe("advice derivation", () => {
  it("advises standing on hard 17 against a 9", () => {
    // Player 10+7, dealer 9 up.
    const { advice } = adviceFor("10S 9D 7H 5C");
    expect(advice.handLabel).toBe("Hard 17");
    expect(advice.upcardLabel).toBe("9");
    expect(advice.recommendation?.action).toBe("STAND");
  });

  it("advises hitting hard 16 against a 7", () => {
    const { advice } = adviceFor("10S 7D 6H 5C");
    expect(advice.handLabel).toBe("Hard 16");
    expect(advice.recommendation?.action).toBe("HIT");
  });

  it("advises splitting eights against a 7", () => {
    const { advice } = adviceFor("8S 7D 8H 5C");
    expect(advice.handLabel).toBe("8,8");
    expect(advice.recommendation?.action).toBe("SPLIT");
  });

  it("advises standing on a pair of tens rather than splitting", () => {
    // Legal to split under the equal-value policy; strategy still says stand.
    const { advice, legal } = adviceFor("KS 6D QH 5C");
    expect(legal.actions).toContain("SPLIT");
    expect(advice.recommendation?.action).toBe("STAND");
  });

  it("advises doubling eleven against a 6", () => {
    const { advice } = adviceFor("6S 6D 5H 5C");
    expect(advice.handLabel).toBe("Hard 11");
    expect(advice.recommendation?.action).toBe("DOUBLE");
  });

  it("advises surrendering 16 against a 10", () => {
    const { advice } = adviceFor("10S 10D 6H 5C");
    expect(advice.handLabel).toBe("Hard 16");
    expect(advice.recommendation?.action).toBe("SURRENDER");
  });

  it("classifies soft hands correctly", () => {
    // A,7 is soft 18 — a classic off-by-one if the classifier is wrong.
    const { advice } = adviceFor("AS 3D 7H 5C");
    expect(advice.handLabel).toBe("Soft 18");
  });
});

describe("legality is respected", () => {
  it("never recommends an action the engine would reject", () => {
    // After hitting, DOUBLE and SURRENDER are gone; advice must adapt.
    const h = betAndDeal(harness({ shoe: "6S 6D 5H 5C 2D 9H 4S" }), 100).send({
      type: "HIT",
      seatId: "s1",
    });
    const legal = getLegalActions(h.state, "s1");
    const advice = computeAdvice(h.state, h.seat(), legal.actions);

    expect(legal.actions).not.toContain("DOUBLE");
    if (advice.recommendation) {
      expect(legal.actions).toContain(advice.recommendation.action);
    }
  });

  it("falls back to a legal action when doubling is unaffordable", () => {
    // Eleven vs 6 wants DOUBLE, but the stack cannot cover a second wager.
    const h = betAndDeal(
      harness({
        shoe: "6S 6D 5H 5C 9D",
        seats: [{ seatId: "s1", displayName: "T", stack: 150 }],
      }),
      100,
    );
    const legal = getLegalActions(h.state, "s1");
    const advice = computeAdvice(h.state, h.seat(), legal.actions);

    expect(legal.actions).not.toContain("DOUBLE");
    expect(advice.recommendation?.action).toBe("HIT");
    expect(advice.recommendation?.usedFallback).toBe(true);
  });

  it("prices only the legal actions", () => {
    const { advice, legal } = adviceFor("6S 6D 5H 5C");
    for (const entry of advice.evs) {
      expect(legal.actions).toContain(entry.action);
    }
  });

  it("orders EVs best first", () => {
    const { advice } = adviceFor("10S 9D 7H 5C");
    const evs = advice.evs.map((entry) => entry.ev);
    expect([...evs].sort((a, b) => b - a)).toEqual(evs);
  });
});

describe("fail-safe silence", () => {
  it("says nothing during betting", () => {
    const h = harness({ shoe: "10S 9D 7H 5C" });
    const advice = computeAdvice(h.state, h.seat(), []);
    expect(advice.recommendation).toBeNull();
    expect(advice.handLabel).toBeNull();
  });

  it("says nothing once the hand is settled", () => {
    // Player natural: resolved during the deal, no decision to advise.
    const h = betAndDeal(harness({ shoe: "AS 7D KH 9C" }), 100);
    expect(h.state.phase).toBe("HAND_COMPLETE");
    const advice = computeAdvice(h.state, h.seat(), []);
    expect(advice.recommendation).toBeNull();
  });

  it("never reads the dealer hole card", () => {
    // Identical upcards with wildly different hole cards must produce identical
    // advice. If the hole card ever leaked into the model, these would differ.
    const withLowHole = adviceFor("10S 7D 6H 2C").advice;
    const withTenHole = adviceFor("10S 7D 6H KC").advice;

    expect(withLowHole.recommendation?.action).toBe(withTenHole.recommendation?.action);
    expect(withLowHole.evs).toEqual(withTenHole.evs);
  });
});

describe("grading", () => {
  it("marks the recommended action correct with zero EV lost", () => {
    const { advice } = adviceFor("10S 9D 7H 5C");
    const verdict = gradeDecision(advice, "STAND");
    expect(verdict?.correct).toBe(true);
    expect(verdict?.evLost).toBe(0);
  });

  it("prices the cost of a mistake", () => {
    const { advice } = adviceFor("10S 9D 7H 5C");
    const verdict = gradeDecision(advice, "HIT");
    expect(verdict?.correct).toBe(false);
    expect(verdict?.evLost).toBeGreaterThan(0);
  });

  it("returns null when there is nothing to grade, so accuracy cannot move", () => {
    const h = harness({ shoe: "10S 9D 7H 5C" });
    const advice = computeAdvice(h.state, h.seat(), []);
    expect(gradeDecision(advice, "HIT")).toBeNull();
  });
});

describe("presentation", () => {
  it("formats EVs to two decimals with a true minus sign", () => {
    expect(format(-0.1449)).toBe("−0.14");
    expect(format(0.1899)).toBe("+0.19");
    expect(format(0)).toBe("0.00");
    // Never render "-0.00", which reads as a real negative.
    expect(format(-0.001)).toBe("0.00");
  });

  it("explains a recommendation using the solver's own numbers", () => {
    const { advice } = adviceFor("10S 9D 7H 5C");
    const explanation = explainRecommendation(advice);
    expect(explanation).toContain("standing");
    expect(explanation).toMatch(/−?\d\.\d\d/);
  });

  it("labels actions for display", () => {
    expect(actionLabel("HIT")).toBe("Hit");
    expect(actionLabel("SURRENDER")).toBe("Surrender");
  });

  it("renders a cost without a sign, since the surrounding words carry it", () => {
    // "Costs about +0.16 of a bet" reads as a gain. The magnitude must be bare.
    expect(formatMagnitude(0.1638)).toBe("0.16");
    expect(formatMagnitude(-0.1638)).toBe("0.16");
    expect(formatMagnitude(0)).toBe("0.00");
  });
});
