/**
 * Career progress accumulation and drill generation.
 *
 * The property that matters most for drills: a scenario must never be presented
 * that the validated tables cannot grade. There would be no correct answer to
 * mark it against, and inventing one is exactly the guessed strategy the
 * specification forbids.
 *
 * For progress: a record of achievement must only ever improve. A worse attempt
 * cannot take away a star that was already earned.
 */

import { describe, expect, it } from "vitest";

import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";
import { adviseAction } from "../../shared/strategy/index.js";
import { CAREER_NODES, careerNodeBySlug, CAREER_RULES } from "../../shared/career/nodes.js";
import {
  chapterStars,
  emptyCareerProgress,
  isNodeUnlocked,
  nextRecommendedNode,
  progressForNode,
  recordSessionResult,
  starsForNode,
  totalStars,
} from "../../shared/career/progress.js";
import { drillLegalActions, drillPool } from "../../shared/career/drills.js";
import { evaluateStars, type CareerSessionResult } from "../../shared/career/stars.js";
import type { DrillFocus } from "../../shared/career/types.js";

const NODE = careerNodeBySlug("first-deal")!;
const AT = "2026-08-14T00:00:00.000Z";

function session(overrides: Partial<CareerSessionResult> = {}): CareerSessionResult {
  return {
    nodeId: NODE.id,
    completed: true,
    completionReason: "target_reached",
    handsPlayed: 10,
    decisions: 10,
    correct: 10,
    unaidedDecisions: 10,
    unaidedCorrect: 10,
    estimatedEvLost: 0,
    startingBankroll: 2_000,
    endingBankroll: 2_400,
    ...overrides,
  };
}

function record(progress = emptyCareerProgress(), result = session(), node = NODE) {
  return recordSessionResult(progress, node, evaluateStars(node, result), result, AT);
}

describe("progress accumulates, never regresses", () => {
  it("starts empty with nothing earned", () => {
    const progress = emptyCareerProgress();
    expect(totalStars(progress)).toBe(0);
    expect(starsForNode(progress, NODE.slug)).toBe(0);
    expect(progressForNode(progress, NODE.slug).attempts).toBe(0);
  });

  it("keeps the best star count when a later attempt goes worse", () => {
    const great = record();
    expect(starsForNode(great, NODE.slug)).toBe(3);

    // A disastrous replay: completed, but inaccurate and broke.
    const poor = record(
      great,
      session({ correct: 0, unaidedCorrect: 0, endingBankroll: 0 }),
    );
    expect(starsForNode(poor, NODE.slug)).toBe(3);
    expect(progressForNode(poor, NODE.slug).attempts).toBe(2);
  });

  it("keeps the best accuracy and best finish", () => {
    const first = record(emptyCareerProgress(), session({ correct: 7, unaidedCorrect: 7, endingBankroll: 2_100 }));
    const second = record(first, session({ correct: 5, unaidedCorrect: 5, endingBankroll: 1_000 }));

    const best = progressForNode(second, NODE.slug);
    expect(best.bestAccuracyPercent).toBe(70);
    expect(best.bestEndingBankroll).toBe(2_100);
  });

  it("counts an abandoned attempt without awarding anything", () => {
    const progress = record(
      emptyCareerProgress(),
      session({ completed: false, completionReason: "abandoned" }),
    );
    expect(starsForNode(progress, NODE.slug)).toBe(0);
    expect(progressForNode(progress, NODE.slug).attempts).toBe(1);
  });
});

describe("unlocking", () => {
  it("unlocks only the first node on a fresh profile", () => {
    const progress = emptyCareerProgress();
    expect(isNodeUnlocked(progress, CAREER_NODES[0]!)).toBe(true);
    expect(isNodeUnlocked(progress, CAREER_NODES[1]!)).toBe(false);
  });

  it("opens the next node on a single star, however badly it went", () => {
    const barely = record(
      emptyCareerProgress(),
      session({ correct: 0, unaidedCorrect: 0, endingBankroll: 1 }),
    );
    expect(starsForNode(barely, NODE.slug)).toBe(1);
    expect(isNodeUnlocked(barely, CAREER_NODES[1]!)).toBe(true);
  });

  it("recommends the first unfinished node", () => {
    expect(nextRecommendedNode(emptyCareerProgress())?.id).toBe("F1");
    expect(nextRecommendedNode(record())?.id).toBe("F2");
  });

  it("totals stars across the profile and per chapter", () => {
    const progress = record();
    expect(totalStars(progress)).toBe(3);

    // Returns earned AND available, so a UI can render "3/18" without
    // recomputing the denominator (and getting it wrong).
    expect(chapterStars(progress, "foundations")).toEqual({ earned: 3, available: 18 });
    expect(chapterStars(progress, "skyline")).toEqual({ earned: 0, available: 18 });
  });
});

describe("drill generation", () => {
  const FOCUSES: DrillFocus[] = ["double", "pair", "surrender", "soft", "split", "mixed"];

  it.each(FOCUSES)("produces a non-empty pool for %s", (focus) => {
    expect(drillPool(CAREER_RULES, focus).length).toBeGreaterThan(0);
  });

  it("never generates a scenario the strategy tables cannot grade", () => {
    // The load-bearing property: an ungradeable question has no correct answer,
    // and marking it against a guess is exactly what the spec forbids.
    for (const focus of FOCUSES) {
      for (const scenario of drillPool(CAREER_RULES, focus)) {
        const advice = adviseAction({
          rules: CAREER_RULES,
          state: scenario.state,
          legalActions: scenario.legalActions,
        });
        expect(advice, `${focus} · ${scenario.key} is ungradeable`).not.toBeNull();
        // And the answer must be something the player can actually pick.
        expect(scenario.legalActions).toContain(advice!.action);
      }
    }
  });

  it("gives every scenario a unique key within its pool", () => {
    for (const focus of FOCUSES) {
      const keys = drillPool(CAREER_RULES, focus).map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("builds scenarios from two real cards with a real upcard", () => {
    for (const scenario of drillPool(CAREER_RULES, "mixed")) {
      expect(scenario.playerCards.length).toBeGreaterThanOrEqual(2);
      expect(scenario.dealerUpcard.rank).toBeTruthy();
      expect(scenario.handLabel).toBeTruthy();
      expect(scenario.upcardLabel).toBeTruthy();
    }
  });

  it("focuses each pool on its decision family", () => {
    for (const scenario of drillPool(CAREER_RULES, "pair")) {
      expect(scenario.state.handClass).toBe("pair");
    }
    for (const scenario of drillPool(CAREER_RULES, "soft")) {
      expect(scenario.state.handClass).toBe("soft");
    }
  });

  it("offers hit and stand on every two-card scenario", () => {
    for (const scenario of drillPool(CAREER_RULES, "mixed")) {
      expect(scenario.legalActions).toContain("HIT");
      expect(scenario.legalActions).toContain("STAND");
    }
  });

  it("derives legality from the ruleset rather than assuming it", () => {
    const [scenario] = drillPool(CAREER_RULES, "surrender");
    expect(scenario).toBeDefined();

    const withSurrender = drillLegalActions(
      CAREER_RULES,
      [...scenario!.playerCards],
      scenario!.dealerUpcard,
    );
    const withoutSurrender = drillLegalActions(
      { ...ARC_STANDARD_RULES, lateSurrenderAllowed: false },
      [...scenario!.playerCards],
      scenario!.dealerUpcard,
    );

    expect(withSurrender).toContain("SURRENDER");
    expect(withoutSurrender).not.toContain("SURRENDER");
  });
});
