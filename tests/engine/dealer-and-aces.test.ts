/**
 * The dealer's drawing rule as a table, and ace normalisation past the obvious.
 *
 * The dealer is the only participant with no decisions: what it does is fully
 * determined by its total and by S17/H17. That makes it testable exhaustively
 * rather than by example, and worth doing, because a single wrong comparison
 * here shifts the house edge on every hand the product will ever deal.
 */

import { describe, expect, it } from "vitest";

import {
  dealerMustDraw,
  evaluateHand,
  evaluatePlayerHand,
  visibleDealerValue,
} from "../../shared/blackjack/hand-value.js";
import type { PlayerHand } from "../../shared/blackjack/types.js";
import { betAndDeal, cards, findEvent, harness } from "../helpers/engine-harness.js";

/**
 * Plays one hand where the player holds K,K (20) and stands, so the only thing
 * that moves afterwards is the dealer.
 *
 * Deal order at one seat is player, dealer up, player, dealer hole, so the
 * fixture reads `KS <up> KD <hole> <draws…>`.
 */
function dealerPlaysOut(options: { up: string; hole: string; draws: string; hitsSoft17?: boolean }) {
  let h = betAndDeal(
    harness({
      rules: { dealerHitsSoft17: options.hitsSoft17 ?? false },
      shoe: `KS ${options.up} KD ${options.hole} ${options.draws}`,
      /*
       * Twos, so a case that draws one card further than it meant to fails
       * visibly on the total rather than landing on a plausible one. The pad
       * must clear the safety reserve or `openBetting` reshuffles the whole
       * fixture away before the first hand — the harness now refuses a shorter
       * one rather than silently dealing random cards.
       */
      pad: Array.from({ length: 80 }, () => "2C").join(" "),
    }),
    100,
  );

  if (h.state.phase === "INSURANCE_OFFER") {
    h = h.send({ type: "DECLINE_INSURANCE", seatId: "s1" });
  }
  if (h.state.phase === "PLAYER_TURNS") {
    h = h.send({ type: "STAND", seatId: "s1" });
  }

  const value = evaluateHand(h.state.dealer.cards);
  return {
    harness: h,
    cardCount: h.state.dealer.cards.length,
    total: value.bestTotal,
    isSoft: value.isSoft,
    isBust: value.isBust,
    stood: findEvent(h.events, "DEALER_STOOD"),
    busted: findEvent(h.events, "DEALER_BUSTED"),
  };
}

describe("the dealer draws by the table and by nothing else", () => {
  const S17_CASES = [
    { name: "stands on a two-card soft 17 (6 + A)", up: "6H", hole: "AD", draws: "9C", total: 17, drawn: 0 },
    { name: "stands on hard 17 (8 + 9)", up: "8H", hole: "9D", draws: "9C", total: 17, drawn: 0 },
    { name: "stands on soft 18 (7 + A)", up: "7H", hole: "AD", draws: "9C", total: 18, drawn: 0 },
    { name: "stands on 20 (9 + A)", up: "9H", hole: "AD", draws: "9C", total: 20, drawn: 0 },
    { name: "hits hard 16 and stands on 20", up: "9H", hole: "7D", draws: "4C", total: 20, drawn: 1 },
    { name: "hits hard 12 and stands on 17", up: "8H", hole: "4D", draws: "5C", total: 17, drawn: 1 },
    { name: "hits twice from 6 and stands on 18", up: "2H", hole: "4D", draws: "5C 7S", total: 18, drawn: 2 },
    { name: "counts an ace down rather than busting (5 + 6 + A + 5)", up: "5H", hole: "6D", draws: "AS 5C", total: 17, drawn: 2 },
  ];

  for (const scenario of S17_CASES) {
    it(scenario.name, () => {
      const result = dealerPlaysOut(scenario);
      expect(result.total).toBe(scenario.total);
      expect(result.cardCount).toBe(2 + scenario.drawn);
      expect(result.isBust).toBe(false);
      expect(result.stood?.total).toBe(scenario.total);
      expect(result.busted).toBeUndefined();
    });
  }

  it("busts past 21 and says so", () => {
    const result = dealerPlaysOut({ up: "10H", hole: "6D", draws: "10C" });
    expect(result.isBust).toBe(true);
    expect(result.total).toBe(26);
    expect(result.busted?.total).toBe(26);
    expect(result.stood).toBeUndefined();
  });

  it("holds two aces and a nine as twenty-one", () => {
    // A + A is soft 12; the nine makes 21, not 12 and not 31.
    const result = dealerPlaysOut({ up: "AH", hole: "AD", draws: "9C" });
    expect(result.total).toBe(21);
    expect(result.isSoft).toBe(true);
    expect(result.cardCount).toBe(3);
    // Three cards, so it is not a natural, and the player's 20 simply loses.
    expect(result.harness.hand().outcome?.kind).toBe("LOSS");
  });

  it("hits a soft 17 only when the ruleset says to", () => {
    const stands = dealerPlaysOut({ up: "6H", hole: "AD", draws: "2C" });
    expect(stands.total).toBe(17);
    expect(stands.cardCount).toBe(2);

    const hits = dealerPlaysOut({ up: "6H", hole: "AD", draws: "2C", hitsSoft17: true });
    expect(hits.total).toBe(19);
    expect(hits.cardCount).toBe(3);
  });

  it("stands on a HARD 17 even under H17", () => {
    // The rule is about soft seventeens alone. Getting this wrong would have
    // the dealer hitting every 17 on an H17 table.
    const result = dealerPlaysOut({ up: "10H", hole: "7D", draws: "4C", hitsSoft17: true });
    expect(result.total).toBe(17);
    expect(result.cardCount).toBe(2);
  });

  it("does not draw at all when the only live hand is a natural", () => {
    // Player holds A,K; the dealer's 12 is irrelevant and drawing would only
    // consume cards. The natural still pays 3:2.
    const h = betAndDeal(harness({ shoe: "AS 7H KD 5C 9D 9H" }), 100);
    expect(h.state.phase).toBe("HAND_COMPLETE");
    expect(h.state.dealer.cards).toHaveLength(2);
    expect(h.hand().outcome?.kind).toBe("BLACKJACK");
    expect(h.hand().outcome?.credit).toBe(250);
  });
});

describe("the peek, on both upcards that trigger it", () => {
  it("checks a TEN upcard and ends the hand on a dealer natural", () => {
    // No insurance offer — that is for an ace — but the peek still happens, and
    // it happens before the player may act.
    const h = betAndDeal(harness({ shoe: "9S KH 8D AC 5H" }), 100);
    expect(findEvent(h.events, "INSURANCE_OFFERED")).toBeUndefined();
    expect(findEvent(h.events, "DEALER_PEEKED")?.hasBlackjack).toBe(true);
    expect(h.state.phase).toBe("HAND_COMPLETE");
    expect(h.hand().cards).toHaveLength(2);
    expect(h.hand().outcome?.kind).toBe("LOSS");
  });

  it("checks a TEN upcard, finds nothing, and hands the turn to the player", () => {
    const h = betAndDeal(harness({ shoe: "9S KH 8D 7C 5H" }), 100);
    expect(findEvent(h.events, "DEALER_PEEKED")?.hasBlackjack).toBe(false);
    expect(h.state.phase).toBe("PLAYER_TURNS");
  });

  it("does not peek at all on a small upcard", () => {
    const h = betAndDeal(harness({ shoe: "9S 6H 8D 7C 5H" }), 100);
    expect(findEvent(h.events, "DEALER_PEEKED")).toBeUndefined();
    expect(h.state.phase).toBe("PLAYER_TURNS");
  });

  it("pushes a player natural against a dealer natural found at the peek", () => {
    const h = betAndDeal(harness({ shoe: "AS KH KD AC" }), 100);
    expect(h.state.phase).toBe("HAND_COMPLETE");
    expect(h.hand().outcome).toEqual({ kind: "PUSH", credit: 100, net: 0 });
  });
});

describe("what the player is allowed to see of the dealer", () => {
  it("values only the face-up cards before the reveal", () => {
    const upcardOnly = cards("6H");
    expect(visibleDealerValue(upcardOnly).bestTotal).toBe(6);
    // The same function on the full hand is a different number, which is the
    // point: nothing may hand it the hole card early.
    expect(evaluateHand(cards("6H AD")).bestTotal).toBe(17);
  });
});

describe("ace normalisation, beyond the two obvious cases", () => {
  const CASES: Array<{ spec: string; total: number; soft: boolean; bust?: boolean }> = [
    { spec: "AS 6D", total: 17, soft: true },
    { spec: "AS AD 9H", total: 21, soft: true },
    { spec: "AS AD 9H 10C", total: 21, soft: false },
    { spec: "AS AD", total: 12, soft: true },
    { spec: "AS AD AH", total: 13, soft: true },
    { spec: "AS AD AH AC", total: 14, soft: true },
    { spec: "AS AD AH AC 7S", total: 21, soft: true },
    { spec: "AS AD AH AC 8S", total: 12, soft: false },
    { spec: "AS 9D AH", total: 21, soft: true },
    { spec: "AS 9D AH 10C", total: 21, soft: false },
    { spec: "AS 9D AH 10C 10D", total: 31, soft: false, bust: true },
    { spec: "AS 2D 3H 4C 5S", total: 15, soft: false },
    { spec: "AS 2D 3H 4C", total: 20, soft: true },
    { spec: "10S 6D AH", total: 17, soft: false },
    { spec: "10S 6D AH 4C", total: 21, soft: false },
    { spec: "AS 10D", total: 21, soft: true },
    { spec: "KS QD JH", total: 30, soft: false, bust: true },
  ];

  for (const scenario of CASES) {
    it(`${scenario.spec} is ${scenario.soft ? "soft" : "hard"} ${scenario.total}`, () => {
      const value = evaluateHand(cards(scenario.spec));
      expect(value.bestTotal).toBe(scenario.total);
      expect(value.isSoft).toBe(scenario.soft);
      expect(value.isBust).toBe(scenario.bust === true);
      expect(value.isTwentyOne).toBe(scenario.total === 21);
      // Only an original two-card 21 is a natural.
      expect(value.isNaturalBlackjack).toBe(
        scenario.total === 21 && scenario.spec.trim().split(/\s+/).length === 2,
      );
    });
  }

  it("never counts two aces as eleven each, at any hand length", () => {
    for (let extras = 0; extras <= 8; extras++) {
      const spec = ["AS", "AD", ...Array.from({ length: extras }, () => "2C")].join(" ");
      const value = evaluateHand(cards(spec));
      // Hard total is 1 + 1 + 2n; at most one ace may be promoted by ten.
      expect(value.hardTotal).toBe(2 + extras * 2);
      expect(value.bestTotal).toBe(value.hardTotal + (value.isSoft ? 10 : 0));
      expect(value.bestTotal).toBeLessThanOrEqual(Math.max(21, value.hardTotal));
    }
  });

  it("carries split provenance into the natural test rather than re-deriving it", () => {
    const base: PlayerHand = {
      id: "h",
      cards: cards("AS KD"),
      wager: 100,
      status: "ACTIVE",
      cameFromSplit: false,
      cameFromSplitAces: false,
    };

    expect(evaluatePlayerHand(base, false).isNaturalBlackjack).toBe(true);
    expect(
      evaluatePlayerHand({ ...base, cameFromSplit: true }, false).isNaturalBlackjack,
    ).toBe(false);
    expect(
      evaluatePlayerHand(
        { ...base, cameFromSplit: true, cameFromSplitAces: true },
        false,
      ).isNaturalBlackjack,
    ).toBe(false);
    // ...unless the ruleset opts in, and only for split ACES.
    expect(
      evaluatePlayerHand(
        { ...base, cameFromSplit: true, cameFromSplitAces: true },
        true,
      ).isNaturalBlackjack,
    ).toBe(true);
    expect(
      evaluatePlayerHand({ ...base, cameFromSplit: true }, true).isNaturalBlackjack,
    ).toBe(false);
  });

  it("treats an empty hand as a hard zero rather than throwing", () => {
    // Reached by the public payload for a seat with no cards yet.
    const value = evaluateHand([]);
    expect(value).toEqual({
      hardTotal: 0,
      bestTotal: 0,
      isSoft: false,
      isBust: false,
      isTwentyOne: false,
      isNaturalBlackjack: false,
    });
  });
});

describe("the drawing rule exists exactly once", () => {
  /*
   * `dealerMustDraw` was extracted because the rule had been written down twice:
   * in the engine's `playDealer` and in `scripts/strategy-solver.ts`, which
   * needs the dealer's final-total distribution to solve basic strategy. Two
   * copies means the CHART can be computed for a dealer this engine does not
   * play — and the chart is what the product grades players against, so the
   * drift would show up as honest-looking advice that is quietly wrong.
   *
   * Both now call this function. What is left to prove is that the function is
   * what the engine really does, which is what the table below does by playing
   * hands and comparing the engine's behaviour to the predicate's answer.
   */
  const S17 = { dealerHitsSoft17: false };
  const H17 = { dealerHitsSoft17: true };

  it("draws below seventeen and stands at seventeen or better", () => {
    for (let total = 4; total <= 16; total++) {
      expect(dealerMustDraw({ bestTotal: total, isSoft: false }, S17), `hard ${total}`).toBe(true);
      expect(dealerMustDraw({ bestTotal: total, isSoft: false }, H17), `hard ${total}`).toBe(true);
    }
    for (let total = 17; total <= 21; total++) {
      expect(dealerMustDraw({ bestTotal: total, isSoft: false }, S17), `hard ${total}`).toBe(false);
      expect(dealerMustDraw({ bestTotal: total, isSoft: false }, H17), `hard ${total}`).toBe(false);
    }
  });

  it("separates soft seventeen from every other soft total", () => {
    for (let total = 12; total <= 21; total++) {
      const soft = { bestTotal: total, isSoft: true };
      expect(dealerMustDraw(soft, S17), `soft ${total} under S17`).toBe(total < 17);
      expect(dealerMustDraw(soft, H17), `soft ${total} under H17`).toBe(total <= 17);
    }
  });

  it("never draws to a hand that has already busted", () => {
    for (let total = 22; total <= 30; total++) {
      expect(dealerMustDraw({ bestTotal: total, isSoft: false }, S17)).toBe(false);
      expect(dealerMustDraw({ bestTotal: total, isSoft: false }, H17)).toBe(false);
    }
  });

  it("is what the engine actually does, hand by hand", () => {
    // Each fixture puts the dealer on a known two-card total and stops the
    // player at 20, so whether a card is drawn is the predicate's answer alone.
    const cases = [
      { up: "6H", hole: "AD", hitsSoft17: false }, // soft 17: stands
      { up: "6H", hole: "AD", hitsSoft17: true }, // soft 17: draws
      { up: "10H", hole: "7D", hitsSoft17: true }, // hard 17: stands even under H17
      { up: "9H", hole: "7D", hitsSoft17: false }, // hard 16: draws
      { up: "9H", hole: "AD", hitsSoft17: true }, // soft 20: stands
      { up: "2H", hole: "3D", hitsSoft17: false }, // hard 5: draws
    ];

    for (const scenario of cases) {
      const initial = evaluateHand(cards(`${scenario.up} ${scenario.hole}`));
      const predicted = dealerMustDraw(initial, { dealerHitsSoft17: scenario.hitsSoft17 });
      const played = dealerPlaysOut({ ...scenario, draws: "3C" });
      const drewACard = played.cardCount > 2;
      expect(drewACard, `${scenario.up}+${scenario.hole} H17=${scenario.hitsSoft17}`).toBe(predicted);
    }
  });
});
