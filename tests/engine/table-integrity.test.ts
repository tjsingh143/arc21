/**
 * Table-level integrity: the chips, the shoe and the seats, over whole rounds.
 *
 * The suites next to this one check rules one at a time. This one plays rounds
 * and checks the properties that must hold no matter what was played — every
 * chip quantity an integer, no stack ever negative, the settlement credit
 * reconciling exactly with what was committed, no card ever dealt twice, and no
 * reshuffle inside a hand.
 *
 * It also holds the regressions for three defects found in this engine during
 * phase 1, each of which is written up where it is asserted.
 */

import { describe, expect, it } from "vitest";

import { buildDecks, RANKS, SUITS } from "../../shared/blackjack/cards.js";
import { getLegalActions } from "../../shared/blackjack/legal-actions.js";
import {
  applyCommand,
  beginNextHand,
  createGame,
  startSession,
  type EngineState,
} from "../../shared/blackjack/reducer.js";
import { SeededTestRandomSource } from "../../shared/blackjack/rng.js";
import { ARC_STANDARD_RULES, assertRulesAreCoherent } from "../../shared/blackjack/rules.js";
import {
  assertShoeIntegrity,
  computeCutIndex,
  needsReshuffle,
  SAFETY_RESERVE_CARDS,
} from "../../shared/blackjack/shoe.js";
import type { EngineCommand, SeatState } from "../../shared/blackjack/types.js";
import { betAndDeal, findEvent, harness, TEST_CONTEXT } from "../helpers/engine-harness.js";

// ---------------------------------------------------------------------------
// The shoe a six-deck game is actually dealt from
// ---------------------------------------------------------------------------

describe("deck composition", () => {
  it("is exactly six physical copies of each of the fifty-two rank/suit pairs", () => {
    const deck = buildDecks(6);
    expect(deck).toHaveLength(312);

    const counts = new Map<string, number>();
    for (const card of deck) {
      const key = `${card.rank}${card.suit}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    expect(counts.size).toBe(52);
    for (const [key, count] of counts) {
      expect(count, `${key} appears ${count} times`).toBe(6);
    }
  });

  it("contains thirteen ranks and four suits, and nothing else — no jokers", () => {
    const deck = buildDecks(6);
    expect([...new Set(deck.map((card) => card.rank))].sort()).toEqual([...RANKS].sort());
    expect([...new Set(deck.map((card) => card.suit))].sort()).toEqual([...SUITS].sort());
    expect(RANKS).toHaveLength(13);
    expect(SUITS).toHaveLength(4);
    // 13 x 4 x 6 leaves no room for a fifty-third card even if one were added.
    expect(RANKS.length * SUITS.length * 6).toBe(deck.length);
  });

  it("gives every physical card a unique id and the right deck index", () => {
    const deck = buildDecks(6);
    expect(new Set(deck.map((card) => card.id)).size).toBe(deck.length);

    for (let deckIndex = 0; deckIndex < 6; deckIndex++) {
      const slice = deck.filter((card) => card.deckIndex === deckIndex);
      expect(slice).toHaveLength(52);
      expect(new Set(slice.map((card) => `${card.rank}${card.suit}`)).size).toBe(52);
    }
  });

  it("counts ten-value cards and aces as a real deck does", () => {
    const deck = buildDecks(6);
    const tens = deck.filter((card) => ["10", "J", "Q", "K"].includes(card.rank));
    expect(tens).toHaveLength(96); // 4 ranks x 4 suits x 6 decks
    expect(deck.filter((card) => card.rank === "A")).toHaveLength(24);
  });
});

// ---------------------------------------------------------------------------
// Chip accounting over whole rounds
// ---------------------------------------------------------------------------

/** Everything the seat has committed to the felt this round. */
function committed(seat: SeatState): number {
  return seat.hands.reduce((sum, hand) => sum + hand.wager, 0) + seat.insuranceBet;
}

function assertChipsAreWholeAndSane(state: EngineState): void {
  for (const seat of state.seats) {
    expect(Number.isInteger(seat.stack), `stack ${seat.stack} is not an integer`).toBe(true);
    expect(seat.stack).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(seat.originalBet)).toBe(true);
    expect(Number.isInteger(seat.insuranceBet)).toBe(true);
    expect(seat.insuranceBet).toBeGreaterThanOrEqual(0);

    for (const hand of seat.hands) {
      expect(Number.isInteger(hand.wager), `wager ${hand.wager} is not an integer`).toBe(true);
      expect(hand.wager).toBeGreaterThan(0);
      if (hand.outcome) {
        expect(Number.isInteger(hand.outcome.credit)).toBe(true);
        expect(Number.isInteger(hand.outcome.net)).toBe(true);
        expect(hand.outcome.credit).toBeGreaterThanOrEqual(0);
        expect(hand.outcome.net).toBe(hand.outcome.credit - hand.wager);
      }
    }
  }
}

describe("chip accounting reconciles for every round played", () => {
  it("credits exactly what the outcomes say, over a varied scripted session", () => {
    const seats = [
      { seatId: "s1", displayName: "One", stack: 20_000 },
      { seatId: "s2", displayName: "Two", stack: 20_000 },
    ];

    let state = startSession(
      createGame({ gameId: "chips", seats, random: new SeededTestRandomSource(90210) }),
      TEST_CONTEXT,
    ).state;

    for (let round = 0; round < 40; round++) {
      const stackBefore = new Map(state.seats.map((seat) => [seat.seatId, seat.stack]));

      for (const seat of seats) {
        state = applyCommand(state, { type: "PLACE_BET", seatId: seat.seatId, amount: 100 }, TEST_CONTEXT).state;
      }
      for (const seat of seats) {
        state = applyCommand(state, { type: "LOCK_BET", seatId: seat.seatId }, TEST_CONTEXT).state;
      }
      assertChipsAreWholeAndSane(state);

      // Vary the play so doubles, splits, surrenders and insurance all occur.
      for (let guard = 0; guard < 200 && state.phase !== "HAND_COMPLETE"; guard++) {
        if (state.phase === "INSURANCE_OFFER") {
          const pending = state.seats.find((seat) => seat.insuranceDecision === "PENDING")!;
          const takes = round % 2 === 0;
          state = applyCommand(
            state,
            takes
              ? { type: "INSURANCE", seatId: pending.seatId }
              : { type: "DECLINE_INSURANCE", seatId: pending.seatId },
            TEST_CONTEXT,
          ).state;
          assertChipsAreWholeAndSane(state);
          continue;
        }

        const seat = state.seats[state.activeSeatIndex!]!;
        const legal = getLegalActions(state, seat.seatId);
        const hand = seat.hands[seat.currentHandIndex]!;
        const total = hand.cards.reduce(
          (sum, card) => sum + (card.rank === "A" ? 11 : Number.isNaN(Number(card.rank)) ? 10 : Number(card.rank)),
          0,
        );

        let action: EngineCommand;
        if (legal.actions.includes("SPLIT")) action = { type: "SPLIT", seatId: seat.seatId };
        else if (legal.actions.includes("SURRENDER") && round % 7 === 0) {
          action = { type: "SURRENDER", seatId: seat.seatId };
        } else if (legal.actions.includes("DOUBLE") && round % 3 === 0) {
          action = { type: "DOUBLE", seatId: seat.seatId };
        } else if (legal.actions.includes("HIT") && total <= 15) {
          action = { type: "HIT", seatId: seat.seatId };
        } else action = { type: "STAND", seatId: seat.seatId };

        state = applyCommand(state, action, TEST_CONTEXT).state;
        assertChipsAreWholeAndSane(state);
      }

      // Settled. Every seat's stack must equal what it started with, less what
      // it committed, plus what the outcomes credited — with no other term.
      for (const seat of state.seats) {
        if (seat.hands.length === 0) continue;
        const credit =
          seat.hands.reduce((sum, hand) => sum + (hand.outcome?.credit ?? 0), 0) +
          (seat.insuranceBet > 0 && seat.hands.some((hand) => hand.outcome)
            ? insuranceCreditFor(state, seat)
            : 0);
        expect(seat.stack, `seat ${seat.seatId} after round ${round}`).toBe(
          stackBefore.get(seat.seatId)! - committed(seat) + credit,
        );
      }

      state = beginNextHand(state, TEST_CONTEXT).state;
    }
  });

  /** Reads the insurance credit back out of the settlement events' arithmetic. */
  function insuranceCreditFor(state: EngineState, seat: SeatState): number {
    // A dealer natural is the only thing insurance pays on, and by settlement
    // the hole card is face up, so this is derivable rather than remembered.
    const dealerHasNatural =
      state.dealer.cards.length === 2 &&
      state.dealer.cards.some((card) => card.rank === "A") &&
      state.dealer.cards.some((card) => ["10", "J", "Q", "K"].includes(card.rank));
    return dealerHasNatural ? seat.insuranceBet * 3 : 0;
  }

  it("never lets a seat commit more than it holds", () => {
    const h = betAndDeal(harness({ shoe: "8S 7H 8D 5C 10H 10D" }), 100).patch((state) => ({
      ...state,
      seats: state.seats.map((seat) => ({ ...seat, stack: 50 })),
    }));

    // A split needs a second 100 and the seat holds 50.
    expect(getLegalActions(h.state, "s1").actions).not.toContain("SPLIT");
    expect(getLegalActions(h.state, "s1").actions).not.toContain("DOUBLE");
  });
});

// ---------------------------------------------------------------------------
// Shoe behaviour over a long session
// ---------------------------------------------------------------------------

describe("the shoe over a long, card-hungry session", () => {
  it("never deals a card twice, never reshuffles mid-hand, and stays a true six decks", () => {
    /*
     * Deliberately the most card-hungry legal play there is: split whenever
     * the engine allows it, then hit every hand until it reaches 21 or busts.
     * A shoe defect shows up far sooner under this than under sensible play.
     */
    const seats = [1, 2, 3].map((index) => ({
      seatId: `s${index}`,
      displayName: `S${index}`,
      stack: 1_000_000,
    }));

    let state = startSession(
      createGame({ gameId: "soak", seats, random: new SeededTestRandomSource(31337) }),
      TEST_CONTEXT,
    ).state;

    let reshuffles = 0;
    let maxRoundConsumption = 0;
    let minCardsAtRoundStart = Number.POSITIVE_INFINITY;
    const dealtThisShoe = new Set<string>();

    for (let round = 0; round < 60; round++) {
      const generationBefore = state.shoe.shuffleNumber;
      const cardsAtStart = state.shoe.cards.length - state.shoe.nextIndex;
      const indexAtStart = state.shoe.nextIndex;
      minCardsAtRoundStart = Math.min(minCardsAtRoundStart, cardsAtStart);

      for (const seat of seats) {
        state = applyCommand(state, { type: "PLACE_BET", seatId: seat.seatId, amount: 50 }, TEST_CONTEXT).state;
      }
      for (const seat of seats) {
        state = applyCommand(state, { type: "LOCK_BET", seatId: seat.seatId }, TEST_CONTEXT).state;
      }

      for (let guard = 0; guard < 400 && state.phase !== "HAND_COMPLETE"; guard++) {
        if (state.phase === "INSURANCE_OFFER") {
          const pending = state.seats.find((seat) => seat.insuranceDecision === "PENDING")!;
          state = applyCommand(state, { type: "DECLINE_INSURANCE", seatId: pending.seatId }, TEST_CONTEXT).state;
          continue;
        }
        const seat = state.seats[state.activeSeatIndex!]!;
        const legal = getLegalActions(state, seat.seatId);
        const action: EngineCommand = legal.actions.includes("SPLIT")
          ? { type: "SPLIT", seatId: seat.seatId }
          : legal.actions.includes("HIT")
            ? { type: "HIT", seatId: seat.seatId }
            : { type: "STAND", seatId: seat.seatId };
        state = applyCommand(state, action, TEST_CONTEXT).state;
      }

      // The whole round was dealt from ONE shuffle. A mid-hand reshuffle would
      // change the composition a player is counting on.
      expect(state.shoe.shuffleNumber).toBe(generationBefore);
      maxRoundConsumption = Math.max(maxRoundConsumption, state.shoe.nextIndex - indexAtStart);

      // Every card handed out this shoe generation is distinct.
      for (let i = indexAtStart; i < state.shoe.nextIndex; i++) {
        const id = state.shoe.cards[i]!.id;
        expect(dealtThisShoe.has(id), `card ${id} dealt twice from one shoe`).toBe(false);
        dealtThisShoe.add(id);
      }

      const next = beginNextHand(state, TEST_CONTEXT);
      if (findEvent(next.events, "SHOE_SHUFFLED")) {
        reshuffles++;
        dealtThisShoe.clear();
        assertShoeIntegrity(next.state.shoe, 6);
      }
      state = next.state;
    }

    // The session was long enough to cross the cut card more than once, so the
    // reshuffle boundary was genuinely exercised rather than assumed.
    expect(reshuffles).toBeGreaterThanOrEqual(2);

    /*
     * The cut card, not the safety reserve, is what actually bounds a round —
     * and the margin it leaves is real rather than hoped for. At 6 decks and
     * 75% penetration a round can never begin with fewer than 312 - 234 = 78
     * cards left, and the most card-hungry play measured here consumed far
     * fewer. The reserve sits below that as a backstop that never fires, which
     * is exactly the relationship `assertPenetrationIsCoherent` enforces.
     */
    const guaranteed = 312 - computeCutIndex(312, ARC_STANDARD_RULES.targetPenetration);
    expect(guaranteed).toBe(78);
    expect(minCardsAtRoundStart).toBeGreaterThanOrEqual(guaranteed);
    expect(maxRoundConsumption).toBeLessThan(guaranteed);
    expect(maxRoundConsumption).toBeGreaterThan(10); // the soak really did play
  });

  it("begins no round below the guaranteed remainder, for any legal ruleset", () => {
    // `needsReshuffle` has two triggers and the stricter one has to win. This
    // states that as arithmetic instead of trusting the ordering of an `||`.
    for (const penetration of [0.5, 0.6, 0.75, 0.8]) {
      const total = 312;
      const cut = computeCutIndex(total, penetration);
      for (let nextIndex = 0; nextIndex <= total; nextIndex++) {
        const remaining = total - nextIndex;
        const shoe = { cards: [], nextIndex, shuffleNumber: 1, cutIndex: cut } as unknown as Parameters<
          typeof needsReshuffle
        >[0];
        // `cardsRemaining` reads from the array, so give it one of the right size.
        const sized = { ...shoe, cards: new Array(total).fill(null) };
        const mustReshuffle = needsReshuffle(sized as never);
        if (!mustReshuffle) {
          expect(remaining).toBeGreaterThanOrEqual(SAFETY_RESERVE_CARDS);
          expect(nextIndex).toBeLessThan(cut);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 1 regressions
// ---------------------------------------------------------------------------

describe("a seat that has left is never staked again", () => {
  /*
   * FOUND IN PHASE 1. A player who left MID-HAND kept a live seat: the server
   * only runs its closure path at a phase where no wager is committed, so the
   * engine seat came round to BETTING_OPEN still eligible — and the betting
   * deadline then staked the table minimum out of their stack, hand after hand,
   * in absentia, until it fell below the minimum. `connected` is only ever
   * cleared by LEAVE, a closure or a tournament elimination and is never set
   * back, so a disconnected seat is a departed one; `openBetting` now sits it
   * out at the boundary.
   */
  const timing = { betMillis: 10_000, actionMillis: 10_000, settlementMillis: 10_000 };

  function twoSeatTimedTable(): EngineState {
    const state = createGame({
      gameId: "left",
      seats: [
        { seatId: "s1", displayName: "Stays", stack: 5_000 },
        { seatId: "s2", displayName: "Leaves", stack: 5_000 },
      ],
      random: new SeededTestRandomSource(4),
      timing,
      now: "2026-08-24T12:00:00.000Z",
    });
    return startSession(state, { ...TEST_CONTEXT, now: "2026-08-24T12:00:00.000Z" }).state;
  }

  it("does not stake a seat that left mid-hand when the next betting round times out", () => {
    const now = "2026-08-24T12:00:00.000Z";
    const context = { ...TEST_CONTEXT, now };
    let state = twoSeatTimedTable();

    for (const seatId of ["s1", "s2"]) {
      state = applyCommand(state, { type: "PLACE_BET", seatId, amount: 100 }, context).state;
    }
    for (const seatId of ["s1", "s2"]) {
      state = applyCommand(state, { type: "LOCK_BET", seatId }, context).state;
    }
    expect(state.phase).toBe("PLAYER_TURNS");

    // s2 walks out with a wager committed: that hand still resolves.
    state = applyCommand(state, { type: "LEAVE", seatId: "s2" }, context).state;
    const leaverStackMidHand = state.seats[1]!.stack;
    expect(state.seats[1]!.hands[0]!.wager).toBe(100);

    // Play the round out.
    for (let guard = 0; guard < 20 && state.phase !== "HAND_COMPLETE"; guard++) {
      const seat = state.seats[state.activeSeatIndex!]!;
      state = applyCommand(state, { type: "STAND", seatId: seat.seatId }, context).state;
    }
    const leaverStackAfterSettlement = state.seats[1]!.stack;

    // Next round opens. The departed seat must be sitting out...
    state = beginNextHand(state, context).state;
    expect(state.phase).toBe("BETTING_OPEN");
    expect(state.seats[1]!.sittingOut).toBe(true);

    // ...and the betting timeout must not stake it.
    const later = "2026-08-24T12:59:00.000Z";
    state = applyCommand(state, { type: "RESOLVE_TIMEOUT", now: later }, { ...TEST_CONTEXT, now: later }).state;

    expect(state.seats[1]!.stack).toBe(leaverStackAfterSettlement);
    expect(state.seats[1]!.originalBet).toBe(0);
    expect(state.seats[1]!.betLocked).toBe(false);
    expect(state.seats[1]!.hands).toHaveLength(0);
    // Sanity: the seat did lose or win the hand it was in, so the assertion
    // above is comparing against a real settled figure, not the pre-leave one.
    expect(leaverStackMidHand).toBeLessThan(5_000);

    // The player who stayed is dealt in as normal.
    expect(state.seats[0]!.betLocked).toBe(true);
    expect(state.phase).toBe("PLAYER_TURNS");
  });

  it("still refuses to let a departing seat escape a committed wager", () => {
    const now = "2026-08-24T12:00:00.000Z";
    const context = { ...TEST_CONTEXT, now };
    let state = twoSeatTimedTable();
    for (const seatId of ["s1", "s2"]) {
      state = applyCommand(state, { type: "PLACE_BET", seatId, amount: 100 }, context).state;
    }
    for (const seatId of ["s1", "s2"]) {
      state = applyCommand(state, { type: "LOCK_BET", seatId }, context).state;
    }

    const before = state.seats[1]!.stack;
    state = applyCommand(state, { type: "LEAVE", seatId: "s2" }, context).state;
    // Not refunded, and the hand is still on the felt.
    expect(state.seats[1]!.stack).toBe(before);
    expect(state.seats[1]!.hands[0]!.status).toBe("ACTIVE");
  });

  it("brings a seat that sat out for want of chips back once it can afford the minimum", () => {
    // The connected case must be untouched by the change above.
    const h = harness({ shoe: "10S 7H 7D 5C" }).patch((state) => ({
      ...state,
      seats: state.seats.map((seat) => ({ ...seat, sittingOut: true, stack: 500 })),
    }));
    const settled = h.patch((state) => ({ ...state, phase: "HAND_COMPLETE" as const }));
    const next = settled.nextHand();
    expect(next.seat().sittingOut).toBe(false);
  });
});

describe("an insurance offer a departing seat never answered", () => {
  /*
   * FOUND IN PHASE 1. The cascade holds at INSURANCE_OFFER while any decision
   * is PENDING. A seat that left there kept the whole table waiting on somebody
   * who had gone, and on a table with no insurance clock nothing else would
   * ever move it. LEAVE now answers the offer the way the clock would.
   */
  it("is declined on the way out, and the round carries on", () => {
    const h = betAndDeal(
      harness({
        shoe: "10S 9H AD 7C 6S 5H",
        seats: [
          { seatId: "s1", displayName: "One", stack: 5_000 },
          { seatId: "s2", displayName: "Two", stack: 5_000 },
        ],
      }),
      100,
      ["s1", "s2"],
    );

    expect(h.state.phase).toBe("INSURANCE_OFFER");

    const left = h.send({ type: "LEAVE", seatId: "s2" });
    expect(left.seat("s2").insuranceDecision).toBe("DECLINED");
    expect(left.seat("s2").insuranceBet).toBe(0);
    expect(findEvent(left.events, "INSURANCE_DECLINED")).toBeDefined();

    // The remaining seat answers and the table moves on rather than hanging.
    const answered = left.send({ type: "DECLINE_INSURANCE", seatId: "s1" });
    expect(answered.state.phase).not.toBe("INSURANCE_OFFER");
  });

  it("leaves an insurance bet that was already taken exactly where it is", () => {
    const h = betAndDeal(harness({ shoe: "10S AH 7D 6C" }), 100)
      .send({ type: "INSURANCE", seatId: "s1" });
    expect(h.seat().insuranceBet).toBe(50);

    const left = h.patch((state) => ({ ...state, phase: "INSURANCE_OFFER" as const })).send({
      type: "LEAVE",
      seatId: "s1",
    });
    expect(left.seat().insuranceDecision).toBe("TAKEN");
    expect(left.seat().insuranceBet).toBe(50);
  });
});

describe("insurance never conjures a peek the ruleset has switched off", () => {
  /*
   * FOUND IN PHASE 1. `performInitialDeal` routes a non-peeking ruleset straight
   * to PLAYER_TURNS on a ten upcard, but an ACE upcard went to INSURANCE_OFFER
   * first — and the cascade then set DEALER_PEEK unconditionally. So switching
   * insurance ON quietly switched peeking on with it, for the one upcard where
   * the difference decides whether split and doubled wagers survive a dealer
   * blackjack.
   */
  const noPeek = { dealerPeeksForBlackjack: false };

  it("goes to PLAYER_TURNS after the offer, with no DEALER_PEEKED event", () => {
    // Dealer shows an ace over a ten: a natural, which a peeking table would
    // have found before anybody acted.
    const h = betAndDeal(harness({ rules: noPeek, shoe: "9S AH 8D KC" }), 100);
    expect(h.state.phase).toBe("INSURANCE_OFFER");

    const answered = h.send({ type: "DECLINE_INSURANCE", seatId: "s1" });
    expect(answered.state.phase).toBe("PLAYER_TURNS");
    expect(findEvent(answered.events, "DEALER_PEEKED")).toBeUndefined();

    // The player may still act, and the dealer's natural is only found at the
    // reveal — which is what "no peek" means.
    const stood = answered.send({ type: "STAND", seatId: "s1" });
    expect(stood.state.phase).toBe("HAND_COMPLETE");
    expect(stood.hand().outcome?.kind).toBe("LOSS");
  });

  it("still peeks when the ruleset says to", () => {
    const h = betAndDeal(harness({ shoe: "9S AH 8D KC" }), 100).send({
      type: "DECLINE_INSURANCE",
      seatId: "s1",
    });
    expect(findEvent(h.events, "DEALER_PEEKED")?.hasBlackjack).toBe(true);
    // Peek ends the hand before the player can act.
    expect(h.state.phase).toBe("HAND_COMPLETE");
  });

  it("agrees with a ten upcard, which never went through the offer at all", () => {
    const h = betAndDeal(harness({ rules: noPeek, shoe: "9S KH 8D AC" }), 100);
    expect(h.state.phase).toBe("PLAYER_TURNS");
    expect(findEvent(h.events, "DEALER_PEEKED")).toBeUndefined();
  });
});

describe("rulesets the engine cannot honestly play are refused at construction", () => {
  /*
   * FOUND IN PHASE 1. `doubleOnAnyTwoCards: false` reads as "double on 9-11
   * only", which is what a future ruleset author would mean. `getLegalActions`
   * has no allowlist to consult, so the flag did not restrict doubling — it
   * removed it, silently, on a table whose Fair Play copy would have said
   * otherwise.
   */
  it("refuses a restricted-double ruleset the engine has no model for", () => {
    expect(() =>
      assertRulesAreCoherent({ ...ARC_STANDARD_RULES, doubleOnAnyTwoCards: false }),
    ).toThrow(/does not restrict doubling/);
  });

  it("accepts doubleOnAnyTwoCards: false when doubling is switched off outright", () => {
    expect(() =>
      assertRulesAreCoherent({
        ...ARC_STANDARD_RULES,
        doubleAllowed: false,
        doubleOnAnyTwoCards: false,
      }),
    ).not.toThrow();
  });

  it("refuses doubling a split ace that may not be hit", () => {
    // The engine completes such a hand the moment its one card arrives, so the
    // decision would never be offered and the rule would be a fiction.
    expect(() =>
      assertRulesAreCoherent({ ...ARC_STANDARD_RULES, doubleSplitAcesAllowed: true }),
    ).toThrow(/requires hitSplitAcesAllowed/);
  });

  it("accepts the pair together", () => {
    expect(() =>
      assertRulesAreCoherent({
        ...ARC_STANDARD_RULES,
        doubleSplitAcesAllowed: true,
        hitSplitAcesAllowed: true,
      }),
    ).not.toThrow();
  });

  it("still accepts the shipped ruleset", () => {
    expect(() => assertRulesAreCoherent(ARC_STANDARD_RULES)).not.toThrow();
  });
});
