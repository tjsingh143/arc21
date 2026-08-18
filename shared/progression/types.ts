/**
 * Arc 21 — progression vocabulary.
 *
 * Runtime-neutral: this module must never import React, React Native, Expo,
 * Supabase or Deno. The same definitions are read by the mobile client, by the
 * Edge Function that grants XP, and by the test suite, so there is exactly one
 * description of what XP is and what a level means.
 *
 * THE INVARIANT THAT SHAPES THESE TYPES
 *
 * Betting more must never earn more XP. That is not a check at the bottom of a
 * function — it is the shape of `XpEvent`. The play events carry a COUNT of
 * hands and of decisions and there is nowhere to put a stake, so a caller
 * cannot feed a wager into progression even by accident, and no later refactor
 * can quietly open a path. A pay-to-progress ladder is the same product defect
 * as a paid advantage (CLAUDE.md invariant 2) and it is closed here, in the
 * type, rather than in a comment nobody reads.
 *
 * THE OTHER HALF IS THE VENUE
 *
 * The same settled hand happens at a ranked table, inside a career node, in
 * Practice and at a private table. Only some of those may move a global number,
 * so every play event names where it happened and the grant is decided from
 * that — a mode this module has never heard of grants nothing at all.
 */

/**
 * A calendar day in UTC, `YYYY-MM-DD`.
 *
 * The day is always passed IN. Nothing here reads a clock: a cap measured
 * against a device clock rolls over at a different instant for every player,
 * and one flight west would hand out a second daily allowance. The server's
 * `current_date` at UTC is the only authority, and this is what it looks like
 * once it arrives.
 */
export type UtcDay = string;

/**
 * Where XP was earned. Separate from the source, because the eligibility
 * question ("may this surface move a global number?") is not the same question
 * as the rate.
 */
export type XpVenue =
  /** A ranked online table. The reference case: settled hands earn. */
  | "online_cash"
  /** A career node session. Real hands off a fairly shuffled shoe, so they earn. */
  | "career"
  /** Tournament play. Paid by placement, not by the hand — see `TournamentPlacementXp`. */
  | "tournament"
  /** The daily challenge. Paid on completion, not by the hand. */
  | "daily_challenge"
  /**
   * Practice. Local, offline, always available, signed out or broke — which is
   * exactly why it can never grant XP. XP anyone can mint without a server is
   * XP that means nothing on a leaderboard.
   */
  | "practice"
  /**
   * A private unranked table. Isolated session chips, no global wallet in or
   * out. Two friends at a private table could otherwise farm each other's
   * progression all night, so the anti-collusion boundary holds for XP too.
   */
  | "private_unranked";

/** Hands that reached settlement. */
export interface SettledHandsXp {
  readonly kind: "settled_hands";
  readonly venue: XpVenue;
  /**
   * How many hands settled. Not what they were worth: there is deliberately
   * nowhere in this event to name a wager.
   */
  readonly hands: number;
}

/** Correct strategy decisions the player reached on their own. */
export interface UnaidedCorrectDecisionsXp {
  readonly kind: "unaided_correct_decisions";
  readonly venue: XpVenue;
  /**
   * Decisions that were correct AND made before any coaching revealed the
   * answer. A correct choice made while reading the recommendation measures
   * nothing about the player — the same reasoning behind `accuracyBasis:
   * "unaided"` in the career tables — so paying for it would pay for reading.
   */
  readonly decisions: number;
}

/**
 * A career star bonus.
 *
 * One-time: a star is earned once per node, so this is excluded from the daily
 * cap. A player who finally clears a hard node at the end of a long session
 * must not be told the reward evaporated because they had already played.
 */
export interface CareerStarXp {
  readonly kind: "career_star";
  /** From the career tables (`CareerReward.xp`). */
  readonly xp: number;
}

/** A tournament finish. */
export interface TournamentPlacementXp {
  readonly kind: "tournament_placement";
  /**
   * From the tournament's `prize_structure`, which is keyed to FINISHING
   * PLACE. It must never be derived from the buy-in, the starting stack or the
   * chips won, because that would reintroduce "bet more, earn more" through
   * the one door this module leaves open to a caller-supplied amount.
   */
  readonly xp: number;
}

/** A completed daily challenge. Repeatable — there is a new one every day. */
export interface DailyChallengeXp {
  readonly kind: "daily_challenge";
  readonly xp: number;
}

export type XpEvent =
  | SettledHandsXp
  | UnaidedCorrectDecisionsXp
  | CareerStarXp
  | TournamentPlacementXp
  | DailyChallengeXp;

/**
 * How an event was treated.
 *
 *   repeatable  competitive XP that counts against the daily cap
 *   one_time    a career reward, granted whole and outside the cap
 *   ineligible  earned somewhere that grants no global XP
 */
export type XpBucket = "repeatable" | "one_time" | "ineligible";

/** A level and where the player stands inside it. Derived; never stored. */
export interface LevelProgress {
  readonly level: number;
  /**
   * XP earned since this level began.
   *
   * At the cap it keeps counting: it is the surplus banked past the last level,
   * which is real, monotonic and must not be hidden or folded into a negative
   * remainder.
   */
  readonly xpIntoLevel: number;
  /**
   * What this level costs to clear, or **null at the cap** where there is no
   * next level to buy.
   *
   * Null rather than zero. Zero is a number a progress bar will happily divide
   * by, and `xpIntoLevel / 0` renders as Infinity or NaN somewhere far from
   * here; null makes the caller say what a maxed-out player looks like.
   */
  readonly xpForNextLevel: number | null;
  /** XP still needed for the next level. Never negative; null at the cap. */
  readonly xpRemaining: number | null;
  readonly isMaxLevel: boolean;
}

export interface XpAwardRequest {
  /** The UTC day these events belong to. Passed in, never read from a clock. */
  readonly utcDay: UtcDay;
  /**
   * Repeatable XP already granted to this player on that day, from the
   * server's own record. The caller owns the counter; this module only decides
   * what to add to it.
   */
  readonly repeatableXpEarnedOnDay: number;
  readonly events: readonly XpEvent[];
}

/**
 * The verdict. Capped and uncapped XP stay separate all the way out, because
 * only the repeatable half advances the day's counter — a caller that added
 * the total back into it would silently spend a career reward against tomorrow
 * as well as today.
 */
export interface XpAward {
  /** Echoed back so the caller writes the counter under the day it was judged against. */
  readonly utcDay: UtcDay;

  /** Capped competitive XP actually granted. */
  readonly repeatableXpGranted: number;
  /** One-time career XP granted. Untouched by the cap. */
  readonly oneTimeXpGranted: number;
  /** What to add to the player's stored total XP. */
  readonly totalXpGranted: number;

  /**
   * Repeatable XP the events asked for and the cap refused. Reported rather
   * than dropped, so a screen can say "daily XP limit reached" instead of
   * showing a player their hands quietly paying nothing.
   */
  readonly repeatableXpForfeited: number;
  /**
   * XP that would have been earned at a venue that grants none. Also reported
   * rather than dropped: a nonzero value here in an online context means a
   * caller mislabelled a session, and silence would hide that.
   */
  readonly ineligibleXpDiscarded: number;

  /**
   * The day's repeatable counter after this award — the value to store. It can
   * only exceed the cap if the counter passed in already did.
   */
  readonly dailyRepeatableXpAfter: number;
  /** What is left of the day's allowance. Never negative. */
  readonly dailyRepeatableXpRemaining: number;
}
