/**
 * Arc 21 — Decision Drill sessions.
 *
 * The screens own rendering; this module owns everything a session actually
 * decides — which question comes next, what a category's pool contains, and what
 * the running score says. All pure, so `tests/learn/drill-session.test.ts` can
 * prove the properties that matter without mounting a React tree:
 *
 *   - a question is never presented that `adviseAction` cannot grade, because
 *     every pool is a subset of the already-validated question bank;
 *   - "My mistakes" is exactly the keys the player has missed, and is *empty*
 *     rather than quietly falling back to everything — an empty mistakes list is
 *     a real state and pretending otherwise would fake the category;
 *   - accuracy is null until something has been answered, never a zero standing
 *     in for "no data".
 *
 * Randomness is injected as a `roll` in [0, 1) rather than drawn here, so the
 * app can supply the CSPRNG (`random.ts`) and tests can supply a fixture.
 *
 * Runtime-neutral: no React, no React Native, no Expo.
 */

import {
  drillCategory,
  questionsForCategory,
  type DrillCategory,
  type DrillQuestion,
} from "./drill-questions.js";
import { selectWeighted, type DrillHistory } from "./spaced-repetition.js";

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

/**
 * The questions a category can ask.
 *
 * Every branch filters the validated bank; nothing constructs a question here.
 * That is what makes "a pool can only hold gradeable questions" a property of
 * the type rather than a claim in a comment.
 */
export function drillPoolFor(
  questions: readonly DrillQuestion[],
  category: DrillCategory,
  history: DrillHistory,
): DrillQuestion[] {
  if (category === "mistakes") {
    return questions.filter((question) => (history[question.key]?.timesWrong ?? 0) > 0);
  }
  return questionsForCategory(questions, category);
}

// ---------------------------------------------------------------------------
// Per-category progress
// ---------------------------------------------------------------------------

export interface DrillCategorySummary {
  id: DrillCategory;
  label: string;
  blurb: string;
  /** How many distinct questions the category can ask right now. */
  poolSize: number;
  /** Answers recorded against keys in this pool. */
  answered: number;
  correct: number;
  /** 0..1, or null when nothing in this pool has been answered yet. */
  accuracy: number | null;
  /** Distinct keys in this pool currently carrying at least one miss. */
  outstanding: number;
  /** False when the pool is empty — "My mistakes" before any mistake exists. */
  startable: boolean;
}

/**
 * Progress for one category.
 *
 * Accuracy is measured over this category's own keys, not over everything: a
 * player who is perfect on hard totals and lost on pairs should see exactly
 * that, and a single global percentage would hide it.
 */
export function summariseCategory(
  questions: readonly DrillQuestion[],
  category: DrillCategory,
  history: DrillHistory,
): DrillCategorySummary {
  const definition = drillCategory(category);
  const pool = drillPoolFor(questions, category, history);

  let answered = 0;
  let correct = 0;
  let outstanding = 0;

  for (const question of pool) {
    const record = history[question.key];
    if (record === undefined) continue;
    answered += record.timesRight + record.timesWrong;
    correct += record.timesRight;
    if (record.timesWrong > 0) outstanding++;
  }

  return {
    id: category,
    label: definition.label,
    blurb: definition.blurb,
    poolSize: pool.length,
    answered,
    correct,
    accuracy: answered > 0 ? correct / answered : null,
    outstanding,
    startable: pool.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Choosing the next question
// ---------------------------------------------------------------------------

export interface NextQuestionOptions {
  pool: readonly DrillQuestion[];
  history: DrillHistory;
  /** Epoch ms. Passed in so the weighting stays testable without a clock. */
  now: number;
  /** A value in [0, 1). */
  roll: number;
  /** The question just answered, avoided when the pool has an alternative. */
  excludeKey?: string | null;
}

/**
 * The next question, weighted by the spaced-repetition schedule.
 *
 * Returns null for an empty pool rather than throwing: "My mistakes" is legitimately
 * empty for a player who has not made one, and that is a screen state, not a crash.
 */
export function nextDrillQuestion(options: NextQuestionOptions): DrillQuestion | null {
  return selectWeighted({
    items: options.pool,
    keyOf: (question) => question.key,
    history: options.history,
    now: options.now,
    roll: options.roll,
    excludeKey: options.excludeKey ?? null,
  });
}

// ---------------------------------------------------------------------------
// Running score
// ---------------------------------------------------------------------------

export interface DrillScore {
  asked: number;
  correct: number;
  /** Consecutive correct answers, reset by a miss. */
  streak: number;
  /** Longest streak this session. */
  bestStreak: number;
}

export const EMPTY_SCORE: DrillScore = Object.freeze({
  asked: 0,
  correct: 0,
  streak: 0,
  bestStreak: 0,
});

/** Folds one graded answer into the running score. Pure. */
export function scoreAnswer(score: DrillScore, correct: boolean): DrillScore {
  const streak = correct ? score.streak + 1 : 0;
  return {
    asked: score.asked + 1,
    correct: score.correct + (correct ? 1 : 0),
    streak,
    bestStreak: Math.max(score.bestStreak, streak),
  };
}

/** 0..100, or null before anything has been answered. Never a fabricated zero. */
export function scorePercent(score: DrillScore): number | null {
  if (score.asked === 0) return null;
  return Math.round((score.correct / score.asked) * 100);
}

/** "7 of 9 correct" — stated as a count, because a percentage of 3 is noise. */
export function describeScore(score: DrillScore): string {
  if (score.asked === 0) return "No answers yet";
  return `${score.correct} of ${score.asked} correct`;
}
