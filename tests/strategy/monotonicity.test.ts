/**
 * Shape sanity for the computed chart.
 *
 * These assertions do not check that the chart is *right* — cross-validation.test.ts
 * does that. They check that it is *coherent*: a solver bug that inverted a
 * comparison or read the wrong dealer distribution would produce cells that are
 * individually plausible but collectively nonsense, like hitting an 18 against
 * a 4 after standing on a 15. A chart that fails these is wrong no matter what
 * any reference says.
 */

import { describe, expect, it } from "vitest";

import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";
import type { PlayerActionType } from "../../shared/blackjack/types.js";
import { ARC_STANDARD_STRATEGY_TABLE } from "../../supabase/functions/_shared/strategy/generated-arc-standard-v1.js";
import { DEALER_UPCARD_VALUES } from "../../supabase/functions/_shared/strategy/keys.js";
import { lookupStrategy } from "../../supabase/functions/_shared/strategy/lookup.js";
import type { HandClass, StrategyAction } from "../../supabase/functions/_shared/strategy/types.js";

const table = ARC_STANDARD_STRATEGY_TABLE;

/**
 * Resolve with only hit and stand available.
 *
 * Doubling and surrendering are separate questions; asking "hit or stand?" is
 * what makes the monotonicity claim meaningful, and it is also exactly what the
 * player faces on a three-card hand.
 */
const HIT_STAND: readonly PlayerActionType[] = ["HIT", "STAND"];

function hitOrStand(handClass: HandClass, playerTotal: number, dealerUpcardValue: number): StrategyAction {
  const recommendation = lookupStrategy({
    table,
    rules: ARC_STANDARD_RULES,
    state: { handClass, playerTotal, dealerUpcardValue },
    legalActions: HIT_STAND,
  });
  if (recommendation === null) {
    throw new Error(`No advice for ${handClass} ${playerTotal} vs ${dealerUpcardValue}`);
  }
  return recommendation.action;
}

describe("hard totals are monotone in the player's total", () => {
  it("never flips back to hit once standing becomes correct", () => {
    for (const upcard of DEALER_UPCARD_VALUES) {
      let standingTotal: number | null = null;

      for (let total = 5; total <= 21; total++) {
        const action = hitOrStand("hard", total, upcard);

        if (action === "STAND" && standingTotal === null) {
          standingTotal = total;
        }

        if (standingTotal !== null) {
          expect(
            action,
            `hard ${total} vs ${upcard} hits, but hard ${standingTotal} vs ${upcard} already stood`,
          ).toBe("STAND");
        }
      }

      // Every upcard must have a standing threshold somewhere at or below 17,
      // otherwise the row is telling players to hit a 20.
      expect(standingTotal, `no standing threshold against ${upcard}`).not.toBeNull();
      expect(standingTotal ?? 99).toBeLessThanOrEqual(17);
    }
  });

  it("always stands on 17 and above", () => {
    for (const upcard of DEALER_UPCARD_VALUES) {
      for (let total = 17; total <= 21; total++) {
        expect(hitOrStand("hard", total, upcard)).toBe("STAND");
      }
    }
  });

  it("always hits at 11 and below, where standing cannot win and cannot bust", () => {
    for (const upcard of DEALER_UPCARD_VALUES) {
      for (let total = 5; total <= 11; total++) {
        expect(hitOrStand("hard", total, upcard)).toBe("HIT");
      }
    }
  });

  it("stands earlier against a weak upcard than against a strong one", () => {
    const threshold = (upcard: number): number => {
      for (let total = 5; total <= 21; total++) {
        if (hitOrStand("hard", total, upcard) === "STAND") return total;
      }
      return 22;
    };

    // A dealer showing 6 must bust out of a stiff hand; a dealer showing 10
    // usually does not. The stiff-standing threshold has to reflect that.
    expect(threshold(6)).toBeLessThan(threshold(10));
    expect(threshold(4)).toBeLessThanOrEqual(threshold(7));
  });
});

describe("soft totals are monotone in the player's total", () => {
  it("never flips back to hit once standing becomes correct", () => {
    for (const upcard of DEALER_UPCARD_VALUES) {
      let standingTotal: number | null = null;

      for (let total = 13; total <= 21; total++) {
        const action = hitOrStand("soft", total, upcard);
        if (action === "STAND" && standingTotal === null) standingTotal = total;
        if (standingTotal !== null) {
          expect(
            action,
            `soft ${total} vs ${upcard} hits, but soft ${standingTotal} vs ${upcard} already stood`,
          ).toBe("STAND");
        }
      }

      expect(standingTotal, `no soft standing threshold against ${upcard}`).not.toBeNull();
    }
  });

  it("always stands on soft 19 and above", () => {
    for (const upcard of DEALER_UPCARD_VALUES) {
      for (let total = 19; total <= 21; total++) {
        expect(hitOrStand("soft", total, upcard)).toBe("STAND");
      }
    }
  });

  it("hits a soft total at least as long as the matching hard total", () => {
    // A soft hand cannot bust on the next card, so standing can never become
    // correct *earlier* than it does on the hard total of the same value.
    for (const upcard of DEALER_UPCARD_VALUES) {
      for (let total = 13; total <= 18; total++) {
        if (hitOrStand("hard", total, upcard) === "HIT") {
          expect(
            hitOrStand("soft", total, upcard),
            `soft ${total} vs ${upcard} stands while hard ${total} vs ${upcard} hits`,
          ).toBe("HIT");
        }
      }
    }
  });
});

describe("EVs are monotone where the game forces them to be", () => {
  it("prices every stiff total alike, because they all win on the same event", () => {
    // Standing on 4 through 16 wins if and only if the dealer busts, so the
    // total itself buys nothing. Cells still differ slightly because each row
    // averages over different card combinations and each combination strips
    // different cards from the shoe — hard 16 vs 6 is mostly {6,10}, and taking
    // a second six out of the shoe measurably lowers how often a dealer showing
    // six busts. The band is sized for that effect (worst observed: 0.0096
    // against a six) and nothing larger.
    //
    // This replaces a naive "stand EV rises with the total" assertion, which is
    // simply false across the stiff range. The strict form of that claim holds
    // against a *fixed* dealer distribution and is asserted in solver.test.ts.
    const REMOVAL_BAND = 0.015;

    for (const upcard of DEALER_UPCARD_VALUES) {
      const stiff: number[] = [];
      for (let total = 4; total <= 16; total++) {
        const stand = table.entries[`hard:${total}:${upcard}`]?.evs?.STAND;
        expect(stand, `missing stand EV for hard ${total} vs ${upcard}`).toBeDefined();
        if (stand !== undefined) stiff.push(stand);
      }

      const low = Math.min(...stiff);
      const high = Math.max(...stiff);
      expect(high - low, `stiff stand EVs vs ${upcard} span ${(high - low).toFixed(5)}`).toBeLessThan(
        REMOVAL_BAND,
      );

      // Reaching 17 stops depending on the dealer busting, and that is worth
      // far more than any removal effect.
      const seventeen = table.entries[`hard:17:${upcard}`]?.evs?.STAND ?? -Infinity;
      expect(seventeen, `hard 17 vs ${upcard}`).toBeGreaterThan(high + 0.05);
    }
  });

  it("makes standing strictly better at every total from 16 up", () => {
    // Above the stiff range the totals really do beat different dealer hands, so
    // the increase has to be unambiguous rather than within noise.
    for (const upcard of DEALER_UPCARD_VALUES) {
      for (let total = 17; total <= 21; total++) {
        const lower = table.entries[`hard:${total - 1}:${upcard}`]?.evs?.STAND;
        const higher = table.entries[`hard:${total}:${upcard}`]?.evs?.STAND;
        expect(lower).toBeDefined();
        expect(higher).toBeDefined();
        if (lower === undefined || higher === undefined) continue;
        expect(higher, `hard ${total} vs ${upcard} stands worse than hard ${total - 1}`).toBeGreaterThan(
          lower,
        );
      }
    }
  });

  it("makes a strong upcard worse for the player than a weak one", () => {
    for (let total = 12; total <= 20; total++) {
      const versusSix = table.entries[`hard:${total}:6`]?.evs?.STAND;
      const versusTen = table.entries[`hard:${total}:10`]?.evs?.STAND;
      expect(versusSix).toBeDefined();
      expect(versusTen).toBeDefined();
      if (versusSix === undefined || versusTen === undefined) continue;
      expect(versusSix).toBeGreaterThan(versusTen);
    }
  });

  it("never prices splitting a pair of tens above standing on twenty", () => {
    for (const upcard of DEALER_UPCARD_VALUES) {
      const entry = table.entries[`pair:10:${upcard}`];
      expect(entry?.recommendedAction).toBe("STAND");
    }
  });

  it("always splits aces and eights, and never splits fives or tens", () => {
    // Not a transcription of the chart: these are the two structural facts the
    // solver must rediscover, and a split model that mishandled the one-card
    // ace restriction or the four-hand cap would break one of them.
    for (const upcard of DEALER_UPCARD_VALUES) {
      expect(table.entries[`pair:11:${upcard}`]?.recommendedAction).toBe("SPLIT");
      expect(table.entries[`pair:8:${upcard}`]?.recommendedAction).toBe("SPLIT");
      expect(table.entries[`pair:5:${upcard}`]?.recommendedAction).not.toBe("SPLIT");
      expect(table.entries[`pair:10:${upcard}`]?.recommendedAction).not.toBe("SPLIT");
    }
  });
});
