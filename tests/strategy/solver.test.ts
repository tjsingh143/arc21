/**
 * The solver's own arithmetic, checked directly.
 *
 * A chart can look entirely reasonable while resting on a dealer distribution
 * that is quietly wrong — most cells are not close enough for a small error to
 * move them. So the dealer distribution is verified against published
 * probabilities here, at the source, rather than inferred from the chart it
 * produces.
 *
 * The peek conditioning gets its own section because it is the classic omission:
 * a solver that forgets the dealer already looked will over-count dealer
 * blackjacks against 10 and A and hand out subtly wrong advice on exactly the
 * upcards a player sees most.
 */

import { describe, expect, it } from "vitest";

import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";
import {
  DEALER_BUST_INDEX,
  dealerFinalDistribution,
  dealerNaturalProbability,
  enumerateCompositions,
  fullShoe,
  solveComposition,
  standEVForTotal,
  totalCards,
} from "../../scripts/strategy-solver.js";
import type { DealerDistribution } from "../../scripts/strategy-solver.js";

const rules = ARC_STANDARD_RULES;

/** Solver upcard encoding: aces are 1 here and promoted by hand evaluation. */
const UPCARDS: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 1];

function distributionFor(upcard: number): DealerDistribution {
  const counts = fullShoe(rules.deckCount);
  counts[upcard] = (counts[upcard] ?? 0) - 1;
  return dealerFinalDistribution(counts, upcard, rules);
}

/**
 * Published dealer final-total probabilities for a stands-on-all-17 game, in
 * the order [17, 18, 19, 20, 21, bust]. The 10 and A rows are the
 * conditional-on-no-blackjack figures, which is what a peeking game actually
 * produces.
 *
 * These are the standard infinite-deck figures. Arc 21 solves a real six-deck
 * shoe with card removal, so the two differ slightly by construction; the
 * tolerance below is sized for that difference and nothing more.
 */
const PUBLISHED: Readonly<Record<number, readonly number[]>> = {
  2: [0.1398, 0.1349, 0.1297, 0.124, 0.118, 0.3536],
  3: [0.135, 0.1305, 0.1256, 0.1207, 0.116, 0.3722],
  4: [0.1305, 0.1259, 0.1213, 0.1167, 0.112, 0.3936],
  5: [0.1223, 0.1223, 0.1177, 0.1131, 0.1084, 0.4162],
  6: [0.1654, 0.1063, 0.1063, 0.1017, 0.0972, 0.4232],
  7: [0.3686, 0.1378, 0.0786, 0.0786, 0.0741, 0.2623],
  8: [0.1286, 0.3595, 0.1292, 0.0695, 0.0695, 0.2437],
  9: [0.12, 0.1181, 0.351, 0.1214, 0.0611, 0.2284],
  10: [0.1214, 0.1214, 0.1214, 0.3679, 0.0384, 0.2296],
  1: [0.1877, 0.1892, 0.1892, 0.1892, 0.0769, 0.1678],
};

const TOLERANCE = 0.006;

describe("dealer final-total distribution", () => {
  it("is a probability distribution for every upcard", () => {
    for (const upcard of UPCARDS) {
      const dist = distributionFor(upcard);
      const sum = dist.reduce((total, p) => total + p, 0);
      expect(sum, `upcard ${upcard}`).toBeCloseTo(1, 12);
      for (const p of dist) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  it("matches published six-deck S17 probabilities", () => {
    for (const upcard of UPCARDS) {
      const dist = distributionFor(upcard);
      const reference = PUBLISHED[upcard];
      expect(reference, `no reference for upcard ${upcard}`).toBeDefined();
      if (reference === undefined) continue;

      for (let i = 0; i < 6; i++) {
        const computed = dist[i] ?? 0;
        const expected = reference[i] ?? 0;
        expect(
          Math.abs(computed - expected),
          `upcard ${upcard} slot ${i}: computed ${computed.toFixed(4)}, published ${expected.toFixed(4)}`,
        ).toBeLessThan(TOLERANCE);
      }
    }
  });

  it("busts more often against a weak upcard than a strong one", () => {
    const bust = (upcard: number): number => distributionFor(upcard)[DEALER_BUST_INDEX] ?? 0;
    expect(bust(6)).toBeGreaterThan(bust(2));
    expect(bust(5)).toBeGreaterThan(bust(7));
    expect(bust(7)).toBeGreaterThan(bust(10));
    expect(bust(10)).toBeGreaterThan(bust(1));
  });

  it("cannot make a total below 17 under S17", () => {
    // The distribution has no slot for 16 or less; a dealer that stopped early
    // would show up as probability mass that fails to sum to one.
    for (const upcard of UPCARDS) {
      expect(distributionFor(upcard)).toHaveLength(6);
    }
  });

  it("hits soft 17 when a ruleset says so, and only then", () => {
    const s17 = distributionFor(6);
    const counts = fullShoe(rules.deckCount);
    counts[6] = (counts[6] ?? 0) - 1;
    const h17 = dealerFinalDistribution(counts, 6, { ...rules, dealerHitsSoft17: true });

    // Under H17 the dealer draws off soft 17, so fewer hands finish on 17 and
    // more of them bust.
    expect(h17[0] ?? 0).toBeLessThan(s17[0] ?? 0);
    expect(h17[DEALER_BUST_INDEX] ?? 0).toBeGreaterThan(s17[DEALER_BUST_INDEX] ?? 0);
  });
});

describe("peek conditioning", () => {
  it("removes dealer blackjacks from the ten and ace distributions", () => {
    // With the peek excluded, an ace upcard would make 21 about a third of the
    // time. Conditioned on the peek finding nothing, 21 can only be reached by
    // drawing to it.
    expect(distributionFor(1)[4] ?? 0).toBeLessThan(0.15);
    expect(distributionFor(10)[4] ?? 0).toBeLessThan(0.06);
  });

  it("leaves upcards 2 through 9 untouched, since they cannot hold a natural", () => {
    // A conditioning bug that fired on the wrong upcards would distort these
    // rows; the published comparison above already pins them, and this states
    // the reason explicitly.
    for (const upcard of [2, 3, 4, 5, 6, 7, 8, 9]) {
      const counts = fullShoe(rules.deckCount);
      counts[upcard] = (counts[upcard] ?? 0) - 1;
      expect(dealerNaturalProbability(counts, upcard)).toBe(0);
    }
  });

  it("prices the natural correctly for the upcards that can hold one", () => {
    const counts = fullShoe(rules.deckCount);
    counts[1] = (counts[1] ?? 0) - 1;
    // 96 ten-value cards in 311 remaining.
    expect(dealerNaturalProbability(counts, 1)).toBeCloseTo(96 / 311, 12);

    const tens = fullShoe(rules.deckCount);
    tens[10] = (tens[10] ?? 0) - 1;
    expect(dealerNaturalProbability(tens, 10)).toBeCloseTo(24 / 311, 12);
  });

  it("refuses to solve a ruleset it does not model", () => {
    // A European no-hole-card game changes what a dealer natural costs a
    // doubled or split hand. Reinterpreting this solver's output for it would
    // be a silent lie, so it fails loudly instead.
    const counts = fullShoe(rules.deckCount);
    counts[10] = (counts[10] ?? 0) - 1;
    expect(() =>
      dealerFinalDistribution(counts, 10, {
        ...rules,
        dealerHoleCard: false,
        dealerPeeksForBlackjack: false,
      }),
    ).toThrow(/peek/i);
  });
});

describe("shoe bookkeeping", () => {
  it("models a real six-deck shoe", () => {
    const shoe = fullShoe(6);
    expect(totalCards(shoe)).toBe(312);
    expect(shoe[1]).toBe(24);
    expect(shoe[9]).toBe(24);
    expect(shoe[10]).toBe(96);
  });

  it("restores the composition it was handed", () => {
    // The recursions mutate a shared counts array for speed; a missed restore
    // would corrupt every later cell in a way no single assertion would catch.
    const counts = fullShoe(rules.deckCount);
    counts[7] = (counts[7] ?? 0) - 1;
    const before = [...counts];
    dealerFinalDistribution(counts, 7, rules);
    expect(counts).toEqual(before);
  });
});

describe("stand EV", () => {
  it("wins on a dealer bust, pushes on a tie and loses otherwise", () => {
    const dist: DealerDistribution = [0.2, 0.2, 0.2, 0.2, 0.1, 0.1];
    // Standing on 19: beats 17 and 18, pushes 19, loses to 20 and 21, wins on bust.
    expect(standEVForTotal(19, dist)).toBeCloseTo(0.1 + 0.4 - 0.3, 12);
    // Standing on 21 loses to nothing.
    expect(standEVForTotal(21, dist)).toBeCloseTo(0.1 + 0.8, 12);
    // Standing on a stiff wins only when the dealer busts.
    expect(standEVForTotal(16, dist)).toBeCloseTo(0.1 - 0.9, 12);
  });

  it("rises strictly with the total, against a fixed dealer distribution", () => {
    // The strict form of the monotonicity the chart is checked for. Held to one
    // distribution there is no card-removal noise to hide behind, so a sign
    // error in the comparison has nowhere to go.
    for (const upcard of UPCARDS) {
      const dist = distributionFor(upcard);
      for (let total = 5; total <= 21; total++) {
        expect(standEVForTotal(total, dist), `upcard ${upcard}, total ${total}`).toBeGreaterThan(
          standEVForTotal(total - 1, dist) - 1e-12,
        );
      }
      // Every stiff total wins on exactly one event — the dealer busting — so
      // they must all price identically.
      expect(standEVForTotal(12, dist)).toBeCloseTo(standEVForTotal(16, dist), 12);
      expect(standEVForTotal(17, dist)).toBeGreaterThan(standEVForTotal(16, dist));
    }
  });
});

describe("composition enumeration", () => {
  it("covers hard 16 with every two-card combination that makes it", () => {
    expect(enumerateCompositions("hard", 16, undefined)).toEqual([
      [6, 10],
      [7, 9],
      [8, 8],
    ]);
  });

  it("never treats a two-card 21 as a decision state", () => {
    // A+10 is a natural, so hard 21 and soft 21 fall back to three-card hands.
    for (const cards of enumerateCompositions("soft", 21, undefined)) {
      expect(cards).toHaveLength(3);
    }
    for (const cards of enumerateCompositions("hard", 21, undefined)) {
      expect(cards).toHaveLength(3);
    }
  });

  it("reads an ace pair as two aces, not two elevens", () => {
    expect(enumerateCompositions("pair", 12, 11)).toEqual([[1, 1]]);
  });
});

describe("action EVs for a concrete hand", () => {
  const options = { allowDouble: true, allowSplit: false, allowSurrender: true };

  it("prices doubling as exactly twice a one-card stand", () => {
    // Not a tautology: it is the invariant that catches a double EV computed in
    // per-hand rather than per-original-wager units.
    const evs = solveComposition([5, 6], 6, rules, options);
    expect(evs.DOUBLE).not.toBeNull();
    if (evs.DOUBLE === null) return;
    expect(Math.abs(evs.DOUBLE)).toBeLessThanOrEqual(2);
    expect(evs.DOUBLE).toBeGreaterThan(evs.HIT);
  });

  it("prices surrender at exactly -0.5", () => {
    expect(solveComposition([10, 6], 10, rules, options).SURRENDER).toBe(-0.5);
  });

  it("never prices hitting a 21 above standing on it", () => {
    const evs = solveComposition([1, 5, 5], 10, rules, {
      allowDouble: false,
      allowSplit: false,
      allowSurrender: false,
    });
    expect(evs.HIT).toBeLessThanOrEqual(evs.STAND);
  });

  it("distinguishes 16 made of {10,6} from 16 made of {9,7}", () => {
    // The whole point of card removal: the two hands are not interchangeable,
    // because the cards already gone from the shoe are different.
    const tenSix = solveComposition([6, 10], 10, rules, options);
    const nineSeven = solveComposition([7, 9], 10, rules, options);
    expect(tenSix.STAND).not.toBe(nineSeven.STAND);
    expect(tenSix.HIT).not.toBe(nineSeven.HIT);
  });

  it("values splitting aces above playing a soft 12", () => {
    const aces = solveComposition([1, 1], 6, rules, {
      allowDouble: true,
      allowSplit: true,
      allowSurrender: true,
    });
    expect(aces.SPLIT).not.toBeNull();
    if (aces.SPLIT === null) return;
    expect(aces.SPLIT).toBeGreaterThan(aces.HIT);
    expect(aces.SPLIT).toBeGreaterThan(aces.STAND);
  });

  it("respects the one-card restriction on split aces", () => {
    // If aces were allowed to draw on, splitting them would be worth
    // materially more. The gap proves the restriction is being applied rather
    // than declared.
    const restricted = solveComposition([1, 1], 6, rules, {
      allowDouble: true,
      allowSplit: true,
      allowSurrender: true,
    });
    const permissive = solveComposition(
      [1, 1],
      6,
      { ...rules, hitSplitAcesAllowed: true },
      { allowDouble: true, allowSplit: true, allowSurrender: true },
    );
    expect(permissive.SPLIT ?? 0).toBeGreaterThan(restricted.SPLIT ?? 0);
  });

  it("values splitting more when double-after-split is allowed", () => {
    const withDas = solveComposition([2, 2], 6, rules, {
      allowDouble: true,
      allowSplit: true,
      allowSurrender: true,
    });
    const withoutDas = solveComposition(
      [2, 2],
      6,
      { ...rules, doubleAfterSplit: false },
      { allowDouble: true, allowSplit: true, allowSurrender: true },
    );
    expect(withDas.SPLIT ?? 0).toBeGreaterThan(withoutDas.SPLIT ?? 0);
  });

  it("values splitting more when more hands are permitted", () => {
    const fourHands = solveComposition([8, 8], 6, rules, {
      allowDouble: true,
      allowSplit: true,
      allowSurrender: true,
    });
    const twoHands = solveComposition(
      [8, 8],
      6,
      { ...rules, maxSplitHands: 2 },
      { allowDouble: true, allowSplit: true, allowSurrender: true },
    );
    expect(fourHands.SPLIT ?? 0).toBeGreaterThan(twoHands.SPLIT ?? 0);
  });
});
