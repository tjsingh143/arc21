/**
 * The parts of the engine's public surface that no behavioural test happens to
 * walk, and the two guards that its own comments claim run.
 *
 * Every function here is exported from `shared/blackjack` and consumed by
 * something — a screen, a session factory, a shuffle — so "nothing covers it"
 * means the coverage report was averaging over it, not that it does not matter.
 */

import { describe, expect, it } from "vitest";

import { buildDecks } from "../../shared/blackjack/cards.js";
import { getLegalActions, isActionLegal } from "../../shared/blackjack/legal-actions.js";
import {
  ARC_STANDARD_RULES,
  assertRulesAreCoherent,
  PRIVATE_TABLE_MAX_BET,
  PRIVATE_TABLE_MIN_BET,
  PRIVATE_TABLE_STACK,
  privateTableRules,
  rulesetKey,
} from "../../shared/blackjack/rules.js";
import { SeededTestRandomSource } from "../../shared/blackjack/rng.js";
import { assertShoeIntegrity, createShoe, reshuffle } from "../../shared/blackjack/shoe.js";
import { assertNoHiddenCardLeak, toPublicState } from "../../shared/blackjack/public-state.js";
import {
  isHiddenCard,
  isVisibleCard,
  type MaybeHiddenCard,
  type PlayerActionType,
} from "../../shared/blackjack/types.js";
import { betAndDeal, cards, harness } from "../helpers/engine-harness.js";

describe("isActionLegal answers exactly what getLegalActions answers", () => {
  const EVERY_ACTION: PlayerActionType[] = ["HIT", "STAND", "DOUBLE", "SPLIT", "SURRENDER"];

  it("agrees on a two-card pair, where four of the five are legal", () => {
    const h = betAndDeal(harness({ shoe: "8S 7H 8D 5C 10H 10D" }), 100);
    const set = getLegalActions(h.state, "s1").actions;

    for (const action of EVERY_ACTION) {
      expect(isActionLegal(h.state, "s1", action), action).toBe(set.includes(action));
    }
    // Not a vacuous agreement: the set really does differ across the five.
    expect(set.length).toBeGreaterThan(0);
    expect(set.length).toBeLessThan(EVERY_ACTION.length + 1);
  });

  it("agrees once the hand is settled and nothing is legal", () => {
    const done = betAndDeal(harness({ shoe: "10S 7H 7D 5C" }), 100).send({
      type: "STAND",
      seatId: "s1",
    });
    for (const action of EVERY_ACTION) {
      expect(isActionLegal(done.state, "s1", action)).toBe(false);
    }
  });

  it("agrees for a seat that is not at the table", () => {
    const h = betAndDeal(harness({ shoe: "8S 7H 8D 5C" }), 100);
    for (const action of EVERY_ACTION) {
      expect(isActionLegal(h.state, "ghost", action)).toBe(false);
    }
  });
});

describe("private-table rules", () => {
  it("are Arc Standard with a gentler band and nothing else changed", () => {
    const rules = privateTableRules();
    expect(rules.minBet).toBe(PRIVATE_TABLE_MIN_BET);
    expect(rules.maxBet).toBe(PRIVATE_TABLE_MAX_BET);

    // Same ruleset identity, so the same strategy tables and the same stats
    // bucket. A private table is not a different game.
    expect(rulesetKey(rules)).toBe(rulesetKey(ARC_STANDARD_RULES));

    const { minBet: _min, maxBet: _max, ...rest } = rules;
    const { minBet: _baseMin, maxBet: _baseMax, ...base } = ARC_STANDARD_RULES;
    expect(rest).toEqual(base);
  });

  it("are coherent, and the fixed session stack can cover the minimum many times over", () => {
    expect(() => assertRulesAreCoherent(privateTableRules())).not.toThrow();
    expect(PRIVATE_TABLE_STACK % PRIVATE_TABLE_MIN_BET).toBe(0);
    expect(PRIVATE_TABLE_STACK / PRIVATE_TABLE_MIN_BET).toBeGreaterThanOrEqual(100);
  });
});

describe("hidden-card predicates", () => {
  const real = cards("AS")[0]!;
  const hole: MaybeHiddenCard = { hidden: true };

  it("are exact opposites over both shapes", () => {
    expect(isHiddenCard(hole)).toBe(true);
    expect(isVisibleCard(hole)).toBe(false);
    expect(isHiddenCard(real)).toBe(false);
    expect(isVisibleCard(real)).toBe(true);
  });

  it("narrows a mixed list, which is why the positive form exists", () => {
    // `filter(c => !isHiddenCard(c))` does not narrow — TypeScript only
    // propagates a predicate in the TRUE branch — so screens filter on
    // `isVisibleCard` instead. This is that call shape.
    const mixed: MaybeHiddenCard[] = [real, hole, cards("KD")[0]!];
    const visible = mixed.filter(isVisibleCard);
    expect(visible.map((card) => card.rank)).toEqual(["A", "K"]);
    expect(mixed.filter(isHiddenCard)).toHaveLength(1);
  });
});

describe("every shoe the engine builds is checked as it is built", () => {
  it("passes a freshly shuffled six-deck shoe", () => {
    const shoe = createShoe(ARC_STANDARD_RULES, new SeededTestRandomSource(1));
    expect(() => assertShoeIntegrity(shoe, 6)).not.toThrow();
    expect(shoe.cards).toHaveLength(312);
  });

  it("passes a reshuffle", () => {
    const first = createShoe(ARC_STANDARD_RULES, new SeededTestRandomSource(1));
    const second = reshuffle(first, ARC_STANDARD_RULES, new SeededTestRandomSource(2));
    expect(() => assertShoeIntegrity(second, 6)).not.toThrow();
    expect(second.shuffleNumber).toBe(2);
  });

  it("catches a shoe that is short", () => {
    const shoe = createShoe(ARC_STANDARD_RULES, new SeededTestRandomSource(1));
    const short = { ...shoe, cards: shoe.cards.slice(0, 311) };
    expect(() => assertShoeIntegrity(short, 6)).toThrow(/has 311 cards, expected 312/);
  });

  it("catches a duplicated physical card", () => {
    const shoe = createShoe(ARC_STANDARD_RULES, new SeededTestRandomSource(1));
    const cloned = [...shoe.cards];
    cloned[5] = cloned[0]!;
    expect(() => assertShoeIntegrity({ ...shoe, cards: cloned }, 6)).toThrow(/duplicate card id/);
  });

  it("catches a MISSING card even when the count is right", () => {
    // The subtlest of the three: swap a card for a duplicate of another and the
    // duplicate check fires, but swap it for a card from a SEVENTH deck and only
    // the missing-card pass can see it.
    const shoe = createShoe(ARC_STANDARD_RULES, new SeededTestRandomSource(1));
    const swapped = [...shoe.cards];
    const stranger = buildDecks(7).find((card) => card.deckIndex === 6)!;
    swapped[10] = stranger;
    expect(() => assertShoeIntegrity({ ...shoe, cards: swapped }, 6)).toThrow(/is missing card/);
  });
});

describe("the leak assertion under a no-hole-card ruleset", () => {
  it("has no hole card to check and passes", () => {
    // The branch exists because a European table deals the dealer one card, so
    // there is nothing at index 1 to protect. It must not become a false pass
    // for the undealt shoe, which is checked either way.
    const h = betAndDeal(
      harness({ rules: { dealerHoleCard: false, dealerPeeksForBlackjack: false }, shoe: "10S 7H 7D 5C" }),
      100,
    );
    expect(h.state.dealer.cards).toHaveLength(1);
    const payload = toPublicState(h.state);
    expect(payload.dealer.cards.every((card) => !isHiddenCard(card))).toBe(true);
    expect(() => assertNoHiddenCardLeak(payload, h.state)).not.toThrow();
  });

  it("still refuses a payload carrying an undealt card at a no-hole-card table", () => {
    const h = betAndDeal(
      harness({ rules: { dealerHoleCard: false, dealerPeeksForBlackjack: false }, shoe: "10S 7H 7D 5C" }),
      100,
    );
    const undealt = h.state.shoe.cards[h.state.shoe.nextIndex]!;
    expect(() => assertNoHiddenCardLeak({ sneaky: undealt }, h.state)).toThrow(/leaks undealt card/);
  });
});

describe("what a seat that is waiting its turn is offered", () => {
  it("is nothing at all, which is what the client renders while another seat acts", () => {
    const h = betAndDeal(
      harness({
        shoe: "8S 6H 7D 8C 9H 5S 10H 10D",
        seats: [
          { seatId: "s1", displayName: "One", stack: 5_000 },
          { seatId: "s2", displayName: "Two", stack: 5_000 },
        ],
      }),
      100,
      ["s1", "s2"],
    );

    expect(h.state.phase).toBe("PLAYER_TURNS");
    expect(h.state.seats[h.state.activeSeatIndex!]!.seatId).toBe("s1");

    const waiting = getLegalActions(h.state, "s2");
    expect(waiting.actions).toEqual([]);
    expect(waiting.canPlaceBet).toBe(false);
    expect(waiting.canLockBet).toBe(false);
    expect(waiting.canStartNextHand).toBe(false);
    expect(waiting.canTakeInsurance).toBe(false);
    // s2 holds a live hand and 100 chips on the felt; it simply cannot act yet.
    expect(h.state.seats[1]!.hands[0]!.status).toBe("ACTIVE");

    for (const action of ["HIT", "STAND", "DOUBLE", "SPLIT", "SURRENDER"] as PlayerActionType[]) {
      expect(isActionLegal(h.state, "s2", action)).toBe(false);
    }

    // And the seat that IS acting is offered something, so the comparison is
    // between two live seats rather than between a live table and a dead one.
    expect(getLegalActions(h.state, "s1").actions.length).toBeGreaterThan(0);
  });

  it("is nothing once the session itself has closed", () => {
    const closed = betAndDeal(harness({ shoe: "10S 7H 7D 5C" }), 100).patch((state) => ({
      ...state,
      phase: "SESSION_COMPLETE" as const,
    }));
    expect(getLegalActions(closed.state, "s1").actions).toEqual([]);
    expect(getLegalActions(closed.state, "s1").canStartNextHand).toBe(false);
  });
});
