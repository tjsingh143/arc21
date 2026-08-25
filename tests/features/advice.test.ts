/**
 * THE ADVICE BRIDGE, INCLUDING THE PARTS NOTHING WAS EXERCISING.
 *
 * `computeAdvice` is well covered through the table and the store. Three things
 * beside it were not, and each is load-bearing in a way that fails quietly:
 *
 *   - `adviceDiagnosticKey` is the identity the table's recording effect is
 *     keyed on. If it were unstable across renders, every re-render would count
 *     a fresh occurrence of the same hole and the count would measure React
 *     rather than the tables. If it collapsed two different holes together, the
 *     second would never be recorded at all.
 *   - the early returns in `computeAdvice` are the fail-safe path. "No advice"
 *     has to be reachable for a settled hand, a hand that is not the active one
 *     and a dealer with no upcard — none of which is a bug, all of which would
 *     be a bug if they produced a recommendation.
 *   - the formatters decide what a player reads. `-0.00` rendering as a loss
 *     and a probability rounding the wrong way are both wrong on screen and
 *     invisible in a type check.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  actionLabel,
  adviceDiagnosticKey,
  computeAdvice,
  explainRecommendation,
  format,
  formatMagnitude,
  formatProbability,
  gradeDecision,
  NO_ADVICE,
  recordAdviceDiagnostic,
} from "../../src/features/practice/advice.js";
import {
  resetStrategyDiagnostics,
  strategyDiagnosticCount,
  strategyDiagnostics,
} from "../../src/features/practice/strategy-diagnostics.js";
import type { StrategyDiagnostic } from "../../shared/strategy/index.js";
import { getLegalActions } from "../../shared/blackjack/legal-actions.js";
import { betAndDeal, harness } from "../helpers/engine-harness.js";

beforeEach(() => {
  resetStrategyDiagnostics();
});

/** A real, live decision: hard 16 against a dealer ten. */
function liveTable() {
  const table = betAndDeal(harness({ shoe: "10S 10C 6H 7D 5C 4D" }), 100);
  return {
    table,
    advice: computeAdvice(table.state, table.seat("s1"), getLegalActions(table.state, "s1").actions),
  };
}

// ---------------------------------------------------------------------------

describe("no advice is offered where there is no decision", () => {
  it("says nothing before the cards are out", () => {
    const table = harness({ shoe: "10S 10C 6H 7D" });
    const advice = computeAdvice(table.state, table.seat("s1"), []);
    expect(advice).toBe(NO_ADVICE);
    expect(advice.recommendation).toBeNull();
    expect(advice.probabilities).toBeNull();
    expect(advice.diagnostic).toBeNull();
  });

  it("says nothing once the hand is no longer active", () => {
    const table = betAndDeal(harness({ shoe: "10S 10C 6H 7D 5C" }), 100).send({ type: "STAND", seatId: "s1" });
    const advice = computeAdvice(table.state, table.seat("s1"), []);
    expect(advice.recommendation).toBeNull();
  });

  it("says nothing when the dealer has no upcard to read", () => {
    const { table } = liveTable();
    const noUpcard = { ...table.state, dealer: { ...table.state.dealer, cards: [] } };
    const advice = computeAdvice(noUpcard, table.seat("s1"), ["HIT", "STAND"]);
    expect(advice).toBe(NO_ADVICE);
  });

  it("is a shared frozen value, so a caller cannot corrupt the next silence", () => {
    expect(NO_ADVICE.evs).toEqual([]);
    const table = harness({ shoe: "10S 10C 6H 7D" });
    expect(computeAdvice(table.state, table.seat("s1"), [])).toBe(NO_ADVICE);
  });
});

// ---------------------------------------------------------------------------

describe("the diagnostic key", () => {
  it("is null when there is nothing wrong", () => {
    const { advice } = liveTable();
    expect(advice.diagnostic).toBeNull();
    expect(adviceDiagnosticKey(advice)).toBeNull();
  });

  it("is stable for the same hole, so a re-render is not a second sighting", () => {
    const withHole = {
      ...NO_ADVICE,
      diagnostic: {
        code: "NO_ENTRY" as const,
        message: "no entry",
        key: "hard:16:10",
        rulesetId: "arc-standard",
        rulesetVersion: 1,
      },
    };
    // Two independently constructed advice objects describing one hole.
    const again = { ...withHole, diagnostic: { ...withHole.diagnostic } };
    expect(adviceDiagnosticKey(withHole)).toBe(adviceDiagnosticKey(again));
    expect(adviceDiagnosticKey(withHole)).toBe("arc-standard@1|NO_ENTRY|hard:16:10");
  });

  it("separates holes that differ in code, coordinate or ruleset", () => {
    const base: StrategyDiagnostic = {
      code: "NO_ENTRY",
      message: "",
      key: "hard:16:10",
      rulesetId: "arc-standard",
      rulesetVersion: 1,
    };
    const keyOf = (patch: Partial<typeof base>) =>
      adviceDiagnosticKey({ ...NO_ADVICE, diagnostic: { ...base, ...patch } });

    const keys = new Set([
      keyOf({}),
      keyOf({ code: "NO_TABLE" }),
      keyOf({ key: "soft:18:9" }),
      keyOf({ rulesetId: "vegas" }),
      keyOf({ rulesetVersion: 2 }),
    ]);
    expect(keys.size).toBe(5);
  });

  it("renders a missing coordinate as a placeholder rather than as undefined", () => {
    const key = adviceDiagnosticKey({
      ...NO_ADVICE,
      diagnostic: {
        code: "INVALID_STATE",
        message: "",
        key: null,
        rulesetId: "arc-standard",
        rulesetVersion: 1,
      },
    });
    expect(key).toBe("arc-standard@1|INVALID_STATE|-");
    expect(key).not.toContain("undefined");
    expect(key).not.toContain("null");
  });
});

describe("recording a diagnostic", () => {
  it("does nothing at all for advice that succeeded", () => {
    const { advice } = liveTable();
    recordAdviceDiagnostic(advice);
    expect(strategyDiagnosticCount()).toBe(0);
  });

  it("records the reason when there is one", () => {
    recordAdviceDiagnostic({
      ...NO_ADVICE,
      diagnostic: {
        code: "RULES_MISMATCH",
        message: "",
        key: "hard:16:10",
        rulesetId: "arc-standard",
        rulesetVersion: 1,
      },
    });
    const all = strategyDiagnostics();
    expect(all).toHaveLength(1);
    expect(all[0]!.code).toBe("RULES_MISMATCH");
    expect(all[0]!.key).toBe("hard:16:10");
  });
});

// ---------------------------------------------------------------------------

describe("grading a decision", () => {
  it("returns nothing when the tables had no opinion, so accuracy cannot move", () => {
    expect(gradeDecision(NO_ADVICE, "HIT")).toBeNull();
  });

  it("costs nothing for the recommended play", () => {
    const { advice } = liveTable();
    const verdict = gradeDecision(advice, advice.recommendation!.action);
    expect(verdict?.correct).toBe(true);
    expect(verdict?.evLost).toBe(0);
  });

  it("never reports a negative cost", () => {
    const { advice } = liveTable();
    for (const action of ["HIT", "STAND", "DOUBLE", "SURRENDER"] as const) {
      const verdict = gradeDecision(advice, action);
      if (verdict?.evLost !== null && verdict?.evLost !== undefined) {
        expect(verdict.evLost, action).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("explaining a recommendation", () => {
  it("says nothing when there is nothing to explain", () => {
    expect(explainRecommendation(NO_ADVICE)).toBeNull();
  });

  it("compares the best two priced actions", () => {
    const { advice } = liveTable();
    const text = explainRecommendation(advice)!;
    expect(text).toMatch(/averages/);
    expect(text).toMatch(/against/);
  });

  it("falls back to a plain sentence when fewer than two actions are priced", () => {
    // A cell can legitimately price only one action. The explanation must still
    // be a sentence about this hand rather than a comparison with nothing.
    const { advice } = liveTable();
    const thin = { ...advice, evs: advice.evs.slice(0, 1) };
    const text = explainRecommendation(thin)!;
    expect(text).toContain(advice.handLabel!);
    expect(text).toContain(advice.upcardLabel!);
    expect(text).not.toMatch(/against .*for/);
  });

  it("has a verb for every action it can recommend", () => {
    // `verb()` is a switch with no default; a new action would fall through it
    // silently. Every label is exercised here so that cannot happen unnoticed.
    const { advice } = liveTable();
    for (const action of ["HIT", "STAND", "DOUBLE", "SPLIT", "SURRENDER"] as const) {
      const text = explainRecommendation({
        ...advice,
        evs: [{ action, ev: 0.1 }],
        recommendation: { ...advice.recommendation!, action },
      })!;
      expect(text, action).toMatch(/^(Hitting|Standing|Doubling|Splitting|Surrendering)/);
    }
  });
});

// ---------------------------------------------------------------------------

describe("the formatters decide what a player reads", () => {
  it("signs an expected value and never renders a minus zero", () => {
    expect(format(0.1234)).toBe("+0.12");
    expect(format(-0.5)).toBe("−0.50");
    expect(format(0)).toBe("0.00");
    // -0.001 rounds to zero: it must not read as a loss.
    expect(format(-0.001)).toBe("0.00");
    expect(format(-0.001)).not.toContain("−");
  });

  it("uses a true minus sign rather than a hyphen", () => {
    expect(format(-0.5)).toContain("−");
    expect(format(-0.5)).not.toContain("-");
  });

  it("drops the sign where the surrounding words already carry it", () => {
    expect(formatMagnitude(-0.164)).toBe("0.16");
    expect(formatMagnitude(0.164)).toBe("0.16");
  });

  it("renders a probability as a whole percent", () => {
    expect(formatProbability(0)).toBe("0%");
    expect(formatProbability(1)).toBe("100%");
    expect(formatProbability(0.61165)).toBe("61%");
    // Rounds rather than truncates: 0.615 is nearer 62 than 61.
    expect(formatProbability(0.615)).toBe("62%");
    expect(formatProbability(0.2301)).toBe("23%");
  });

  it("labels an action in words", () => {
    expect(actionLabel("HIT")).toBe("Hit");
    expect(actionLabel("SURRENDER")).toBe("Surrender");
  });
});
