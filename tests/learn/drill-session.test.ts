/**
 * Drill sessions.
 *
 * The guard this file exists for is the one the specification names first: **an
 * ungradeable question must never reach a player**. That is proved here over
 * every category, for a long simulated session driven by a deterministic roll
 * sequence — not merely over the bank in the abstract, but over the questions a
 * session actually presents, one after another, the way a person meets them.
 *
 * `shared/career/drills.ts` is cross-checked against the bank in the same pass:
 * every scenario the shared pool builder produces must exist in the bank under
 * the same key with the same legal actions. The two independent paths to a
 * question — the shared drill pool and the Learn bank — must not disagree about
 * what is askable or what may be answered.
 */

import { describe, expect, it } from "vitest";

import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";
import { drillPool, gradeDrillDecision } from "../../shared/career/drills.js";
import type { DrillFocus } from "../../shared/career/types.js";
import { adviseAction, type StrategyAction } from "../../shared/strategy/index.js";
import {
  buildDrillQuestions,
  DRILL_CATEGORIES,
  gradeDrillAnswer,
  type DrillCategory,
} from "../../src/features/learn/drill-questions.js";
import {
  describeScore,
  drillPoolFor,
  EMPTY_SCORE,
  nextDrillQuestion,
  scoreAnswer,
  scorePercent,
  summariseCategory,
} from "../../src/features/learn/drill-session.js";
import {
  recordDrillAnswer,
  type DrillHistory,
} from "../../src/features/learn/spaced-repetition.js";

const QUESTIONS = buildDrillQuestions();
const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);
const NO_HISTORY: DrillHistory = {};

/**
 * A deterministic roll sequence in [0, 1).
 *
 * A fixed generator rather than `Math.random()` so a failure is reproducible;
 * the app supplies the CSPRNG in its place. The multiplier is a standard
 * Lehmer constant — this only needs to spread, not to be unpredictable.
 */
function rolls(seed: number): () => number {
  let state = seed % 2_147_483_647 || 1;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
}

const PLAYABLE: readonly DrillCategory[] = ["mixed", "hard", "soft", "pairs"];

// ---------------------------------------------------------------------------

describe("pools only ever contain gradeable questions", () => {
  it("draws every category's pool from the validated bank", () => {
    const bank = new Set(QUESTIONS.map((question) => question.key));
    for (const category of DRILL_CATEGORIES) {
      const history = recordDrillAnswer(NO_HISTORY, QUESTIONS[0]!.key, false, NOW);
      for (const question of drillPoolFor(QUESTIONS, category.id, history)) {
        expect(bank.has(question.key)).toBe(true);
      }
    }
  });

  it("gives every playable category something to ask", () => {
    for (const category of PLAYABLE) {
      expect(drillPoolFor(QUESTIONS, category, NO_HISTORY).length).toBeGreaterThan(0);
    }
  });

  it("keeps My mistakes empty until a mistake exists, rather than falling back", () => {
    expect(drillPoolFor(QUESTIONS, "mistakes", NO_HISTORY)).toHaveLength(0);

    const missed = QUESTIONS[7]!;
    const history = recordDrillAnswer(NO_HISTORY, missed.key, false, NOW);
    const pool = drillPoolFor(QUESTIONS, "mistakes", history);

    expect(pool.map((question) => question.key)).toEqual([missed.key]);
  });

  it("does not put a hand you only ever got right into My mistakes", () => {
    const history = recordDrillAnswer(NO_HISTORY, QUESTIONS[3]!.key, true, NOW);
    expect(drillPoolFor(QUESTIONS, "mistakes", history)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("every question a session presents can be graded", () => {
  /**
   * Plays a real session: draw, answer, record, draw again. This is the path a
   * player takes, so it is the path the guarantee has to hold on.
   */
  function play(category: DrillCategory, turns: number, seed: number) {
    const roll = rolls(seed);
    let history: DrillHistory = recordDrillAnswer(NO_HISTORY, QUESTIONS[0]!.key, false, NOW);
    let previous: string | null = null;
    let asked = 0;

    for (let turn = 0; turn < turns; turn++) {
      const pool = drillPoolFor(QUESTIONS, category, history);
      const question = nextDrillQuestion({
        pool,
        history,
        now: NOW + turn * 1_000,
        roll: roll(),
        excludeKey: previous,
      });
      expect(question).not.toBeNull();
      if (!question) break;

      // 1. The advisor answers it, and answers it the same way the bank does.
      const recommendation = adviseAction({
        rules: ARC_STANDARD_RULES,
        state: question.state,
        legalActions: [...question.actions],
      });
      expect(recommendation).not.toBeNull();
      expect(recommendation?.action).toBe(question.answer);

      // 2. The answer is a button the player is actually offered.
      expect(question.actions).toContain(question.answer);
      expect(question.actions.length).toBeGreaterThanOrEqual(2);

      // 3. Every offered button grades without throwing, and never at a
      //    negative cost.
      for (const action of question.actions) {
        const verdict = gradeDrillAnswer(question, action);
        expect(verdict.explanation.length).toBeGreaterThan(0);
        if (verdict.evLost !== null) expect(verdict.evLost).toBeGreaterThanOrEqual(0);
      }

      // Answer wrongly where possible, so the mistakes pool keeps growing.
      const wrong = question.actions.find((action) => action !== question.answer);
      const chosen: StrategyAction = turn % 3 === 0 ? question.answer : (wrong ?? question.answer);
      history = recordDrillAnswer(history, question.key, chosen === question.answer, NOW + turn * 1_000);

      previous = question.key;
      asked++;
    }

    return asked;
  }

  for (const category of DRILL_CATEGORIES) {
    it(`holds for a 120-question ${category.id} session`, () => {
      expect(play(category.id, 120, 7 + category.id.length)).toBe(120);
    });
  }

  it("never asks the same hand twice in a row when the pool has an alternative", () => {
    const roll = rolls(31);
    const pool = drillPoolFor(QUESTIONS, "mixed", NO_HISTORY);
    let previous: string | null = null;

    for (let turn = 0; turn < 200; turn++) {
      const question = nextDrillQuestion({
        pool,
        history: NO_HISTORY,
        now: NOW,
        roll: roll(),
        excludeKey: previous,
      });
      expect(question?.key).not.toBe(previous);
      previous = question?.key ?? null;
    }
  });

  it("returns null for an empty pool rather than throwing", () => {
    expect(
      nextDrillQuestion({ pool: [], history: NO_HISTORY, now: NOW, roll: 0.5 }),
    ).toBeNull();
  });

  it("still answers when the pool holds exactly the excluded question", () => {
    const only = QUESTIONS[0]!;
    const question = nextDrillQuestion({
      pool: [only],
      history: NO_HISTORY,
      now: NOW,
      roll: 0.5,
      excludeKey: only.key,
    });
    // A one-question pool cannot honour the exclusion; asking again beats
    // returning null and stalling the session on a screen with no hand.
    expect(question?.key).toBe(only.key);
  });
});

// ---------------------------------------------------------------------------

describe("the shared drill pool and the Learn bank agree", () => {
  const FOCUSES: readonly DrillFocus[] = ["mixed", "soft", "pair", "double", "surrender", "split"];

  it("finds every shared scenario in the bank, under the same key", () => {
    const bank = new Map(QUESTIONS.map((question) => [question.key, question]));

    for (const focus of FOCUSES) {
      const pool = drillPool(ARC_STANDARD_RULES, focus);
      expect(pool.length).toBeGreaterThan(0);

      for (const scenario of pool) {
        const question = bank.get(scenario.key);
        expect(question, `${focus}: ${scenario.key} missing from the bank`).toBeDefined();
        if (!question) continue;

        // The engine derived these actions from a real game state; the bank
        // derived its own from the ruleset. They must not disagree.
        expect([...question.actions].sort()).toEqual([...scenario.legalActions].sort());
      }
    }
  });

  it("marks the same answer correct from either path", () => {
    const bank = new Map(QUESTIONS.map((question) => [question.key, question]));

    for (const scenario of drillPool(ARC_STANDARD_RULES, "mixed")) {
      const question = bank.get(scenario.key);
      if (!question) continue;

      const shared = gradeDrillDecision(ARC_STANDARD_RULES, scenario, question.answer);
      expect(shared).not.toBeNull();
      expect(shared?.correct).toBe(true);
      expect(shared?.recommended).toBe(question.answer);
    }
  });
});

// ---------------------------------------------------------------------------

describe("category summaries", () => {
  it("reports null accuracy rather than a zero before anything is answered", () => {
    for (const category of DRILL_CATEGORIES) {
      const summary = summariseCategory(QUESTIONS, category.id, NO_HISTORY);
      expect(summary.accuracy).toBeNull();
      expect(summary.answered).toBe(0);
    }
  });

  it("counts only answers belonging to the category's own pool", () => {
    const hard = QUESTIONS.find((question) => question.handClass === "hard")!;
    const history = recordDrillAnswer(NO_HISTORY, hard.key, true, NOW);

    expect(summariseCategory(QUESTIONS, "hard", history).answered).toBe(1);
    expect(summariseCategory(QUESTIONS, "soft", history).answered).toBe(0);
    expect(summariseCategory(QUESTIONS, "pairs", history).answered).toBe(0);
    expect(summariseCategory(QUESTIONS, "mixed", history).answered).toBe(1);
  });

  it("computes accuracy over the answers, not over the pool size", () => {
    const pair = QUESTIONS.find((question) => question.handClass === "pair")!;
    let history = recordDrillAnswer(NO_HISTORY, pair.key, true, NOW);
    history = recordDrillAnswer(history, pair.key, true, NOW);
    history = recordDrillAnswer(history, pair.key, false, NOW);

    const summary = summariseCategory(QUESTIONS, "pairs", history);
    expect(summary.answered).toBe(3);
    expect(summary.correct).toBe(2);
    expect(summary.accuracy).toBeCloseTo(2 / 3, 10);
    expect(summary.outstanding).toBe(1);
  });

  it("reports the pool size the session will actually draw from", () => {
    for (const category of DRILL_CATEGORIES) {
      const summary = summariseCategory(QUESTIONS, category.id, NO_HISTORY);
      expect(summary.poolSize).toBe(drillPoolFor(QUESTIONS, category.id, NO_HISTORY).length);
      expect(summary.startable).toBe(summary.poolSize > 0);
    }
  });

  it("partitions the bank across the three hand-class categories", () => {
    const total = (["hard", "soft", "pairs"] as const)
      .map((category) => summariseCategory(QUESTIONS, category, NO_HISTORY).poolSize)
      .reduce((sum, size) => sum + size, 0);
    expect(total).toBe(summariseCategory(QUESTIONS, "mixed", NO_HISTORY).poolSize);
  });

  it("opens My mistakes only once a mistake exists", () => {
    expect(summariseCategory(QUESTIONS, "mistakes", NO_HISTORY).startable).toBe(false);

    const history = recordDrillAnswer(NO_HISTORY, QUESTIONS[2]!.key, false, NOW);
    const summary = summariseCategory(QUESTIONS, "mistakes", history);
    expect(summary.startable).toBe(true);
    expect(summary.poolSize).toBe(1);
    expect(summary.accuracy).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("running score", () => {
  it("starts with nothing answered and no percentage", () => {
    expect(EMPTY_SCORE.asked).toBe(0);
    expect(scorePercent(EMPTY_SCORE)).toBeNull();
    expect(describeScore(EMPTY_SCORE)).toBe("No answers yet");
  });

  it("counts answers and correct answers separately", () => {
    let score = scoreAnswer(EMPTY_SCORE, true);
    score = scoreAnswer(score, false);
    score = scoreAnswer(score, true);

    expect(score.asked).toBe(3);
    expect(score.correct).toBe(2);
    expect(scorePercent(score)).toBe(67);
    expect(describeScore(score)).toBe("2 of 3 correct");
  });

  it("tracks the current run and the best one, and a miss resets the run", () => {
    let score = EMPTY_SCORE;
    for (const correct of [true, true, true, false, true]) {
      score = scoreAnswer(score, correct);
    }
    expect(score.streak).toBe(1);
    expect(score.bestStreak).toBe(3);
  });

  it("does not mutate the score it was given", () => {
    const before = { ...EMPTY_SCORE };
    scoreAnswer(EMPTY_SCORE, true);
    expect(EMPTY_SCORE).toEqual(before);
  });
});
