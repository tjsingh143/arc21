/**
 * Arc 21 — statistics aggregation.
 *
 * Pure functions over the local Practice record. No React, no storage, no
 * network: everything here is a fold over data the caller already has, so the
 * whole surface is testable in a plain Node process.
 *
 * THE FRAMING MATTERS MORE THAN THE ARITHMETIC.
 *
 * Win percentage is **not** the headline and is not treated as one. Short-run
 * blackjack outcomes are dominated by variance — a player can play every hand
 * perfectly and still finish a session down — so a win rate measures the shoe,
 * not the player. Strategy accuracy measures the player.
 *
 * And of the two accuracy figures, the honest one is the **unaided** figure.
 * A "correct" decision made while the recommendation was on screen in Learn or
 * Analysis mode tells you the player can read, not that they know. Both numbers
 * are computed, both are exposed, and callers are expected to distinguish them.
 *
 * Every quotient goes through `rate()`, which returns `value: null` rather than
 * dividing by zero, so no surface can render "0%" for something never attempted.
 */

import type { PlayerActionType } from "../../../shared/blackjack/types.js";
import { STRATEGY_ACTIONS, type StrategyAction } from "../../../shared/strategy/index.js";
import { rate, safeDivide, type Rate } from "./rate.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Structural mirror of `PracticeStats` from the practice feature.
 *
 * Declared here rather than imported so this module has no dependency — not
 * even a type dependency — on a Zustand store. The screen assigns the real
 * store value into this type, which makes the compiler the thing that notices
 * if the two ever drift apart.
 */
export interface PracticeStatsSnapshot {
  /** Rounds dealt and settled. A split round is one. */
  handsPlayed: number;
  /** Individual hands settled. A split round contributes two or more. */
  handsSettled: number;
  handsWon: number;
  handsLost: number;
  handsPushed: number;
  blackjacks: number;
  busts: number;
  handsSurrendered: number;
  chipsWagered: number;
  netChips: number;
  maxBankroll: number;
  doubles: number;
  doubleWins: number;
  splits: number;
  surrenders: number;
  insuranceTaken: number;
  currentWinStreak: number;
  longestWinStreak: number;
  longestLossStreak: number;
  decisions: number;
  correct: number;
  unaidedDecisions: number;
  unaidedCorrect: number;
  estimatedEvLost: number;
  hardDecisions: number;
  hardCorrect: number;
  softDecisions: number;
  softCorrect: number;
  pairDecisions: number;
  pairCorrect: number;
}

/** Structural mirror of one graded decision, as recorded by the practice store. */
export interface DecisionRecord {
  chosen: PlayerActionType;
  recommended: StrategyAction;
  correct: boolean;
  /** Expected value given up, in units of the original wager. Null if unpriced. */
  evLost: number | null;
  handLabel: string;
  upcardLabel: string;
  handNumber: number;
}

export interface StatisticsInput {
  stats: PracticeStatsSnapshot;
  /** Newest first, as the store keeps it. Bounded — see `window`. */
  decisionLog: readonly DecisionRecord[];
  /** Chips at the table right now, or null when no session is loaded. */
  bankroll: number | null;
  /** Chips the session began with, so net is a real subtraction. */
  startingBankroll: number;
  /** Chips currently committed to wagers, which have left the stack. */
  committedChips?: number;
}

// ---------------------------------------------------------------------------
// Mastery
// ---------------------------------------------------------------------------

export interface MasterySummary {
  /**
   * The headline. Decisions made in Play or Challenge mode, with no
   * recommendation on screen.
   */
  unaided: Rate;
  /** Decisions made with the answer already visible. Kept, but never headlined. */
  aided: Rate;
  /** Everything graded, aided and unaided together. */
  overall: Rate;
  hard: Rate;
  soft: Rate;
  pairs: Rate;
  /** hard + soft + pair decisions. Should equal `stats.decisions`. */
  classifiedDecisions: number;
  /**
   * Graded decisions the store did not attribute to a hand class. Expected to
   * be zero; surfaced so a discrepancy is visible rather than silently making
   * the breakdown fail to add up.
   */
  unclassifiedDecisions: number;
}

export function summariseMastery(stats: PracticeStatsSnapshot): MasterySummary {
  const unaided = rate(stats.unaidedCorrect, stats.unaidedDecisions);

  // Aided counts are a difference, not a stored field, so they are floored at
  // zero: a corrupt save could otherwise make "aided" negative.
  const aidedDecisions = Math.max(0, stats.decisions - stats.unaidedDecisions);
  const aidedCorrect = Math.max(0, stats.correct - stats.unaidedCorrect);

  const hardDecisions = nonNegative(stats.hardDecisions);
  const softDecisions = nonNegative(stats.softDecisions);
  const pairDecisions = nonNegative(stats.pairDecisions);
  const classified = hardDecisions + softDecisions + pairDecisions;

  return {
    unaided,
    aided: rate(aidedCorrect, aidedDecisions),
    overall: rate(stats.correct, stats.decisions),
    hard: rate(stats.hardCorrect, stats.hardDecisions),
    soft: rate(stats.softCorrect, stats.softDecisions),
    pairs: rate(stats.pairCorrect, stats.pairDecisions),
    classifiedDecisions: classified,
    unclassifiedDecisions: Math.max(0, nonNegative(stats.decisions) - classified),
  };
}

// ---------------------------------------------------------------------------
// Play
// ---------------------------------------------------------------------------

export interface PlaySummary {
  /** Rounds. One deal, however many hands a split made of it. */
  handsPlayed: number;
  /** Settled hands. Wins, losses, pushes and surrenders sum to this. */
  handsSettled: number;
  handsWon: number;
  handsLost: number;
  handsPushed: number;
  handsSurrendered: number;
  blackjacks: number;
  busts: number;
  /**
   * Share of settled hands won. Recorded and shown — but never the headline.
   * See the module header: this measures the shoe, not the player.
   */
  winRate: Rate;
  pushRate: Rate;
  /** Naturals per settled hand. */
  blackjackRate: Rate;
  decisions: number;
  /** Graded decisions per hand. Null before the first hand completes. */
  decisionsPerHand: number | null;
  /** Chips at the table, including chips currently on the felt. Null when no session. */
  bankroll: number | null;
  startingBankroll: number;
  /** Bankroll minus starting bankroll. Null when no session is loaded. */
  netChips: number | null;
  /** Every chip ever committed to a hand here, doubles and splits included. */
  chipsWagered: number;
  /** Chips wagered per round. Null before the first round. */
  averageBet: number | null;
  /**
   * Lifetime net across every settled hand, which is NOT the session figure:
   * a bankroll reset starts the session over and leaves this untouched.
   */
  lifetimeNetChips: number;
  /** Highest chip total ever held here, stack plus anything on the felt. */
  maxBankroll: number;
}

export function summarisePlay(input: StatisticsInput): PlaySummary {
  const { stats, bankroll, startingBankroll } = input;

  // Committed wagers have already left the seat stack, so a bankroll read
  // mid-hand would understate the player's chips by the amount on the felt.
  const committed = nonNegative(input.committedChips ?? 0);
  const total = bankroll === null ? null : nonNegative(bankroll) + committed;

  const handsPlayed = nonNegative(stats.handsPlayed);
  const handsSettled = nonNegative(stats.handsSettled);
  const chipsWagered = nonNegative(stats.chipsWagered);

  return {
    handsPlayed,
    handsSettled,
    handsWon: nonNegative(stats.handsWon),
    handsLost: nonNegative(stats.handsLost),
    handsPushed: nonNegative(stats.handsPushed),
    handsSurrendered: nonNegative(stats.handsSurrendered),
    blackjacks: nonNegative(stats.blackjacks),
    busts: nonNegative(stats.busts),
    winRate: rate(stats.handsWon, handsSettled),
    pushRate: rate(stats.handsPushed, handsSettled),
    blackjackRate: rate(stats.blackjacks, handsSettled),
    decisions: nonNegative(stats.decisions),
    decisionsPerHand: safeDivide(nonNegative(stats.decisions), handsPlayed),
    bankroll: total,
    startingBankroll,
    netChips: total === null ? null : total - startingBankroll,
    chipsWagered,
    averageBet: safeDivide(chipsWagered, handsPlayed),
    lifetimeNetChips: Number.isFinite(stats.netChips) ? Math.trunc(stats.netChips) : 0,
    maxBankroll: nonNegative(stats.maxBankroll),
  };
}

// ---------------------------------------------------------------------------
// Decision behaviour
// ---------------------------------------------------------------------------

export interface ActionTally {
  /** Times the player chose this action. */
  taken: number;
  /** Times the tables recommended it. */
  recommended: number;
  /** Times it was both recommended and taken. */
  followed: number;
  /** Recommended and declined — the doubles and splits left on the table. */
  missed: number;
  /** Taken when something else was recommended. */
  unprompted: number;
}

/** One repeated mistake: the same hand, the same upcard, the same wrong choice. */
export interface MistakePattern {
  key: string;
  handLabel: string;
  upcardLabel: string;
  chosen: PlayerActionType;
  recommended: StrategyAction;
  count: number;
  /** Summed EV given up across every occurrence. Null when none was priced. */
  evLost: number | null;
}

/**
 * Lifetime counts of the actions that cost or save chips.
 *
 * Separate from `byAction`, which is bounded by the decision log and answers
 * "how often did you take the advice". These answer "how many did you play",
 * over everything ever recorded on this device.
 */
export interface LifetimeActions {
  doubles: number;
  /** Doubled hands that won. A doubled hand that busts is never one. */
  doubleWins: number;
  doubleWinRate: Rate;
  splits: number;
  surrenders: number;
  insuranceTaken: number;
}

export interface BehaviourSummary {
  /** How many logged decisions this covers. The log is capped by the store. */
  window: number;
  byAction: Record<StrategyAction, ActionTally>;
  /** Lifetime, not windowed. */
  lifetime: LifetimeActions;
  /** Lifetime EV given up, in units of the original wager. */
  estimatedEvLost: number;
  /** Lifetime EV lost per hundred decisions, or null with no decisions. */
  evLostPerHundredDecisions: number | null;
  /** Repeated mistakes in the window, costliest first. */
  costliest: MistakePattern[];
}

export function summariseBehaviour(
  stats: PracticeStatsSnapshot,
  decisionLog: readonly DecisionRecord[],
): BehaviourSummary {
  const byAction = emptyTallies();

  for (const record of decisionLog) {
    const chosen = byAction[record.chosen];
    const recommended = byAction[record.recommended];

    chosen.taken += 1;
    recommended.recommended += 1;

    if (record.chosen === record.recommended) {
      recommended.followed += 1;
    } else {
      recommended.missed += 1;
      chosen.unprompted += 1;
    }
  }

  const evLost = Number.isFinite(stats.estimatedEvLost) ? Math.max(0, stats.estimatedEvLost) : 0;
  const perDecision = safeDivide(evLost, nonNegative(stats.decisions));

  return {
    window: decisionLog.length,
    byAction,
    lifetime: {
      doubles: nonNegative(stats.doubles),
      doubleWins: nonNegative(stats.doubleWins),
      doubleWinRate: rate(stats.doubleWins, stats.doubles),
      splits: nonNegative(stats.splits),
      surrenders: nonNegative(stats.surrenders),
      insuranceTaken: nonNegative(stats.insuranceTaken),
    },
    estimatedEvLost: evLost,
    evLostPerHundredDecisions: perDecision === null ? null : perDecision * 100,
    costliest: costliestMistakes(decisionLog),
  };
}

/**
 * Groups wrong decisions by the situation that produced them.
 *
 * A list of individual mistakes is a transcript; a list of repeated mistakes is
 * a lesson. Ordering is by total EV given up, with an unpriced group ranked by
 * frequency below every priced one, because "we could not price this" must not
 * masquerade as "this cost nothing".
 */
export function costliestMistakes(
  decisionLog: readonly DecisionRecord[],
  limit = 5,
): MistakePattern[] {
  const groups = new Map<string, MistakePattern>();

  for (const record of decisionLog) {
    if (record.correct) continue;

    const key = `${record.handLabel}|${record.upcardLabel}|${record.chosen}|${record.recommended}`;
    const existing = groups.get(key);
    const priced = record.evLost !== null && Number.isFinite(record.evLost) ? record.evLost : null;

    if (existing) {
      existing.count += 1;
      if (priced !== null) existing.evLost = (existing.evLost ?? 0) + priced;
      continue;
    }

    groups.set(key, {
      key,
      handLabel: record.handLabel,
      upcardLabel: record.upcardLabel,
      chosen: record.chosen,
      recommended: record.recommended,
      count: 1,
      evLost: priced,
    });
  }

  return [...groups.values()]
    .sort((a, b) => {
      const left = a.evLost;
      const right = b.evLost;
      if (left !== null && right !== null && left !== right) return right - left;
      if (left !== null && right === null) return -1;
      if (left === null && right !== null) return 1;
      return b.count - a.count;
    })
    .slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

export interface StreakSummary {
  /** Streaks are measured over the logged window, never over all time. */
  window: number;
  /** Correct decisions running up to the most recent one. */
  currentCorrect: number;
  bestCorrect: number;
  /** Mistakes running up to the most recent decision. */
  currentIncorrect: number;
  worstIncorrect: number;
  /**
   * Round-level runs, which ARE lifetime — the store carries them forward
   * rather than recomputing them from a bounded log.
   *
   * Kept apart from the decision streaks above and never presented as an
   * achievement: a run of winning hands says nothing about the player. It is
   * here because the specification asks for it and because a player is entitled
   * to see what happened, not because it measures anything.
   */
  currentRoundWins: number;
  currentRoundLosses: number;
  longestRoundWins: number;
  longestRoundLosses: number;
}

/**
 * Streaks over the decision log.
 *
 * NOTE: these are *decision* streaks, not win streaks. A run of winning hands
 * says nothing about the player, and presenting one as an achievement teaches
 * exactly the wrong lesson about a game with this much variance.
 *
 * `decisionLog` arrives newest-first, matching the store.
 */
export function summariseStreaks(
  decisionLog: readonly DecisionRecord[],
  stats?: PracticeStatsSnapshot,
): StreakSummary {
  let bestCorrect = 0;
  let worstIncorrect = 0;
  let runCorrect = 0;
  let runIncorrect = 0;

  // Walk chronologically so "best run" reads the way a person would count it.
  for (let index = decisionLog.length - 1; index >= 0; index--) {
    const record = decisionLog[index];
    if (!record) continue;

    if (record.correct) {
      runCorrect += 1;
      runIncorrect = 0;
      bestCorrect = Math.max(bestCorrect, runCorrect);
    } else {
      runIncorrect += 1;
      runCorrect = 0;
      worstIncorrect = Math.max(worstIncorrect, runIncorrect);
    }
  }

  // The chronological walk ends on the newest decision, so the runs it finishes
  // holding are exactly the current streaks. Only one of them can be non-zero.
  const currentCorrect = runCorrect;
  const currentIncorrect = runIncorrect;

  // `currentWinStreak` carries both directions in one field: positive is a
  // winning run, negative a losing one, zero a push or nothing yet.
  const run = Number.isFinite(stats?.currentWinStreak) ? Math.trunc(stats!.currentWinStreak) : 0;

  return {
    window: decisionLog.length,
    currentCorrect,
    bestCorrect,
    currentIncorrect,
    worstIncorrect,
    currentRoundWins: Math.max(0, run),
    currentRoundLosses: Math.max(0, -run),
    longestRoundWins: nonNegative(stats?.longestWinStreak ?? 0),
    longestRoundLosses: nonNegative(stats?.longestLossStreak ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

export interface TrendPoint {
  /** Decisions in this bucket. */
  decisions: number;
  accuracy: Rate;
}

/**
 * Accuracy over time, oldest bucket first, for a compact sparkline.
 *
 * Buckets are contiguous slices of the log rather than fixed time windows,
 * because Practice is played in bursts and a calendar axis would be mostly
 * empty. A bucket never renders on its own: the caller shows how many decisions
 * each one holds.
 */
export function accuracyTrend(
  decisionLog: readonly DecisionRecord[],
  bucketCount = 8,
): TrendPoint[] {
  const total = decisionLog.length;
  if (total === 0 || bucketCount < 1) return [];

  // Chronological.
  const ordered = [...decisionLog].reverse();
  const buckets = Math.min(Math.trunc(bucketCount), total);
  const size = Math.ceil(total / buckets);

  const points: TrendPoint[] = [];
  for (let start = 0; start < total; start += size) {
    const slice = ordered.slice(start, start + size);
    const correct = slice.reduce((sum, record) => sum + (record.correct ? 1 : 0), 0);
    points.push({ decisions: slice.length, accuracy: rate(correct, slice.length) });
  }

  return points;
}

// ---------------------------------------------------------------------------
// Everything
// ---------------------------------------------------------------------------

export interface PracticeStatistics {
  mastery: MasterySummary;
  play: PlaySummary;
  behaviour: BehaviourSummary;
  streaks: StreakSummary;
  trend: TrendPoint[];
  /** False when nothing has been played, so the screen can say so plainly. */
  hasData: boolean;
}

export function buildPracticeStatistics(input: StatisticsInput): PracticeStatistics {
  const play = summarisePlay(input);

  return {
    mastery: summariseMastery(input.stats),
    play,
    behaviour: summariseBehaviour(input.stats, input.decisionLog),
    streaks: summariseStreaks(input.decisionLog, input.stats),
    trend: accuracyTrend(input.decisionLog),
    hasData: play.handsPlayed > 0 || play.decisions > 0 || play.handsSettled > 0,
  };
}

// ---------------------------------------------------------------------------

function emptyTallies(): Record<StrategyAction, ActionTally> {
  const tallies = {} as Record<StrategyAction, ActionTally>;
  for (const action of STRATEGY_ACTIONS) {
    tallies[action] = { taken: 0, recommended: 0, followed: 0, missed: 0, unprompted: 0 };
  }
  return tallies;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
