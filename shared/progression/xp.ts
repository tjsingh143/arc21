/**
 * Arc 21 — XP and levels.
 *
 * Pure. No I/O, no randomness and no clock: the same total XP always names the
 * same level, and the same events on the same day always grant the same amount.
 * That is what lets the server recompute a client's claim instead of trusting
 * it, which is the only way progression can be authoritative (docs/SECURITY.md
 * — `profiles.level` and `profiles.xp` are server-owned and not client-
 * writable).
 *
 * INVARIANT: XP IS INTEGER. No float touches it, for the same reason no float
 * touches a chip balance. Every value here is produced by integer addition and
 * multiplication; the two divisions that a closed-form curve would need are
 * avoided entirely (see `LEVEL_START_XP`).
 *
 * INVARIANT: A LARGER WAGER NEVER EARNS MORE XP. The play events carry counts,
 * not stakes (`shared/progression/types.ts`), so there is no arithmetic here
 * that could involve one. Any future source that pays a caller-supplied amount
 * must be keyed to an outcome the player earned — a placement, a challenge, a
 * node — never to money at risk.
 *
 * TOTAL XP IS THE STORED TRUTH. Level, progress and the next threshold are all
 * derived from it. Storing the level alongside it invites the two to disagree,
 * and then a bug in one write path becomes a permanently wrong player record.
 *
 * WHAT HAPPENS AT THE CAP
 *
 * Level 50 is the MVP ceiling and XP keeps arriving after it. Three wrong
 * answers were available: report level 51, report a negative remainder, or
 * report a next-level cost of zero for a UI to divide by. The honest one is
 * that there is NO next level — `xpForNextLevel` and `xpRemaining` are null,
 * `isMaxLevel` is true, and `xpIntoLevel` reports the real surplus. This is the
 * same choice the strategy advisor makes when it returns null rather than
 * guessing: absence is a value, and pretending otherwise moves the failure
 * somewhere harder to see.
 */

import type {
  LevelProgress,
  XpAward,
  XpAwardRequest,
  XpBucket,
  XpEvent,
  XpVenue,
} from "./types.js";

/** The MVP ceiling. `profiles.level` permits 100; the curve stops here for now. */
export const MAX_LEVEL = 50;

/** Cost of level 1 -> 2. */
export const BASE_XP_TO_ADVANCE = 100;

/** Each level costs this much more than the one before: `100 + 25 * (L - 1)`. */
export const XP_STEP_PER_LEVEL = 25;

/** One eligible settled hand, whatever was wagered on it. */
export const XP_PER_SETTLED_HAND = 5;

/** One correct decision reached before coaching revealed the answer. */
export const XP_PER_UNAIDED_CORRECT_DECISION = 2;

/**
 * The most repeatable competitive XP one player can earn in a UTC day.
 *
 * It exists so that grinding hands cannot outrun playing well, and so an
 * automated client cannot climb the ladder overnight. One-time career rewards
 * are outside it: clearing a node for the first time is not something that can
 * be farmed, and confiscating that reward would punish the player for having
 * already played today.
 */
export const DAILY_REPEATABLE_XP_CAP = 300;

/**
 * Total XP at which each level begins, `LEVEL_START_XP[level - 1]`.
 *
 * Accumulated with integer addition rather than evaluated from the closed form
 * `100n + 25n(n-1)/2`. The closed form is exact here, but it divides, and a
 * curve constant that later makes `n(n-1)/2` odd would start shaving XP at a
 * threshold with nothing to catch it. Fifty additions cost nothing and cannot
 * do that.
 */
const LEVEL_START_XP: readonly number[] = buildLevelStartXp();

function buildLevelStartXp(): readonly number[] {
  const starts: number[] = [];
  let cumulative = 0;
  for (let level = 1; level <= MAX_LEVEL; level += 1) {
    starts.push(cumulative);
    cumulative += BASE_XP_TO_ADVANCE + XP_STEP_PER_LEVEL * (level - 1);
  }
  return Object.freeze(starts);
}

/**
 * XP required to go from `level` to `level + 1`, or **null at the cap** where
 * there is no next level.
 *
 * Throws on a level outside 1..MAX_LEVEL. That is a programming error, not a
 * player state, and returning a plausible number for level 0 would let a bad
 * caller mint a threshold rather than fail.
 */
export function xpToAdvance(level: number): number | null {
  assertLevel(level);
  if (level === MAX_LEVEL) return null;
  return BASE_XP_TO_ADVANCE + XP_STEP_PER_LEVEL * (level - 1);
}

/** Cumulative XP at which `level` begins. Level 1 begins at 0. */
export function totalXpForLevel(level: number): number {
  assertLevel(level);

  const start = LEVEL_START_XP[level - 1];
  // The table is built with exactly MAX_LEVEL entries and `level` was just
  // validated against MAX_LEVEL, so this cannot be missing. It is checked
  // anyway because `noUncheckedIndexedAccess` is right to insist: a `NaN` XP
  // total leaking into a player record is far worse than a throw here.
  if (start === undefined) {
    throw new RangeError(`No XP threshold for level ${level}`);
  }
  return start;
}

/**
 * The level a total XP figure buys, and where the player stands inside it.
 *
 * Scans upward rather than inverting the quadratic. The inverse needs a square
 * root, `Math.sqrt` is a float, and a result one ulp low at an exact threshold
 * names the level below — a player who earned exactly enough would watch their
 * level fail to appear. Forty-nine integer comparisons are free and exact.
 */
export function levelFromTotalXp(totalXp: number): LevelProgress {
  assertXpAmount(totalXp, "totalXp");

  let level = 1;
  while (level < MAX_LEVEL && totalXp >= totalXpForLevel(level + 1)) {
    level += 1;
  }

  const xpIntoLevel = totalXp - totalXpForLevel(level);
  const xpForNextLevel = xpToAdvance(level);

  return {
    level,
    xpIntoLevel,
    xpForNextLevel,
    // Never negative: at any level below the cap `xpIntoLevel` is strictly less
    // than the cost of clearing it, because otherwise the scan above would have
    // moved on.
    xpRemaining: xpForNextLevel === null ? null : xpForNextLevel - xpIntoLevel,
    isMaxLevel: level === MAX_LEVEL,
  };
}

/**
 * Whether settled hands and unaided decisions earn global XP at this venue.
 *
 * An allowlist, not a denylist. A venue added later earns nothing until someone
 * decides it should, which is the safe direction to be wrong in: XP that failed
 * to arrive is a bug report, XP that should never have been granted is a
 * corrupted leaderboard.
 *
 * Tournaments and the daily challenge are absent deliberately — they pay
 * through placement and completion, so per-hand XP there would pay twice.
 */
export function venueEarnsPlayXp(venue: XpVenue): boolean {
  return venue === "online_cash" || venue === "career";
}

/**
 * Decides one award.
 *
 * The cap applies to the batch, not per event, so the result is the same
 * however the caller chose to group its hands. One-time career XP is granted
 * whole and never advances the day's counter.
 */
export function awardXp(request: XpAwardRequest): XpAward {
  assertUtcDay(request.utcDay);
  assertXpAmount(request.repeatableXpEarnedOnDay, "repeatableXpEarnedOnDay");

  let repeatableRequested = 0;
  let oneTimeXpGranted = 0;
  let ineligibleXpDiscarded = 0;

  for (const event of request.events) {
    const { xp, bucket } = classify(event);
    if (bucket === "repeatable") repeatableRequested += xp;
    else if (bucket === "one_time") oneTimeXpGranted += xp;
    else ineligibleXpDiscarded += xp;
  }

  // A stored counter above the cap (a lowered cap, a repaired record) leaves no
  // allowance rather than a negative one.
  const allowance = Math.max(0, DAILY_REPEATABLE_XP_CAP - request.repeatableXpEarnedOnDay);
  const repeatableXpGranted = Math.min(repeatableRequested, allowance);

  return {
    utcDay: request.utcDay,
    repeatableXpGranted,
    oneTimeXpGranted,
    totalXpGranted: repeatableXpGranted + oneTimeXpGranted,
    repeatableXpForfeited: repeatableRequested - repeatableXpGranted,
    ineligibleXpDiscarded,
    dailyRepeatableXpAfter: request.repeatableXpEarnedOnDay + repeatableXpGranted,
    dailyRepeatableXpRemaining: allowance - repeatableXpGranted,
  };
}

/** What one event is worth, and which pot it comes out of. */
function classify(event: XpEvent): { readonly xp: number; readonly bucket: XpBucket } {
  switch (event.kind) {
    case "settled_hands": {
      assertXpAmount(event.hands, "settled_hands.hands");
      return {
        xp: event.hands * XP_PER_SETTLED_HAND,
        bucket: venueEarnsPlayXp(event.venue) ? "repeatable" : "ineligible",
      };
    }

    case "unaided_correct_decisions": {
      assertXpAmount(event.decisions, "unaided_correct_decisions.decisions");
      return {
        xp: event.decisions * XP_PER_UNAIDED_CORRECT_DECISION,
        bucket: venueEarnsPlayXp(event.venue) ? "repeatable" : "ineligible",
      };
    }

    case "career_star": {
      assertXpAmount(event.xp, "career_star.xp");
      return { xp: event.xp, bucket: "one_time" };
    }

    case "tournament_placement": {
      assertXpAmount(event.xp, "tournament_placement.xp");
      return { xp: event.xp, bucket: "repeatable" };
    }

    case "daily_challenge": {
      assertXpAmount(event.xp, "daily_challenge.xp");
      return { xp: event.xp, bucket: "repeatable" };
    }
  }
}

/**
 * Shape check on the day key.
 *
 * Not a calendar: `2026-02-30` passes, and the server's `current_date` cannot
 * produce it. What this catches is a key of the wrong SHAPE — a full timestamp,
 * a local date, an empty string — because the key is the identity of the daily
 * counter, and a second shape is a second allowance.
 */
export function isUtcDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  // Sliced rather than captured: a fixed-width match has no group that could
  // come back undefined, so there is no index to guard and no way to read one
  // wrong.
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function assertUtcDay(value: string): void {
  if (!isUtcDay(value)) {
    throw new RangeError(`utcDay must be a UTC date as YYYY-MM-DD, received "${value}"`);
  }
}

function assertLevel(level: number): void {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
    throw new RangeError(`Level must be an integer in 1..${MAX_LEVEL}, received ${level}`);
  }
}

/**
 * Rejects fractions, NaN, Infinity, negatives and anything past the safe
 * integer range in one place. `Number.isSafeInteger` is the whole check: a
 * fractional XP amount is the bug this module exists to make impossible, and
 * clamping it would hide the caller that produced it.
 */
function assertXpAmount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, received ${value}`);
  }
}
