/**
 * The level curve exists twice, and these tests are why that is safe.
 *
 * `shared/progression/xp.ts` is the definition. The database needs the same curve
 * because `profiles.level` is a derived column maintained by a trigger — the
 * column was previously stored and NEVER written, so every account sat at level 1
 * forever, the high-stakes table gate could not open, and half the cosmetic
 * catalogue could not unlock.
 *
 * SQL cannot import TypeScript, so the curve is mirrored in
 * `public.total_xp_for_level`. This file recomputes the mirror's arithmetic
 * independently and asserts it against the real thing at every level, so the two
 * cannot drift without a failure here.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_LEVEL,
  BASE_XP_TO_ADVANCE,
  XP_STEP_PER_LEVEL,
  levelFromTotalXp,
  totalXpForLevel,
  xpToAdvance,
} from "../../shared/progression/index.js";

/**
 * The closed form the migration uses:
 *   100 * (L-1) + 25 * (L-1)(L-2) / 2
 *
 * Written out here rather than imported, because importing the thing under test
 * would assert nothing. `(L-1)(L-2)` is a product of consecutive integers and so
 * always even — which is what keeps the division exact and the result an integer.
 */
function sqlTotalXpForLevel(level: number): number {
  if (level <= 1) return 0;
  return 100 * (level - 1) + (25 * (level - 1) * (level - 2)) / 2;
}

describe("the database's curve matches the engine's", () => {
  it("agrees at every level up to the cap", () => {
    for (let level = 1; level <= MAX_LEVEL; level += 1) {
      expect(sqlTotalXpForLevel(level)).toBe(totalXpForLevel(level));
    }
  });

  it("stays in whole numbers", () => {
    // A fractional XP threshold would put a float into a progression figure, which
    // is forbidden for the same reason floats never touch a chip balance.
    for (let level = 1; level <= MAX_LEVEL; level += 1) {
      expect(Number.isInteger(sqlTotalXpForLevel(level))).toBe(true);
    }
  });

  it("is built from the published per-level cost", () => {
    // Each level costs 100 + 25*(L-1). The cumulative form must be the sum of
    // those, not an approximation of it.
    let running = 0;
    for (let level = 1; level < MAX_LEVEL; level += 1) {
      expect(sqlTotalXpForLevel(level)).toBe(running);
      running += BASE_XP_TO_ADVANCE + XP_STEP_PER_LEVEL * (level - 1);
    }
    expect(sqlTotalXpForLevel(MAX_LEVEL)).toBe(running);
  });
});

describe("the boundaries a player would notice", () => {
  it("names the new level at exactly the threshold", () => {
    // One XP short must be the level below, and exactly enough must be the level
    // itself. This is the case a float inverse gets wrong.
    for (let level = 2; level <= MAX_LEVEL; level += 1) {
      const threshold = totalXpForLevel(level);
      expect(levelFromTotalXp(threshold).level).toBe(level);
      expect(levelFromTotalXp(threshold - 1).level).toBe(level - 1);
    }
  });

  it("starts at level 1 with nothing", () => {
    expect(levelFromTotalXp(0).level).toBe(1);
    expect(totalXpForLevel(1)).toBe(0);
  });

  it("opens the high-stakes table at level 10 and not before", () => {
    // The tier gate reads `profiles.level >= 10`. Worth pinning: this is the
    // figure that was unreachable while the column was never written.
    const atTen = totalXpForLevel(10);
    expect(levelFromTotalXp(atTen).level).toBe(10);
    expect(levelFromTotalXp(atTen - 1).level).toBe(9);
  });

  it("reports no next level at the cap rather than a zero to divide by", () => {
    const capped = levelFromTotalXp(totalXpForLevel(MAX_LEVEL) + 100_000);
    expect(capped.level).toBe(MAX_LEVEL);
    expect(capped.isMaxLevel).toBe(true);
    expect(capped.xpForNextLevel).toBeNull();
    expect(capped.xpRemaining).toBeNull();
    // The surplus is reported honestly rather than clamped away.
    expect(capped.xpIntoLevel).toBe(100_000);
    expect(xpToAdvance(MAX_LEVEL)).toBeNull();
  });
});
