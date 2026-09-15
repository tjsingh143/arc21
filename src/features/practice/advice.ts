/**
 * Arc 21 — table advice.
 *
 * Bridges the authoritative game state to the validated strategy tables. Kept
 * as a pure function rather than a hook so it can be unit-tested against the
 * real engine without rendering anything.
 *
 * FAIL-SAFE CONTRACT: when the tables cannot answer, this returns
 * `recommendation: null` plus a diagnostic. Callers must hide the hint and log
 * the diagnostic — never substitute a guess. A wrong recommendation in a
 * teaching product is worse than no recommendation.
 */

import {
  adviseActionWithDiagnostics,
  bestLegalEV,
  describeStrategyState,
  describeStrategyStateLabel,
  describeUpcardLabel,
  evForAction,
  legalActionEVs,
  type ActionEV,
  type StrategyAction,
  type StrategyDiagnostic,
  type StrategyProbabilities,
  type StrategyRecommendation,
  type StrategyState,
} from "../../../shared/strategy/index.js";
import { recordStrategyDiagnostic } from "./strategy-diagnostics.js";
import { activeHandOf } from "../../../shared/blackjack/legal-actions.js";
import type { BlackjackGameState, PlayerActionType, SeatState } from "../../../shared/blackjack/types.js";

export interface TableAdvice {
  /** Null means "show nothing". Never fall back to a guess. */
  recommendation: StrategyRecommendation | null;
  state: StrategyState | null;
  /** EVs for the legal actions only, best first. Empty when unpriced. */
  evs: ActionEV[];
  best: ActionEV | null;
  /**
   * Solver probabilities for this position, or null when the table serving the
   * recommendation does not carry them.
   *
   * Null is a real state and callers must render nothing for it. A table
   * generated before probabilities existed is still a valid table, and
   * substituting a computed-here estimate would put a number produced by
   * different arithmetic next to EVs produced by the solver — the two could
   * disagree and nothing would notice. Same fail-safe rule as the
   * recommendation itself, one level down.
   */
  probabilities: StrategyProbabilities | null;
  /** Chart-style labels, e.g. "Hard 16" and "10". */
  handLabel: string | null;
  upcardLabel: string | null;
  /**
   * Why nothing was served. For diagnostics, not for users.
   *
   * Structured rather than a formatted string so a caller can record it without
   * parsing prose — see `recordAdviceDiagnostic`.
   */
  diagnostic: StrategyDiagnostic | null;
}

const NO_ADVICE: TableAdvice = {
  recommendation: null,
  state: null,
  evs: [],
  best: null,
  probabilities: null,
  handLabel: null,
  upcardLabel: null,
  diagnostic: null,
};

/**
 * Computes advice for the seat's currently active hand.
 *
 * Only ever reads public information: the player's own cards and the dealer's
 * UPCARD. It must never consult the hole card or the shoe — doing so would make
 * the "advice" a form of cheating and would invalidate every EV it reports.
 */
export function computeAdvice(
  game: BlackjackGameState,
  seat: SeatState,
  legalActions: readonly PlayerActionType[],
): TableAdvice {
  if (game.phase !== "PLAYER_TURNS") return NO_ADVICE;

  const hand = activeHandOf(seat);
  if (!hand || hand.status !== "ACTIVE") return NO_ADVICE;

  // Index 0 is the upcard. The hole card lives at index 1 and is deliberately
  // never read here.
  const upcard = game.dealer.cards[0];
  if (!upcard) return NO_ADVICE;

  const state = describeStrategyState(hand.cards, upcard, {
    splitPolicy: game.rules.splitPolicy,
    cameFromSplit: hand.cameFromSplit,
    cameFromSplitAces: hand.cameFromSplitAces,
    splitAceTwentyOneIsBlackjack: game.rules.splitAceTwentyOneIsBlackjack,
  });

  if (!state) return NO_ADVICE;

  const result = adviseActionWithDiagnostics({
    rules: game.rules,
    state,
    legalActions,
  });

  const recommendation = result.recommendation ?? null;
  const decision = recommendation?.decision ?? null;

  const evs = decision ? legalActionEVs(decision, legalActions) : [];
  const best = decision ? bestLegalEV(decision, legalActions) : null;

  return {
    recommendation,
    state,
    evs: [...evs].sort((a, b) => b.ev - a.ev),
    best,
    // From the cell actually being served, so a probability and an EV on the
    // same panel always describe the same cell — including under TOTAL_ROW
    // resolution, where the pair row was not the row that answered.
    probabilities: decision?.probabilities ?? null,
    handLabel: describeStrategyStateLabel(state),
    upcardLabel: describeUpcardLabel(state.dealerUpcardValue),
    diagnostic: result.diagnostic ?? null,
  };
}

/**
 * Records the reason no recommendation was served.
 *
 * The third half of failing safe. Play continues and the hint stays hidden
 * without this; what this adds is that a hole in the tables leaves EVIDENCE,
 * instead of being indistinguishable from an advisor with nothing to say.
 *
 * Deliberately separate from `computeAdvice`, which stays pure so it can be
 * called from a `useMemo` without writing during render. Callers record from an
 * effect (the table) or from the command path (the store); the sink counts
 * occurrences of a hole being REACHED, so a state that is both displayed and
 * then acted on is two honest observations of it.
 *
 * Safe to call with anything, including a successful lookup: it does nothing
 * unless there is a diagnostic to record.
 */
export function recordAdviceDiagnostic(advice: TableAdvice): void {
  const diagnostic = advice.diagnostic;
  if (diagnostic === null) return;

  recordStrategyDiagnostic({
    code: diagnostic.code,
    key: diagnostic.key,
    rulesetId: diagnostic.rulesetId,
    rulesetVersion: diagnostic.rulesetVersion,
  });
}

/**
 * A stable identity for the current diagnostic, or null when there is none.
 *
 * The table keys its recording effect on this so a re-render that leaves the
 * same hole in place — expanding the panel, placing a chip — does not record it
 * again, while genuinely arriving at the hole a second time does.
 */
export function adviceDiagnosticKey(advice: TableAdvice): string | null {
  const diagnostic = advice.diagnostic;
  if (diagnostic === null) return null;
  return `${diagnostic.rulesetId}@${diagnostic.rulesetVersion}|${diagnostic.code}|${diagnostic.key ?? "-"}`;
}

export interface DecisionVerdict {
  chosen: PlayerActionType;
  recommended: StrategyAction;
  correct: boolean;
  /** EV given up by the choice, in units of the original wager. Null if unpriced. */
  evLost: number | null;
  handLabel: string;
  upcardLabel: string;
}

/**
 * Grades a decision the player actually made. Returns null when the tables had
 * no opinion, so an ungradeable hand is never counted as a mistake — accuracy
 * must only ever move on decisions we can actually adjudicate.
 */
export function gradeDecision(
  advice: TableAdvice,
  chosen: PlayerActionType,
): DecisionVerdict | null {
  const recommended = advice.recommendation?.action;
  if (!recommended || !advice.state) return null;

  const correct = chosen === recommended;

  let evLost: number | null = null;
  const decision = advice.recommendation?.decision;
  if (decision && !correct) {
    const bestEv = advice.best?.ev ?? null;
    const chosenEv = evForAction(decision, chosen as StrategyAction);
    if (bestEv !== null && chosenEv !== null) {
      evLost = Math.max(0, bestEv - chosenEv);
    }
  } else if (correct) {
    evLost = 0;
  }

  return {
    chosen,
    recommended,
    correct,
    evLost,
    handLabel: advice.handLabel ?? "",
    upcardLabel: advice.upcardLabel ?? "",
  };
}

/**
 * A one-line rationale for the Learn mode "Why?" expansion.
 *
 * Built from the solver's own numbers rather than hand-written prose per cell,
 * so it can never drift from the table it is explaining. Rounded to two
 * decimals: the underlying model carries documented approximations, and more
 * digits would imply precision the numbers do not have.
 */
export function explainRecommendation(advice: TableAdvice): string | null {
  const { recommendation, evs } = advice;
  if (!recommendation) return null;

  const best = evs[0];
  const runnerUp = evs[1];

  if (!best || !runnerUp) {
    return `${verb(recommendation.action)} is the highest-value play for ${advice.handLabel} against ${advice.upcardLabel}.`;
  }

  return (
    `Over the long run ${verb(best.action).toLowerCase()} averages ${format(best.ev)} per bet here, ` +
    `against ${format(runnerUp.ev)} for ${verb(runnerUp.action).toLowerCase()}.`
  );
}

function verb(action: StrategyAction): string {
  switch (action) {
    case "HIT":
      return "Hitting";
    case "STAND":
      return "Standing";
    case "DOUBLE":
      return "Doubling";
    case "SPLIT":
      return "Splitting";
    case "SURRENDER":
      return "Surrendering";
  }
}

/** Signed, two decimals, with a true minus sign. */
export function format(ev: number): string {
  const rounded = Math.round(ev * 100) / 100;
  // Avoid rendering "-0.00", which reads as a real negative.
  const safe = Object.is(rounded, -0) ? 0 : rounded;
  return `${safe > 0 ? "+" : safe < 0 ? "−" : ""}${Math.abs(safe).toFixed(2)}`;
}

/**
 * Unsigned magnitude, for text that already states the direction.
 *
 * "Costs about +0.16 of a bet" reads as a gain; the surrounding words carry the
 * sign, so the number must not repeat it.
 */
export function formatMagnitude(value: number): string {
  return Math.abs(Math.round(value * 100) / 100).toFixed(2);
}

/**
 * A solver probability as a whole-percent string.
 *
 * Whole percents on purpose: the underlying model carries documented
 * approximations, and "61.2%" claims a tenth of a point the cell aggregation
 * does not support. `Math.round` rather than truncation so 0.6117 reads as 61%
 * and not 61% by accident.
 */
export function formatProbability(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

/** Human label for an action, used in chips and buttons. */
export function actionLabel(action: StrategyAction): string {
  return action.charAt(0) + action.slice(1).toLowerCase();
}

export { NO_ADVICE };
