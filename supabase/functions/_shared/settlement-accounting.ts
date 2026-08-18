/**
 * What a settled hand adds to a player's record.
 *
 * This is the pure half of the server's settlement bookkeeping: given the
 * events the engine just produced, it says how the statistics move and how much
 * XP was earned. Writing it as a pure function rather than inline SQL is
 * deliberate — the arithmetic is the part that can be wrong in a way nobody
 * notices for months, and here it can be tested against the real engine output
 * without a database.
 *
 * It deliberately does NOT read wagers for XP. `XP_PER_SETTLED_HAND` is a flat
 * per-hand figure and `XP_PER_UNAIDED_CORRECT_DECISION` a flat per-decision
 * one, so there is no expression here in which a larger bet produces more XP.
 * That is the specification's "never award more XP for betting larger amounts",
 * enforced by construction rather than by a check someone could delete.
 */

import type {
  EngineEvent,
  HandOutcomeKind,
} from "../../../shared/blackjack/types.js";

/**
 * Kept here rather than imported from `shared/progression`.
 *
 * The Supabase CLI bind-mounts each file outside `supabase/functions` into the
 * Edge runtime individually, from a module graph that does not pick up newly
 * added files — a new file under `shared/` resolves on the client and in tests
 * but fails at runtime with "no such file or directory". Files under
 * `supabase/functions` are mounted wholesale and always resolve.
 *
 * `tests/progression/settlement-accounting.test.ts` asserts this equals
 * `XP_PER_SETTLED_HAND` in `shared/progression/xp.ts`, so the duplicate cannot
 * drift from the definition it mirrors. Delete that assertion and this becomes
 * a second source of truth.
 */
export const SERVER_XP_PER_SETTLED_HAND = 5;

/** Mirrors `DAILY_REPEATABLE_XP_CAP`; guarded by the same test. */
export const SERVER_DAILY_REPEATABLE_XP_CAP = 300;

/** Column-for-column with `public.player_stats`, minus the identity columns. */
export interface StatsDelta {
  handsPlayed: number;
  handsWon: number;
  handsLost: number;
  handsPushed: number;
  handsSurrendered: number;
  blackjacks: number;
  busts: number;
  chipsWagered: number;
  chipsNet: number;
  biggestWin: number;
  /** Hands won in an unbroken run at the END of this batch. */
  trailingWinStreak: number;
  /** True when the batch contains a non-win, so the caller resets rather than adds. */
  streakBroken: boolean;
}

export interface SettlementAccounting {
  readonly stats: StatsDelta;
  /** Hands that settled, which is what per-hand XP is paid on. */
  readonly settledHands: number;
  readonly xp: number;
}

const EMPTY: StatsDelta = {
  handsPlayed: 0,
  handsWon: 0,
  handsLost: 0,
  handsPushed: 0,
  handsSurrendered: 0,
  blackjacks: 0,
  busts: 0,
  chipsWagered: 0,
  chipsNet: 0,
  biggestWin: 0,
  trailingWinStreak: 0,
  streakBroken: false,
};

/** A win for streak purposes. A push breaks nothing but extends nothing. */
function isWin(kind: HandOutcomeKind): boolean {
  return kind === "WIN" || kind === "BLACKJACK";
}

/**
 * A push leaves a streak intact rather than ending it: the player did not lose.
 * Stated explicitly because "not a win" and "a loss" are different questions and
 * conflating them is the usual way streak counters go wrong.
 */
function breaksStreak(kind: HandOutcomeKind): boolean {
  return kind === "LOSS" || kind === "BUST" || kind === "SURRENDER";
}

/**
 * Fold the engine's events for ONE seat into a statistics delta and an XP total.
 *
 * Only `seatId`'s own hands count. A shared table emits settlements for every
 * seat in the same batch, and crediting all of them to whoever sent the command
 * would let one player inflate their record by sitting next to a busy one.
 */
export function accountForSettlement(
  events: readonly EngineEvent[],
  seatId: string,
): SettlementAccounting {
  const stats: StatsDelta = { ...EMPTY };
  let settledHands = 0;

  for (const event of events) {
    if (event.type !== "HAND_SETTLED" || event.seatId !== seatId) continue;

    const { kind, credit, net } = event.outcome;
    settledHands += 1;
    stats.handsPlayed += 1;

    // `credit - net` recovers the stake without needing the wager threaded
    // through the event: credit is stake + profit, and net is profit alone.
    stats.chipsWagered += credit - net;
    stats.chipsNet += net;

    if (isWin(kind)) {
      stats.handsWon += 1;
      stats.trailingWinStreak += 1;
      if (net > stats.biggestWin) stats.biggestWin = net;
      if (kind === "BLACKJACK") stats.blackjacks += 1;
    } else if (kind === "PUSH") {
      stats.handsPushed += 1;
    } else {
      stats.handsLost += 1;
      if (kind === "BUST") stats.busts += 1;
      if (kind === "SURRENDER") stats.handsSurrendered += 1;
    }

    if (breaksStreak(kind)) {
      stats.streakBroken = true;
      stats.trailingWinStreak = 0;
    }
  }

  return {
    stats,
    settledHands,
    // Flat per hand. There is nowhere in this expression for a stake to appear.
    xp: settledHands * SERVER_XP_PER_SETTLED_HAND,
  };
}

/** Nothing settled, so nothing to write. Lets the caller skip the round trip. */
export function isEmptyAccounting(accounting: SettlementAccounting): boolean {
  return accounting.settledHands === 0;
}
