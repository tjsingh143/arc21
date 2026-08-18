/**
 * Guest → account conversion.
 *
 * The threat this file exists for: everything a guest owns lives in a local
 * database on a device the player fully controls. If any of it could become
 * server state at sign-up, the server-authority model would have a hole in it
 * shaped like a registration form — play offline, edit the save, create an
 * account, arrive rich and undefeated.
 *
 * So the tests below do not merely check that the current implementation happens
 * not to copy chips. They check that a *tampered* local save produces a plan
 * with no economic content at all, that imported history cannot be labelled
 * competitive, and that the guard rejects a plan that has grown a new field —
 * which is the shape the regression would actually take.
 */

import { describe, expect, it } from "vitest";

import {
  assertNoEconomicImport,
  buildGuestConversionPlan,
  describeConversion,
  type GuestConversionPlan,
} from "../../src/features/auth/conversion.js";
import { DEFAULT_SETTINGS } from "../../src/features/settings/settings.js";
import type { PracticeStats } from "../../src/features/practice/practice-store.js";

const NOW = new Date("2026-08-15T12:00:00.000Z");

const STATS: PracticeStats = {
  handsPlayed: 420,
  decisions: 1_000,
  correct: 940,
  unaidedDecisions: 800,
  unaidedCorrect: 730,
  estimatedEvLost: 12.4,
  hardDecisions: 500,
  hardCorrect: 470,
  softDecisions: 300,
  softCorrect: 280,
  pairDecisions: 200,
  pairCorrect: 190,
};

function plan(stats: PracticeStats | null = STATS): GuestConversionPlan {
  return buildGuestConversionPlan({
    guestId: "guest_1f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
    preferences: { ...DEFAULT_SETTINGS, soundEnabled: false, hapticsEnabled: false },
    stats,
    now: NOW,
  });
}

describe("what carries over", () => {
  it("carries preferences verbatim", () => {
    expect(plan().preferences.soundEnabled).toBe(false);
    expect(plan().preferences.hapticsEnabled).toBe(false);
    expect(plan().preferences.statsVisibility).toBe(DEFAULT_SETTINGS.statsVisibility);
  });

  it("imports practice statistics as practice-scoped, non-competitive history", () => {
    const history = plan().practiceHistory;

    expect(history).not.toBeNull();
    expect(history?.scope).toBe("practice");
    expect(history?.competitive).toBe(false);
    expect(history?.selfReported).toBe(true);
    expect(history?.handsPlayed).toBe(420);
  });

  it("imports nothing when there is nothing to import", () => {
    expect(plan(null).practiceHistory).toBeNull();
  });

  it("leaves the floating-point EV estimate behind", () => {
    // No float belongs in anything account-scoped, and the figure means nothing
    // outside the local session that produced it.
    expect(JSON.stringify(plan())).not.toContain("estimatedEvLost");
  });
});

describe("no chips are ever fabricated", () => {
  it("produces a plan with no economic field at all", () => {
    // `discarded` is excluded because its whole job is to *name* the things
    // that do not travel — "LOCAL_BANKROLL" is the label on the omission, not a
    // value being carried.
    const serialised = JSON.stringify({ ...plan(), discarded: [] });

    for (const forbidden of [
      "chips",
      "balance",
      "wallet",
      "ledger",
      "delta",
      "credit",
      "idempotency",
      "bankroll",
    ]) {
      expect(serialised.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it("ignores a tampered local bankroll entirely", () => {
    // The practice bankroll is not even an input to the plan builder — there is
    // no parameter to pass it through. This test states that as a fact.
    const tampered = buildGuestConversionPlan({
      guestId: "guest_x",
      preferences: DEFAULT_SETTINGS,
      stats: { ...STATS, handsPlayed: 9_999_999 },
      now: NOW,
    });

    expect(Object.keys(tampered).sort()).toEqual([
      "convertedAt",
      "discarded",
      "guestId",
      "practiceHistory",
      "preferences",
    ]);
    expect(assertNoEconomicImport(tampered)).toBeUndefined();
  });

  it("names what is deliberately dropped, on every conversion", () => {
    expect([...plan().discarded].sort()).toEqual([
      "LOCAL_ACHIEVEMENTS",
      "LOCAL_BANKROLL",
      "LOCAL_CAREER_STARS",
      "LOCAL_LEADERBOARD_STANDING",
    ]);
  });

  it("tells the player, in words, what does not travel", () => {
    const lines = describeConversion(plan()).join(" ");

    expect(lines).toContain("Practice chips stay in Practice");
    expect(lines).toContain("leaderboard");
  });
});

describe("tampered statistics are sanitised, not trusted", () => {
  it("clamps negatives to zero", () => {
    const history = buildGuestConversionPlan({
      guestId: "g",
      preferences: DEFAULT_SETTINGS,
      stats: { ...STATS, handsPlayed: -5, decisions: -1, correct: -1 },
      now: NOW,
    }).practiceHistory;

    expect(history?.handsPlayed).toBe(0);
    expect(history?.decisions).toBe(0);
    expect(history?.correct).toBe(0);
  });

  it("clamps a correct count larger than its own denominator", () => {
    // 4,000 correct out of 10 decisions is not a statistic, it is a claim.
    const history = buildGuestConversionPlan({
      guestId: "g",
      preferences: DEFAULT_SETTINGS,
      stats: { ...STATS, decisions: 10, correct: 4_000, unaidedDecisions: 10, unaidedCorrect: 99 },
      now: NOW,
    }).practiceHistory;

    expect(history?.correct).toBe(10);
    expect(history?.unaidedCorrect).toBe(10);
  });

  it("coerces fractional and non-finite counts to integers", () => {
    const history = buildGuestConversionPlan({
      guestId: "g",
      preferences: DEFAULT_SETTINGS,
      stats: { ...STATS, handsPlayed: 3.9, decisions: Number.NaN, softDecisions: Infinity },
      now: NOW,
    }).practiceHistory;

    expect(history?.handsPlayed).toBe(3);
    expect(history?.decisions).toBe(0);
    expect(history?.softDecisions).toBe(0);
  });

  it("keeps every imported count a non-negative integer", () => {
    const history = plan().practiceHistory as unknown as Record<string, unknown>;

    for (const [key, value] of Object.entries(history)) {
      if (typeof value !== "number") continue;
      expect(Number.isInteger(value), key).toBe(true);
      expect(value, key).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the guard", () => {
  it("passes a well-formed plan", () => {
    expect(() => assertNoEconomicImport(plan())).not.toThrow();
    expect(() => assertNoEconomicImport(plan(null))).not.toThrow();
  });

  it("rejects a plan that has grown a field", () => {
    // This is the shape the regression would actually take: someone adds one
    // helpful-looking field to the plan type.
    const widened = { ...plan(), openingChipGrant: 250_000 } as unknown as GuestConversionPlan;

    expect(() => assertNoEconomicImport(widened)).toThrow(/unexpected field/i);
  });

  it("rejects history that has been relabelled as competitive", () => {
    const relabelled = {
      ...plan(),
      practiceHistory: { ...plan().practiceHistory, competitive: true },
    } as unknown as GuestConversionPlan;

    expect(() => assertNoEconomicImport(relabelled)).toThrow(/non-competitive/i);
  });

  it("rejects history whose scope has been widened", () => {
    const relabelled = {
      ...plan(),
      practiceHistory: { ...plan().practiceHistory, scope: "ranked" },
    } as unknown as GuestConversionPlan;

    expect(() => assertNoEconomicImport(relabelled)).toThrow(/practice-scoped/i);
  });

  it("rejects a smuggled field inside the imported history", () => {
    const smuggled = {
      ...plan(),
      practiceHistory: { ...plan().practiceHistory, chipsWon: 10_000 },
    } as unknown as GuestConversionPlan;

    expect(() => assertNoEconomicImport(smuggled)).toThrow(/unexpected field/i);
  });

  it("rejects a non-integer count that bypassed the builder", () => {
    const forged = {
      ...plan(),
      practiceHistory: { ...plan().practiceHistory, handsPlayed: -1 },
    } as unknown as GuestConversionPlan;

    expect(() => assertNoEconomicImport(forged)).toThrow(/non-negative integer/i);
  });
});
