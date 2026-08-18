/**
 * Grading a player's decision against basic strategy, on the server.
 *
 * The specification's bar for the strategy leaderboard is "minimum 100 eligible
 * SERVER-AUTHORITATIVE decisions in period", and that adjective is the whole
 * point: an accuracy a client reports is an accuracy a client chooses. So the
 * grade is computed here, from the authoritative state as it stood BEFORE the
 * action, using the same advisor the learning screens use.
 *
 * Nothing here decides what the correct play IS. `adviseAction` does, from the
 * generated table, and it returns null rather than guessing — in which case the
 * decision is not counted at all rather than counted as a mistake.
 */

import { getLegalActions } from "../../../shared/blackjack/index.js";
import type { EngineState, PlayerActionType } from "../../../shared/blackjack/index.js";
import { activeHandOf } from "../../../shared/blackjack/legal-actions.js";
import { adviseAction, describeStrategyState, evMistakeForDecision } from "./strategy/index.ts";

/**
 * Modes whose decisions count towards strategy accuracy.
 *
 * The specification excludes Practice, excludes tournaments, and excludes "modes
 * where answer was shown before choice". This list is how all three hold:
 *
 *   * `practice` is local and never reaches a server command at all;
 *   * `tournament` is excluded by name — correct tournament play deviates from
 *     basic strategy, so scoring it against the chart would punish playing the
 *     format properly;
 *   * `private_table` is excluded because the product calls private tables
 *     unranked. Their chips are unranked, so their decisions are too;
 *   * the remaining three are the ranked server-authoritative modes, and none of
 *     them offers assistance — the shared table screen renders no advice, which
 *     is what satisfies "the answer was not shown before the choice".
 *
 * Listing the ELIGIBLE modes rather than the excluded ones is deliberate: a new
 * mode is not counted until somebody adds it here on purpose.
 */
export const ACCURACY_ELIGIBLE_MODES = ["solo", "public_table", "daily_challenge"] as const;

export function countsTowardsAccuracy(mode: string): boolean {
  return (ACCURACY_ELIGIBLE_MODES as readonly string[]).includes(mode);
}

/** The five decisions the chart covers. `RESOLVE_TIMEOUT` is not one of them. */
const GRADED_ACTIONS: readonly PlayerActionType[] = [
  "HIT",
  "STAND",
  "DOUBLE",
  "SPLIT",
  "SURRENDER",
];

export interface DecisionGrade {
  /** True when this decision belongs in the accuracy figures at all. */
  counted: boolean;
  /** Whether it matched the chart. Meaningless unless `counted`. */
  optimal: boolean;
  /**
   * What this decision cost, in MILLIONTHS of one unit wagered, measured against
   * the best action that was actually legal.
   *
   * Millionths because the column it lands in is a `bigint`: no floating-point
   * column exists anywhere in the public schema, and an ordering key computed in
   * floating point can rank two identical records differently on two machines.
   *
   * Zero when the chart prices nothing for this decision — `evMistakeForDecision`
   * answers null there rather than claiming the play was free, and a tie-break
   * has to be a number, so the unpriced case contributes nothing rather than
   * being counted as a mistake. It is the same contract as `unpriced` above: an
   * unknown is never rendered as a fault.
   */
  evLostMicros: number;
  /**
   * Why it was not counted, for the structured log. Never a card and never the
   * recommended action — a diagnostic that named the right play would be a hint
   * leaking through the logs.
   */
  skipped?: "mode" | "not-an-action" | "no-hand" | "no-upcard" | "unpriced" | "timeout-default";
}

const NOT_COUNTED = (skipped: DecisionGrade["skipped"]): DecisionGrade => ({
  counted: false,
  optimal: false,
  evLostMicros: 0,
  skipped,
});

/** One unit of EV expressed in the integer scale the database stores. */
const EV_MICROS = 1_000_000;

/**
 * Grades one action.
 *
 * `state` must be the state BEFORE the action was applied — the cards the player
 * was actually looking at. Grading afterwards would compare the chart against a
 * hand that already has the hit card in it.
 *
 * `wasTimeout` marks a decision the SERVER made on an absent player's behalf.
 * Those are never counted: the engine's documented default is to stand, and
 * recording that as the player's own choice would move their accuracy for
 * something they did not do.
 */
export function gradeDecision(params: {
  mode: string;
  state: EngineState;
  seatId: string;
  action: PlayerActionType;
  wasTimeout?: boolean;
}): DecisionGrade {
  if (!countsTowardsAccuracy(params.mode)) return NOT_COUNTED("mode");
  if (params.wasTimeout === true) return NOT_COUNTED("timeout-default");
  if (!GRADED_ACTIONS.includes(params.action)) return NOT_COUNTED("not-an-action");

  const seat = params.state.seats.find((candidate) => candidate.seatId === params.seatId);
  const hand = seat ? activeHandOf(seat) : undefined;
  if (!seat || !hand) return NOT_COUNTED("no-hand");

  // Index 0 is the upcard. The hole card sits at index 1 and is never read here —
  // grading against information the player could not see would be worse than not
  // grading at all.
  const upcard = params.state.dealer.cards[0];
  if (!upcard) return NOT_COUNTED("no-upcard");

  const strategyState = describeStrategyState(hand.cards, upcard, {
    splitPolicy: params.state.rules.splitPolicy,
    cameFromSplit: hand.cameFromSplit,
    cameFromSplitAces: hand.cameFromSplitAces,
    splitAceTwentyOneIsBlackjack: params.state.rules.splitAceTwentyOneIsBlackjack,
  });
  if (!strategyState) return NOT_COUNTED("no-hand");

  // The chart is consulted against what was actually available. A "correct"
  // play the player could not have made is not a mistake on their part.
  const legalActions = getLegalActions(params.state, params.seatId).actions;

  const recommendation = adviseAction({
    rules: params.state.rules,
    state: strategyState,
    legalActions,
  });

  // The advisor declined. Not counted either way: the contract everywhere else in
  // this project is that a null recommendation means "say nothing", never "assume
  // the player was wrong".
  if (!recommendation) return NOT_COUNTED("unpriced");

  /*
   * What the play cost, against the best action the player could actually have
   * taken — `recommendation.decision` is the cell the served advice came from,
   * which under a TOTAL_ROW resolution is the hard/soft row rather than the pair
   * cell, and grading against a cell the advisor did not use would price a
   * different decision from the one the player faced.
   *
   * Rounded rather than truncated: at six decimal places the difference is
   * nothing, but rounding is the operation that does not systematically favour
   * the player.
   */
  const evLost = evMistakeForDecision(recommendation.decision, params.action, legalActions);

  return {
    counted: true,
    optimal: recommendation.action === params.action,
    evLostMicros: evLost === null ? 0 : Math.max(0, Math.round(evLost * EV_MICROS)),
  };
}
