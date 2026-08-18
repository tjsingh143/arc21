/**
 * XP, levels and the daily cap.
 *
 * Three properties are load-bearing and every one of them is asserted against a
 * real number rather than a re-derivation of the implementation:
 *
 *   - The curve is exact. `100 + 25 * (L - 1)` is written out at the levels
 *     that matter, so a "harmless" refactor of the accumulator cannot quietly
 *     move every threshold in the game.
 *   - The cap holds at exactly 300, and one-time career rewards cross it. A cap
 *     that swallows a first-completion reward would punish a player for having
 *     already played today.
 *   - Betting more never earns more. There is no wager anywhere in the event
 *     types, and the arithmetic depends only on how many hands settled.
 */

import { describe, expect, it } from "vitest";

import {
  awardXp,
  BASE_XP_TO_ADVANCE,
  DAILY_REPEATABLE_XP_CAP,
  isUtcDay,
  levelFromTotalXp,
  MAX_LEVEL,
  totalXpForLevel,
  venueEarnsPlayXp,
  XP_PER_SETTLED_HAND,
  XP_PER_UNAIDED_CORRECT_DECISION,
  XP_STEP_PER_LEVEL,
  xpToAdvance,
} from "../../shared/progression/xp.js";
import type { XpEvent, XpVenue } from "../../shared/progression/types.js";

const DAY = "2026-08-15";

/** Total XP at which the cap level begins. Written out, not computed. */
const XP_AT_MAX_LEVEL = 34_300;

function award(events: readonly XpEvent[], repeatableXpEarnedOnDay = 0) {
  return awardXp({ utcDay: DAY, repeatableXpEarnedOnDay, events });
}

function hands(count: number, venue: XpVenue = "online_cash"): XpEvent {
  return { kind: "settled_hands", venue, hands: count };
}

function decisions(count: number, venue: XpVenue = "online_cash"): XpEvent {
  return { kind: "unaided_correct_decisions", venue, decisions: count };
}

describe("the curve", () => {
  it("charges exactly 100 + 25 * (L - 1)", () => {
    expect(xpToAdvance(1)).toBe(100);
    expect(xpToAdvance(2)).toBe(125);
    expect(xpToAdvance(10)).toBe(325);
    expect(xpToAdvance(49)).toBe(1_300);
  });

  it("has no cost at the cap, because there is no level to buy", () => {
    // Null, not zero: zero is a number a progress bar will divide by.
    expect(xpToAdvance(MAX_LEVEL)).toBeNull();
    expect(MAX_LEVEL).toBe(50);
  });

  it("keeps the published constants in step with the costs", () => {
    expect(BASE_XP_TO_ADVANCE).toBe(100);
    expect(XP_STEP_PER_LEVEL).toBe(25);
    for (let level = 1; level < MAX_LEVEL; level += 1) {
      expect(xpToAdvance(level)).toBe(BASE_XP_TO_ADVANCE + XP_STEP_PER_LEVEL * (level - 1));
    }
  });

  it("rejects a level off the ladder rather than inventing a threshold", () => {
    expect(() => xpToAdvance(0)).toThrow(RangeError);
    expect(() => xpToAdvance(MAX_LEVEL + 1)).toThrow(RangeError);
    expect(() => xpToAdvance(1.5)).toThrow(RangeError);
    expect(() => totalXpForLevel(0)).toThrow(RangeError);
    expect(() => totalXpForLevel(MAX_LEVEL + 1)).toThrow(RangeError);
  });
});

describe("cumulative thresholds", () => {
  it("starts level 1 at zero XP", () => {
    expect(totalXpForLevel(1)).toBe(0);
  });

  it("puts the known levels at their exact totals", () => {
    expect(totalXpForLevel(2)).toBe(100);
    expect(totalXpForLevel(3)).toBe(225);
    expect(totalXpForLevel(10)).toBe(1_800);
    expect(totalXpForLevel(49)).toBe(33_000);
    expect(totalXpForLevel(MAX_LEVEL)).toBe(XP_AT_MAX_LEVEL);
  });

  it("advances by exactly the cost of the level below", () => {
    for (let level = 1; level < MAX_LEVEL; level += 1) {
      expect(totalXpForLevel(level + 1) - totalXpForLevel(level)).toBe(xpToAdvance(level));
    }
  });

  it("is strictly increasing, so no two levels share a threshold", () => {
    for (let level = 1; level < MAX_LEVEL; level += 1) {
      expect(totalXpForLevel(level + 1)).toBeGreaterThan(totalXpForLevel(level));
    }
  });
});

describe("round-tripping totals against levels", () => {
  it("names every level exactly at its own threshold", () => {
    for (let level = 1; level <= MAX_LEVEL; level += 1) {
      const progress = levelFromTotalXp(totalXpForLevel(level));
      expect(progress.level).toBe(level);
      expect(progress.xpIntoLevel).toBe(0);
    }
  });

  it("names the level below one XP short of the threshold", () => {
    for (let level = 2; level <= MAX_LEVEL; level += 1) {
      const progress = levelFromTotalXp(totalXpForLevel(level) - 1);
      expect(progress.level).toBe(level - 1);
      expect(progress.xpRemaining).toBe(1);
    }
  });

  it("reports progress inside a level as a pair of integers", () => {
    // 1,800 XP is exactly level 10; 100 more is a tenth of the way through a
    // 325 XP level, and the module reports 100/325 rather than a percentage,
    // so no float ever names a level.
    const progress = levelFromTotalXp(1_900);
    expect(progress.level).toBe(10);
    expect(progress.xpIntoLevel).toBe(100);
    expect(progress.xpForNextLevel).toBe(325);
    expect(progress.xpRemaining).toBe(225);
    expect(progress.isMaxLevel).toBe(false);
  });

  it("never moves backwards as XP is added", () => {
    let previous = 1;
    for (let totalXp = 0; totalXp <= 35_000; totalXp += 7) {
      const { level } = levelFromTotalXp(totalXp);
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
    expect(previous).toBe(MAX_LEVEL);
  });
});

describe("zero and the first boundary", () => {
  it("starts a new player at level 1 with nothing earned", () => {
    const fresh = levelFromTotalXp(0);
    expect(fresh.level).toBe(1);
    expect(fresh.xpIntoLevel).toBe(0);
    expect(fresh.xpForNextLevel).toBe(100);
    expect(fresh.xpRemaining).toBe(100);
    expect(fresh.isMaxLevel).toBe(false);
  });

  it("levels up on the hundredth XP, not the ninety-ninth", () => {
    expect(levelFromTotalXp(99).level).toBe(1);
    expect(levelFromTotalXp(99).xpRemaining).toBe(1);
    expect(levelFromTotalXp(100).level).toBe(2);
    expect(levelFromTotalXp(100).xpIntoLevel).toBe(0);
    expect(levelFromTotalXp(101).xpIntoLevel).toBe(1);
  });
});

describe("the level cap", () => {
  it("caps exactly at the threshold, with no next level", () => {
    const capped = levelFromTotalXp(XP_AT_MAX_LEVEL);
    expect(capped.level).toBe(MAX_LEVEL);
    expect(capped.isMaxLevel).toBe(true);
    expect(capped.xpIntoLevel).toBe(0);
    expect(capped.xpForNextLevel).toBeNull();
    expect(capped.xpRemaining).toBeNull();
  });

  it("is one XP away from the cap at one XP below it", () => {
    const almost = levelFromTotalXp(XP_AT_MAX_LEVEL - 1);
    expect(almost.level).toBe(49);
    expect(almost.isMaxLevel).toBe(false);
    expect(almost.xpForNextLevel).toBe(1_300);
    expect(almost.xpRemaining).toBe(1);
  });

  it("never produces level 51, a negative remainder or a zero divisor", () => {
    for (const totalXp of [XP_AT_MAX_LEVEL + 1, 100_000, 9_007_199_254_740_991]) {
      const beyond = levelFromTotalXp(totalXp);
      expect(beyond.level).toBe(MAX_LEVEL);
      expect(beyond.isMaxLevel).toBe(true);
      expect(beyond.xpForNextLevel).toBeNull();
      expect(beyond.xpRemaining).toBeNull();
      // The surplus is real and is reported as such, never hidden and never
      // turned into a negative.
      expect(beyond.xpIntoLevel).toBe(totalXp - XP_AT_MAX_LEVEL);
      expect(beyond.xpIntoLevel).toBeGreaterThan(0);
    }
  });

  it("still awards XP to a maxed-out player", () => {
    // The award side knows nothing about levels: XP keeps accruing, and only
    // the display stops moving.
    const result = award([hands(10)]);
    expect(result.totalXpGranted).toBe(50);
    expect(levelFromTotalXp(XP_AT_MAX_LEVEL + result.totalXpGranted).level).toBe(MAX_LEVEL);
  });
});

describe("integer discipline", () => {
  it("returns integers for every derived figure", () => {
    for (const totalXp of [0, 1, 99, 100, 1_799, 1_800, XP_AT_MAX_LEVEL - 1, XP_AT_MAX_LEVEL, 500_000]) {
      const progress = levelFromTotalXp(totalXp);
      expect(Number.isInteger(progress.level)).toBe(true);
      expect(Number.isInteger(progress.xpIntoLevel)).toBe(true);
      if (progress.xpForNextLevel !== null) {
        expect(Number.isInteger(progress.xpForNextLevel)).toBe(true);
        expect(Number.isInteger(progress.xpRemaining)).toBe(true);
      }
    }
  });

  it("refuses a total XP that is not a whole non-negative number", () => {
    expect(() => levelFromTotalXp(-1)).toThrow(RangeError);
    expect(() => levelFromTotalXp(100.5)).toThrow(RangeError);
    expect(() => levelFromTotalXp(Number.NaN)).toThrow(RangeError);
    expect(() => levelFromTotalXp(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("refuses a fractional or negative award amount", () => {
    expect(() => award([hands(1.5)])).toThrow(RangeError);
    expect(() => award([decisions(-2)])).toThrow(RangeError);
    expect(() => award([{ kind: "career_star", xp: 12.5 }])).toThrow(RangeError);
    expect(() => award([hands(1)], -5)).toThrow(RangeError);
  });
});

describe("XP rates", () => {
  it("pays 5 per settled hand and 2 per unaided correct decision", () => {
    expect(XP_PER_SETTLED_HAND).toBe(5);
    expect(XP_PER_UNAIDED_CORRECT_DECISION).toBe(2);
    expect(award([hands(1)]).totalXpGranted).toBe(5);
    expect(award([decisions(1)]).totalXpGranted).toBe(2);
    expect(award([hands(12), decisions(9)]).totalXpGranted).toBe(78);
  });

  it("pays nothing for nothing", () => {
    const nothing = award([]);
    expect(nothing.totalXpGranted).toBe(0);
    expect(nothing.repeatableXpGranted).toBe(0);
    expect(nothing.oneTimeXpGranted).toBe(0);
    expect(nothing.dailyRepeatableXpRemaining).toBe(DAILY_REPEATABLE_XP_CAP);

    expect(award([hands(0), decisions(0)]).totalXpGranted).toBe(0);
  });

  it("depends only on how many hands settled, never on what they were worth", () => {
    // The structural guarantee is in the type — there is no wager field to
    // pass — and this is the arithmetic half of it: ten hands are ten hands,
    // and the only way to earn more is to play more or to play better.
    expect(award([hands(10)]).totalXpGranted).toBe(50);
    expect(award([hands(10)]).totalXpGranted).toBe(award([hands(10)]).totalXpGranted);
    expect(award([hands(10), decisions(10)]).totalXpGranted).toBe(70);
    expect(award([hands(20)]).totalXpGranted).toBe(100);
  });
});

describe("where XP may be earned", () => {
  it("grants nothing at all for Practice", () => {
    const practice = award([hands(40, "practice"), decisions(40, "practice")]);
    expect(practice.totalXpGranted).toBe(0);
    expect(practice.repeatableXpGranted).toBe(0);
    // Reported, not silently dropped: a nonzero figure here means someone
    // mislabelled a session.
    expect(practice.ineligibleXpDiscarded).toBe(280);
    expect(practice.dailyRepeatableXpAfter).toBe(0);
  });

  it("grants nothing at a private unranked table", () => {
    const priv = award([hands(20, "private_unranked"), decisions(10, "private_unranked")]);
    expect(priv.totalXpGranted).toBe(0);
    expect(priv.ineligibleXpDiscarded).toBe(120);
  });

  it("earns on ranked online and career hands", () => {
    expect(venueEarnsPlayXp("online_cash")).toBe(true);
    expect(venueEarnsPlayXp("career")).toBe(true);
    expect(award([hands(6, "career")]).repeatableXpGranted).toBe(30);
  });

  it("does not pay per hand where a placement or completion already pays", () => {
    // Tournaments and the daily challenge settle hands too; paying for both
    // would pay twice for the same session.
    expect(venueEarnsPlayXp("tournament")).toBe(false);
    expect(venueEarnsPlayXp("daily_challenge")).toBe(false);
    expect(award([hands(30, "tournament")]).totalXpGranted).toBe(0);
  });
});

describe("the daily cap", () => {
  it("caps repeatable XP at exactly 300", () => {
    expect(DAILY_REPEATABLE_XP_CAP).toBe(300);

    // 60 settled hands is exactly the cap.
    const exact = award([hands(60)]);
    expect(exact.repeatableXpGranted).toBe(300);
    expect(exact.repeatableXpForfeited).toBe(0);
    expect(exact.dailyRepeatableXpAfter).toBe(300);
    expect(exact.dailyRepeatableXpRemaining).toBe(0);
  });

  it("grants all of 299 and leaves one XP of allowance", () => {
    const under = award([hands(59), decisions(2)]);
    expect(under.repeatableXpGranted).toBe(299);
    expect(under.repeatableXpForfeited).toBe(0);
    expect(under.dailyRepeatableXpRemaining).toBe(1);
  });

  it("forfeits the 301st XP and says so", () => {
    const over = award([hands(59), decisions(3)]);
    expect(over.repeatableXpGranted).toBe(300);
    expect(over.repeatableXpForfeited).toBe(1);
    expect(over.dailyRepeatableXpAfter).toBe(300);
    expect(over.dailyRepeatableXpRemaining).toBe(0);
  });

  it("grants only the sliver left when the day is nearly spent", () => {
    const sliver = award([hands(1)], 299);
    expect(sliver.repeatableXpGranted).toBe(1);
    expect(sliver.repeatableXpForfeited).toBe(4);
    expect(sliver.dailyRepeatableXpAfter).toBe(300);
  });

  it("grants nothing repeatable once the day is spent", () => {
    const spent = award([hands(20), decisions(10)], 300);
    expect(spent.repeatableXpGranted).toBe(0);
    expect(spent.repeatableXpForfeited).toBe(120);
    expect(spent.dailyRepeatableXpRemaining).toBe(0);
  });

  it("caps tournament and daily challenge XP too", () => {
    // Competitive rewards are repeatable, so a 500 XP placement lands inside
    // the same allowance as the hands.
    const placement = award([{ kind: "tournament_placement", xp: 500 }]);
    expect(placement.repeatableXpGranted).toBe(300);
    expect(placement.repeatableXpForfeited).toBe(200);

    const daily = award([{ kind: "daily_challenge", xp: 150 }, hands(40)]);
    expect(daily.repeatableXpGranted).toBe(300);
    expect(daily.repeatableXpForfeited).toBe(50);
  });

  it("applies the cap to the batch, however the caller grouped it", () => {
    const oneEvent = award([hands(80)]);
    const manyEvents = award([hands(20), hands(20), hands(20), hands(20)]);
    expect(manyEvents).toEqual(oneEvent);
    expect(oneEvent.repeatableXpGranted).toBe(300);
  });

  it("leaves no allowance, and no negative one, if the counter is already past the cap", () => {
    const drifted = award([hands(10)], 350);
    expect(drifted.repeatableXpGranted).toBe(0);
    expect(drifted.dailyRepeatableXpRemaining).toBe(0);
    expect(drifted.dailyRepeatableXpAfter).toBe(350);
  });
});

describe("one-time career XP is outside the cap", () => {
  it("grants a career star bonus in full on a day that is already spent", () => {
    const star = award([hands(10), { kind: "career_star", xp: 100 }], 300);

    expect(star.repeatableXpGranted).toBe(0);
    expect(star.repeatableXpForfeited).toBe(50);
    expect(star.oneTimeXpGranted).toBe(100);
    expect(star.totalXpGranted).toBe(100);
  });

  it("never advances the daily counter with one-time XP", () => {
    // The counter must stay pure repeatable XP, or a career reward would also
    // be spent against tomorrow's allowance.
    const star = award([{ kind: "career_star", xp: 250 }]);
    expect(star.dailyRepeatableXpAfter).toBe(0);
    expect(star.dailyRepeatableXpRemaining).toBe(DAILY_REPEATABLE_XP_CAP);
    expect(star.totalXpGranted).toBe(250);
  });

  it("keeps capped and uncapped amounts separate in one mixed award", () => {
    const mixed = award(
      [hands(50), decisions(10), { kind: "career_star", xp: 40 }],
      200,
    );
    // 270 repeatable requested, 100 of allowance left.
    expect(mixed.repeatableXpGranted).toBe(100);
    expect(mixed.repeatableXpForfeited).toBe(170);
    expect(mixed.oneTimeXpGranted).toBe(40);
    expect(mixed.totalXpGranted).toBe(140);
    expect(mixed.dailyRepeatableXpAfter).toBe(300);
  });

  it("carries a one-time reward past the cap and into a real level", () => {
    const before = levelFromTotalXp(90);
    expect(before.level).toBe(1);

    const granted = award([hands(4), { kind: "career_star", xp: 40 }], 300);
    expect(granted.totalXpGranted).toBe(40);
    expect(levelFromTotalXp(90 + granted.totalXpGranted).level).toBe(2);
  });
});

describe("the day is passed in, never read", () => {
  it("echoes the day it judged the award against", () => {
    expect(award([hands(1)]).utcDay).toBe(DAY);
  });

  it("is identical on repeated calls, because nothing here reads a clock", () => {
    const first = award([hands(3), decisions(2)], 100);
    const second = award([hands(3), decisions(2)], 100);
    expect(second).toEqual(first);
  });

  it("rejects a day key of the wrong shape", () => {
    // The key is the identity of the daily counter: a second shape would be a
    // second allowance.
    expect(isUtcDay("2026-08-15")).toBe(true);
    expect(isUtcDay("2026-08-15T00:00:00Z")).toBe(false);
    expect(isUtcDay("15/08/2026")).toBe(false);
    expect(isUtcDay("2026-13-01")).toBe(false);
    expect(isUtcDay("")).toBe(false);

    expect(() => awardXp({ utcDay: "today", repeatableXpEarnedOnDay: 0, events: [] })).toThrow(
      RangeError,
    );
  });
});
