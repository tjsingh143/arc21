/**
 * THE TWO PROBABILITIES THE ANALYSIS SURFACE SHOWS, CHECKED AGAINST SOMETHING
 * THAT IS NOT THE SOLVER.
 *
 * `bustIfHit` and `dealerBust` are the only analytics Arc 21 puts on screen
 * beside an expected value, so they carry the same obligation the chart does:
 * "do not accept a table merely because every cell has a value". Re-running the
 * function that produced them would prove only that it is deterministic.
 *
 * So each is checked by a genuinely different derivation:
 *
 *   - `bustIfHit` against closed-form card counting, written out per case. The
 *     pair rows are used because exactly one two-card composition makes them, so
 *     the cell's aggregate IS that composition's value and there is no weighting
 *     to reason about — the comparison is exact rather than approximate.
 *   - `dealerBust` against a Monte Carlo that deals from a real six-deck multiset
 *     and plays the dealer out under the rule read from `ARC_STANDARD_RULES`.
 *     It shares no code with `dealerFinalDistribution`, which is the point: a
 *     mistake in the peek conditioning or in the recursion shows up as a gap far
 *     wider than the sampling error.
 *
 * The last describe block plants wrong numbers and proves both checks reject
 * them.
 */

import { describe, expect, it } from "vitest";

import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";
import { ARC_STANDARD_STRATEGY_TABLE } from "../../supabase/functions/_shared/strategy/generated-arc-standard-v1.js";
import type { StrategyDecision } from "../../supabase/functions/_shared/strategy/types.js";

const ENTRIES = Object.values(ARC_STANDARD_STRATEGY_TABLE.entries);

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe("every cell carries both probabilities", () => {
  it("covers the whole table", () => {
    expect(ENTRIES.length).toBe(380);
    const missing = ENTRIES.filter((entry) => entry.probabilities === undefined);
    expect(missing.map((entry) => entry.key)).toEqual([]);
  });

  it("keeps both inside [0, 1]", () => {
    for (const entry of ENTRIES) {
      const p = entry.probabilities!;
      expect(p.bustIfHit, entry.key).toBeGreaterThanOrEqual(0);
      expect(p.bustIfHit, entry.key).toBeLessThanOrEqual(1);
      expect(p.dealerBust, entry.key).toBeGreaterThan(0);
      expect(p.dealerBust, entry.key).toBeLessThan(1);
    }
  });

  it("says a soft hand cannot bust on one card, in every soft cell", () => {
    // Not a convention: a hand whose ace can drop from 11 to 1 has at least ten
    // points of slack, and no single card is worth more than ten. A non-zero
    // here would mean the hand classifier and the probability disagree about
    // what "soft" means.
    const soft = ENTRIES.filter((entry) => entry.handClass === "soft");
    expect(soft.length).toBeGreaterThan(0);
    for (const entry of soft) {
      expect(entry.probabilities!.bustIfHit, entry.key).toBe(0);
    }
    // Pair of aces is classed as a pair but is equally soft.
    for (const entry of ENTRIES.filter((e) => e.handClass === "pair" && e.pairValue === 11)) {
      expect(entry.probabilities!.bustIfHit, entry.key).toBe(0);
    }
  });

  it("never claims a hard hand under 12 can bust on one card", () => {
    for (const entry of ENTRIES.filter((e) => e.handClass === "hard" && e.playerTotal <= 11)) {
      expect(entry.probabilities!.bustIfHit, entry.key).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// bustIfHit — closed form
// ---------------------------------------------------------------------------

/** Copies of each value in a fresh six-deck shoe. Aces counted at index 1. */
function sixDeckCounts(): number[] {
  const counts = new Array<number>(11).fill(0);
  for (let value = 1; value <= 9; value += 1) counts[value] = 4 * 6;
  counts[10] = 16 * 6;
  return counts;
}

function cell(key: string): StrategyDecision {
  const found = ARC_STANDARD_STRATEGY_TABLE.entries[key];
  if (found === undefined) throw new Error(`No cell ${key}`);
  return found;
}

describe("bustIfHit agrees with counting the shoe by hand", () => {
  /**
   * A pair row has exactly one two-card composition, so no weighting is
   * involved and the arithmetic below is the whole answer rather than an
   * approximation of it.
   */
  const cases: { key: string; hold: number[]; upcard: number; minDraw: number }[] = [
    // 8,8 is a hard 16: any card of 6 or more takes it past 21.
    { key: "pair:8:7", hold: [8, 8], upcard: 7, minDraw: 6 },
    { key: "pair:8:10", hold: [8, 8], upcard: 10, minDraw: 6 },
    // 10,10 is a hard 20: everything but an ace busts it.
    { key: "pair:10:7", hold: [10, 10], upcard: 7, minDraw: 2 },
    // 6,6 is a hard 12: only a ten busts it.
    { key: "pair:6:2", hold: [6, 6], upcard: 2, minDraw: 10 },
    // 9,9 is a hard 18: a 4 or more busts it.
    { key: "pair:9:6", hold: [9, 9], upcard: 6, minDraw: 4 },
  ];

  for (const { key, hold, upcard, minDraw } of cases) {
    it(`${key} — ${hold.join(",")} against ${upcard}`, () => {
      const counts = sixDeckCounts();
      for (const card of [...hold, upcard]) counts[card] = (counts[card] ?? 0) - 1;

      const remaining = counts.reduce((sum, n) => sum + n, 0);
      let busting = 0;
      // An ace can always count as 1, so it never busts a hand on its own; the
      // loop starts at 2 and `minDraw` is expressed in that vocabulary.
      for (let value = minDraw; value <= 10; value += 1) busting += counts[value] ?? 0;

      const expected = busting / remaining;
      expect(cell(key).probabilities!.bustIfHit).toBeCloseTo(expected, 5);
    });
  }

  it("is worse to hit a bigger hard total, holding the upcard fixed", () => {
    // A weak monotonicity that any correct computation satisfies and a
    // transposed or misindexed table does not.
    const hard = ENTRIES.filter((e) => e.handClass === "hard" && e.dealerUpcardValue === 6).sort(
      (a, b) => a.playerTotal - b.playerTotal,
    );
    expect(hard.length).toBeGreaterThan(10);
    for (let index = 1; index < hard.length; index += 1) {
      expect(
        hard[index]!.probabilities!.bustIfHit,
        `${hard[index]!.key} vs ${hard[index - 1]!.key}`,
      ).toBeGreaterThanOrEqual(hard[index - 1]!.probabilities!.bustIfHit - 1e-9);
    }
  });
});

// ---------------------------------------------------------------------------
// dealerBust — Monte Carlo
// ---------------------------------------------------------------------------

/** Deterministic PRNG. A test that reshuffles between runs cannot be triaged. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawFrom(counts: number[], roll: number): number {
  const remaining = counts.reduce((sum, n) => sum + n, 0);
  let target = Math.floor(roll * remaining);
  for (let value = 1; value <= 10; value += 1) {
    target -= counts[value] ?? 0;
    if (target < 0) {
      counts[value] = (counts[value] ?? 0) - 1;
      return value;
    }
  }
  // Only reachable on a roll of exactly 1, which mulberry32 never returns.
  throw new Error("drew from an empty shoe");
}

/**
 * Plays the dealer out and reports whether they busted.
 *
 * The soft-17 rule is read from the ruleset rather than written in, so a variant
 * that flips it makes this simulation follow, instead of quietly checking the
 * wrong game.
 */
function dealerBusts(counts: number[], upcard: number, hole: number, next: () => number): boolean {
  let hard = upcard + hole;
  let aces = (upcard === 1 ? 1 : 0) + (hole === 1 ? 1 : 0);

  for (;;) {
    const soft = aces > 0 && hard + 10 <= 21;
    const best = soft ? hard + 10 : hard;

    if (best > 21) return true;
    if (best > 17) return false;
    if (best === 17) {
      if (!(soft && ARC_STANDARD_RULES.dealerHitsSoft17)) return false;
    }

    const card = drawFrom(counts, next());
    hard += card;
    if (card === 1) aces += 1;
  }
}

describe("dealerBust agrees with dealing the shoe out", () => {
  const TRIALS = 120_000;

  /**
   * Pair rows again, for the same reason: one composition, so the cell's
   * `dealerBust` is conditioned on exactly the two cards this simulation
   * removes.
   */
  const cases: { key: string; hold: number[]; upcard: number }[] = [
    { key: "pair:8:2", hold: [8, 8], upcard: 2 },
    { key: "pair:8:6", hold: [8, 8], upcard: 6 },
    { key: "pair:8:7", hold: [8, 8], upcard: 7 },
    { key: "pair:8:10", hold: [8, 8], upcard: 10 },
    { key: "pair:8:11", hold: [8, 8], upcard: 1 },
  ];

  for (const { key, hold, upcard } of cases) {
    it(`${key} — dealer showing ${upcard === 1 ? "ace" : upcard}`, () => {
      const next = mulberry32(0x5eed_0000 + upcard);
      // The hole card that would make a natural. The dealer has already peeked
      // and not found one, so those deals are rejected rather than counted —
      // which is the conditioning the solver applies and the single easiest
      // thing to get wrong.
      const naturalHole = upcard === 1 ? 10 : upcard === 10 ? 1 : 0;

      let busts = 0;
      let played = 0;
      while (played < TRIALS) {
        const counts = sixDeckCounts();
        for (const card of [...hold, upcard]) counts[card] = (counts[card] ?? 0) - 1;

        const hole = drawFrom(counts, next());
        if (hole === naturalHole) continue;

        played += 1;
        if (dealerBusts(counts, upcard, hole, next)) busts += 1;
      }

      const measured = busts / played;
      const stated = cell(key).probabilities!.dealerBust;

      // Three standard errors of a 120k-trial proportion is about 0.0043. The
      // tolerance is stated in those terms rather than picked, so it is a
      // sampling allowance and not a fudge factor.
      const standardError = Math.sqrt((measured * (1 - measured)) / played);
      // The gate's own power, asserted rather than assumed: at this trial count
      // the allowance is under a percentage point, so an error large enough to
      // change what a player reads cannot hide inside it. A future edit that
      // cuts TRIALS to make the suite faster fails here instead of silently
      // becoming a test that passes for anything.
      expect(4 * standardError).toBeLessThan(0.01);
      expect(Math.abs(measured - stated), `${key}: simulated ${measured}, table ${stated}`).toBeLessThan(
        4 * standardError,
      );
    });
  }

  it("ranks the upcards the way the game does", () => {
    // 6 is the dealer's worst card and an ace is their best. A table that had
    // these the wrong way round would still pass a range check.
    const bustFor = (upcard: number) => cell(`pair:8:${upcard}`).probabilities!.dealerBust;
    expect(bustFor(6)).toBeGreaterThan(bustFor(2));
    expect(bustFor(2)).toBeGreaterThan(bustFor(7));
    expect(bustFor(7)).toBeGreaterThan(bustFor(10));
    expect(bustFor(10)).toBeGreaterThan(bustFor(11));
  });
});

// ---------------------------------------------------------------------------
// Discrimination
// ---------------------------------------------------------------------------

describe("both checks reject a wrong number", () => {
  it("closed-form counting rejects a plausible-looking bustIfHit", () => {
    const counts = sixDeckCounts();
    for (const card of [8, 8, 7]) counts[card] = (counts[card] ?? 0) - 1;
    const remaining = counts.reduce((sum, n) => sum + n, 0);
    let busting = 0;
    for (let value = 6; value <= 10; value += 1) busting += counts[value] ?? 0;
    const truth = busting / remaining;

    // The number you get by forgetting to remove the player's own cards.
    const naive = (24 + 24 + 24 + 24 + 96) / 312;
    expect(naive).not.toBeCloseTo(truth, 5);
    expect(cell("pair:8:7").probabilities!.bustIfHit).toBeCloseTo(truth, 5);
  });

  it("the simulation separates peeked from unpeeked conditioning", () => {
    // Against an ace, NOT conditioning on the peek leaves the ten in the shoe
    // and drops the bust rate by more than ten points. If the tolerance above
    // could not tell those apart it would not be testing the conditioning.
    const next = mulberry32(0xc0ffee);
    let busts = 0;
    for (let trial = 0; trial < 40_000; trial += 1) {
      const counts = sixDeckCounts();
      for (const card of [8, 8, 1]) counts[card] = (counts[card] ?? 0) - 1;
      const hole = drawFrom(counts, next());
      // Deliberately no rejection of the natural.
      if (dealerBusts(counts, 1, hole, next)) busts += 1;
    }
    const unconditioned = busts / 40_000;
    const stated = cell("pair:8:11").probabilities!.dealerBust;
    expect(stated - unconditioned).toBeGreaterThan(0.03);
  });
});
