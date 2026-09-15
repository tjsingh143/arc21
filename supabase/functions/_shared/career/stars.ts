/**
 * Arc 21 — career star evaluation.
 *
 * Pure. No I/O, no clock, no randomness: the same session result always yields
 * the same stars, which is what makes this testable at the boundaries and what
 * will let the future server recompute a client's claim rather than trust it.
 *
 * THE RULE THAT MATTERS MOST
 *
 * One star is ALWAYS awarded for completing a node, and one star is all that is
 * needed to unlock the next one. Blackjack is variance-dominated in the short
 * run: a player can make every correct decision across twenty hands and still
 * finish down. A progression gate tied to winning would therefore be a gate
 * tied to luck, and a player could be walled out of the rest of the product by
 * cards they had no influence over. That is not acceptable, so completion —
 * including running out of chips — is sufficient to move on. The second and
 * third stars are the achievement; the first is the receipt.
 *
 * BOUNDARIES
 *
 * Accuracy is compared as integers: `correct * 100 >= percent * decisions`.
 * A session that lands on exactly the threshold earns the star. Comparing
 * `correct / decisions >= percent / 100` would let binary floating point decide
 * a milestone (0.85 is not representable, and 17/20 >= 0.85 happens to hold
 * while other exact-looking pairs do not).
 *
 * ZERO DECISIONS
 *
 * A session can settle every hand without ever presenting a gradeable decision
 * — deal a natural, deal a bust-proof twenty, take the automatic path. Accuracy
 * is then undefined, not perfect. Awarding a star for 0/0 would hand out the
 * accuracy star for playing no blackjack at all, so it is reported as
 * UNMEASURED and not awarded. That never blocks anyone: completion already
 * unlocked the next node.
 */

import type { CareerNode } from "./types.ts";

/** Why a session stopped. All three are terminal; only one is not a completion. */
export type CareerCompletionReason =
  /** The node's hand or decision target was reached. */
  | "target_reached"
  /** The session bankroll fell below the table minimum. Still a completion. */
  | "bankroll_exhausted"
  /** The player left before finishing. Not a completion; no stars. */
  | "abandoned";

/**
 * Everything star evaluation is allowed to see.
 *
 * Deliberately narrow: it holds no engine state, so nothing here can be
 * accidentally decided by the shoe, the dealer's hole card, or how a hand felt.
 */
export interface CareerSessionResult {
  /** `CareerNode.id`, e.g. "F3". */
  readonly nodeId: string;
  readonly completed: boolean;
  readonly completionReason: CareerCompletionReason;

  readonly handsPlayed: number;
  /** Decisions the strategy tables could actually adjudicate. */
  readonly decisions: number;
  readonly correct: number;
  /** Decisions made without the recommended play on screen. */
  readonly unaidedDecisions: number;
  readonly unaidedCorrect: number;
  /** Total expectation given up, in units of the original wager. Never negative. */
  readonly estimatedEvLost: number;

  readonly startingBankroll: number;
  readonly endingBankroll: number;
}

export type StarStatus =
  | "EARNED"
  /** Measurable, and the player did not reach it. */
  | "MISSED"
  /** Not measurable from this session. Never counted as earned. */
  | "UNMEASURED";

export type StarCount = 0 | 1 | 2 | 3;

export interface StarEvaluation {
  /**
   * How many of the three objectives were met.
   *
   * This is a COUNT, not a ladder: the objectives are independent, so a session
   * that completes and hits its bankroll target but misses accuracy scores two.
   * The per-objective statuses below are the truth; the count is the summary,
   * and the UI shows both so the number can never overstate what happened.
   */
  readonly stars: StarCount;
  readonly completion: StarStatus;
  readonly accuracy: StarStatus;
  readonly mastery: StarStatus;

  /** Whole-percent accuracy on the node's basis, or null when unmeasurable. */
  readonly accuracyPercent: number | null;
  readonly gradedDecisions: number;
  readonly gradedCorrect: number;

  /** Chips needed for the bankroll star, or null when the node has no such star. */
  readonly requiredFinishingBankroll: number | null;

  /** True when this result opens the next node. Completion alone is enough. */
  readonly unlocksNext: boolean;
}

/**
 * Whether an accuracy threshold is met, in exact integer arithmetic.
 *
 * Returns null when there is nothing to measure. Callers must not read that as
 * "false" for display purposes — "you have not been measured" and "you fell
 * short" are different statements and the UI says different things about them.
 */
export function meetsAccuracy(
  correct: number,
  decisions: number,
  thresholdPercent: number,
): boolean | null {
  if (decisions <= 0) return null;
  return correct * 100 >= thresholdPercent * decisions;
}

/**
 * Chips required to satisfy a "finish at N% of the starting bankroll" star.
 *
 * Ceiling, not rounding: 105% of 1,999 chips is 2,098.95, and a player holding
 * 2,098 has not reached 105%. Money is integer chips, so the requirement must
 * be an integer the player can actually hold.
 */
export function requiredFinishingBankroll(
  startingBankroll: number,
  percentOfStart: number,
): number {
  return Math.ceil((startingBankroll * percentOfStart) / 100);
}

/** The decisions a node grades on, per its `accuracyBasis`. */
export function gradedDecisionsFor(
  node: CareerNode,
  result: CareerSessionResult,
): { decisions: number; correct: number } {
  return node.accuracyBasis === "unaided"
    ? { decisions: result.unaidedDecisions, correct: result.unaidedCorrect }
    : { decisions: result.decisions, correct: result.correct };
}

/**
 * Awards stars for one completed attempt.
 *
 * `node` and `result` must refer to the same node; a mismatch is a programming
 * error and throws rather than silently grading against the wrong thresholds.
 */
export function evaluateStars(node: CareerNode, result: CareerSessionResult): StarEvaluation {
  if (node.id !== result.nodeId) {
    throw new Error(
      `Star evaluation mismatch: node "${node.id}" was given a result for "${result.nodeId}"`,
    );
  }

  const graded = gradedDecisionsFor(node, result);
  const accuracyPercent =
    graded.decisions > 0 ? Math.floor((graded.correct * 100) / graded.decisions) : null;

  const bankrollTarget =
    node.mastery.kind === "finish_bankroll"
      ? requiredFinishingBankroll(result.startingBankroll, node.mastery.percentOfStart)
      : null;

  // An abandoned attempt scores nothing at all. It is not a failure to be
  // graded — it is an attempt that never produced a result to grade.
  if (!result.completed) {
    return {
      stars: 0,
      completion: "MISSED",
      accuracy: "MISSED",
      mastery: "MISSED",
      accuracyPercent,
      gradedDecisions: graded.decisions,
      gradedCorrect: graded.correct,
      requiredFinishingBankroll: bankrollTarget,
      unlocksNext: false,
    };
  }

  const accuracy = statusFor(
    meetsAccuracy(graded.correct, graded.decisions, node.accuracyStarPercent),
  );

  const mastery = statusFor(masteryMet(node, result, graded, bankrollTarget));

  const stars = (1 +
    (accuracy === "EARNED" ? 1 : 0) +
    (mastery === "EARNED" ? 1 : 0)) as StarCount;

  return {
    stars,
    completion: "EARNED",
    accuracy,
    mastery,
    accuracyPercent,
    gradedDecisions: graded.decisions,
    gradedCorrect: graded.correct,
    requiredFinishingBankroll: bankrollTarget,
    unlocksNext: true,
  };
}

function statusFor(met: boolean | null): StarStatus {
  if (met === null) return "UNMEASURED";
  return met ? "EARNED" : "MISSED";
}

function masteryMet(
  node: CareerNode,
  result: CareerSessionResult,
  graded: { decisions: number; correct: number },
  bankrollTarget: number | null,
): boolean | null {
  switch (node.mastery.kind) {
    case "finish_bankroll": {
      // A session that never had a bankroll cannot be judged on one. This is
      // defensive — the node table gives every standard node a positive stack.
      if (result.startingBankroll <= 0 || bankrollTarget === null) return null;
      return result.endingBankroll >= bankrollTarget;
    }

    case "accuracy": {
      return meetsAccuracy(graded.correct, graded.decisions, node.mastery.percent);
    }

    case "ev_lost": {
      // Zero EV lost across zero decisions is not mastery, it is an empty
      // sample. Reporting it as earned would hand the hardest star to a player
      // who was never asked a question.
      if (graded.decisions <= 0) return null;
      return result.estimatedEvLost <= node.mastery.maxEvLost;
    }
  }
}

/** Progression needs one star, and completion always supplies it. */
export function unlocksNextNode(evaluation: StarEvaluation): boolean {
  return evaluation.stars >= 1;
}

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------
//
// Kept here, next to the logic they describe, so a threshold can never be
// changed in the table and left stale in a screen. These are the only strings
// in `shared/career` and they exist for exactly that reason.

export function describeCompletionStar(node: CareerNode): string {
  return node.format === "drill"
    ? "Answer every scenario"
    : "Finish the session";
}

export function describeAccuracyStar(node: CareerNode): string {
  const basis = node.accuracyBasis === "unaided" ? " (decisions made unaided)" : "";
  return `${node.accuracyStarPercent}% strategy accuracy${basis}`;
}

export function describeMasteryStar(node: CareerNode): string {
  switch (node.mastery.kind) {
    case "finish_bankroll": {
      const required = requiredFinishingBankroll(
        node.startingBankroll,
        node.mastery.percentOfStart,
      );
      return node.mastery.percentOfStart === 100
        ? `Finish with at least the ${required.toLocaleString("en-US")} chips you started with`
        : `Finish with ${node.mastery.percentOfStart}% of your starting chips (${required.toLocaleString("en-US")})`;
    }
    case "accuracy":
      return `${node.mastery.percent}% strategy accuracy`;
    case "ev_lost":
      return `Give up no more than ${node.mastery.maxEvLost.toFixed(2)} of a bet in total`;
  }
}
