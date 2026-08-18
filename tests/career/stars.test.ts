/**
 * Star evaluation.
 *
 * The rule that matters most: completing a node ALWAYS earns a star, and one
 * star always unlocks the next node. Blackjack is high variance, so a player
 * can make every correct decision and still lose — if progression depended on
 * winning, the product would punish correct play, which is the opposite of what
 * it is teaching.
 *
 * Boundaries are tested exactly, because "85%" is where a floating-point
 * comparison quietly disagrees with a player counting on their fingers.
 */

import { describe, expect, it } from "vitest";

import { careerNodeBySlug, CAREER_NODES } from "../../shared/career/nodes.js";
import {
  evaluateStars,
  meetsAccuracy,
  requiredFinishingBankroll,
  unlocksNextNode,
  type CareerSessionResult,
} from "../../shared/career/stars.js";

const NODE = careerNodeBySlug("first-deal")!; // standard, 60% accuracy, finish >= 100%

function result(overrides: Partial<CareerSessionResult> = {}): CareerSessionResult {
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
    endingBankroll: 2_000,
    ...overrides,
  };
}

describe("completion always earns a star", () => {
  it("awards the completion star even when every decision was wrong", () => {
    const evaluation = evaluateStars(NODE, result({ correct: 0, unaidedCorrect: 0 }));
    expect(evaluation.completion).toBe("EARNED");
    expect(evaluation.stars).toBeGreaterThanOrEqual(1);
  });

  it("awards it even when the player lost their whole bankroll", () => {
    const evaluation = evaluateStars(
      NODE,
      result({
        completionReason: "bankroll_exhausted",
        endingBankroll: 0,
        correct: 0,
        unaidedCorrect: 0,
      }),
    );
    expect(evaluation.completion).toBe("EARNED");
    expect(evaluation.unlocksNext).toBe(true);
  });

  it("unlocks the next node on one star, so variance can never block progress", () => {
    const unlucky = evaluateStars(
      NODE,
      result({ correct: 0, unaidedCorrect: 0, endingBankroll: 10 }),
    );
    expect(unlocksNextNode(unlucky)).toBe(true);
  });

  it("awards nothing for an abandoned session", () => {
    const evaluation = evaluateStars(
      NODE,
      result({ completed: false, completionReason: "abandoned" }),
    );
    expect(evaluation.completion).not.toBe("EARNED");
    expect(evaluation.stars).toBe(0);
    expect(evaluation.unlocksNext).toBe(false);
  });
});

describe("accuracy threshold is exact at the boundary", () => {
  it("counts exactly the threshold as met", () => {
    // 6 of 10 is exactly 60%.
    expect(meetsAccuracy(6, 10, 60)).toBe(true);
    expect(meetsAccuracy(5, 10, 60)).toBe(false);
  });

  it("is exact where floating point is not", () => {
    // 0.85 is not representable; 17/20 compared as a float can fall short.
    expect(meetsAccuracy(17, 20, 85)).toBe(true);
    expect(meetsAccuracy(16, 20, 85)).toBe(false);
    // A long session where the naive comparison is most likely to drift.
    expect(meetsAccuracy(83, 100, 83)).toBe(true);
    expect(meetsAccuracy(82, 100, 83)).toBe(false);
  });

  it("returns null rather than false when nothing was measured", () => {
    // "Not measured" and "fell short" are different statements.
    expect(meetsAccuracy(0, 0, 60)).toBeNull();
  });

  it("never reports an unmeasured accuracy star as earned", () => {
    const evaluation = evaluateStars(
      NODE,
      result({ decisions: 0, correct: 0, unaidedDecisions: 0, unaidedCorrect: 0 }),
    );
    expect(evaluation.accuracy).toBe("UNMEASURED");
    expect(evaluation.accuracyPercent).toBeNull();
  });
});

describe("bankroll mastery", () => {
  it("requires the exact ceiling of the percentage", () => {
    // 105% of 2,000 is 2,100 — and the requirement must round up, never down,
    // so a player one chip short does not pass.
    expect(requiredFinishingBankroll(2_000, 105)).toBe(2_100);
    expect(requiredFinishingBankroll(2_001, 105)).toBe(Math.ceil(2_001 * 1.05));
  });

  it("earns the star at exactly the target and misses one chip below", () => {
    const target = requiredFinishingBankroll(2_000, 100)!;
    expect(evaluateStars(NODE, result({ endingBankroll: target })).mastery).toBe("EARNED");
    expect(evaluateStars(NODE, result({ endingBankroll: target - 1 })).mastery).toBe("MISSED");
  });
});

describe("three stars", () => {
  it("awards all three for a complete, accurate, profitable session", () => {
    const evaluation = evaluateStars(NODE, result({ endingBankroll: 2_500 }));
    expect(evaluation.stars).toBe(3);
    expect(evaluation.completion).toBe("EARNED");
    expect(evaluation.accuracy).toBe("EARNED");
    expect(evaluation.mastery).toBe("EARNED");
  });

  it("scores objectives independently, not as a ladder", () => {
    // Completed and profitable, but inaccurate: two stars, not one.
    const evaluation = evaluateStars(
      NODE,
      result({ correct: 3, unaidedCorrect: 3, endingBankroll: 2_500 }),
    );
    expect(evaluation.accuracy).toBe("MISSED");
    expect(evaluation.stars).toBe(2);
  });

  it("never exceeds three for any node", () => {
    for (const node of CAREER_NODES) {
      const evaluation = evaluateStars(node, {
        ...result(),
        nodeId: node.id,
        handsPlayed: node.hands ?? 0,
        decisions: 40,
        correct: 40,
        unaidedDecisions: 40,
        unaidedCorrect: 40,
        endingBankroll: 100_000,
        estimatedEvLost: 0,
      });
      expect(evaluation.stars).toBeLessThanOrEqual(3);
      expect(evaluation.stars).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("grading basis", () => {
  it("grades a hint-revealing node on all decisions", () => {
    // First Deal runs in Learn mode: the answer is on screen, so `all` applies.
    const evaluation = evaluateStars(
      NODE,
      result({ decisions: 10, correct: 7, unaidedDecisions: 0, unaidedCorrect: 0 }),
    );
    expect(evaluation.gradedDecisions).toBe(10);
    expect(evaluation.gradedCorrect).toBe(7);
  });

  it("grades a Challenge node only on unaided decisions", () => {
    const challenge = careerNodeBySlug("hit-or-hold")!;
    const evaluation = evaluateStars(challenge, {
      ...result({ nodeId: challenge.id }),
      decisions: 12,
      correct: 12,
      unaidedDecisions: 10,
      unaidedCorrect: 5,
    });
    // Must use 5/10, not 12/12 — otherwise hinted decisions would inflate it.
    expect(evaluation.gradedDecisions).toBe(10);
    expect(evaluation.gradedCorrect).toBe(5);
    expect(evaluation.accuracyPercent).toBe(50);
  });
});
