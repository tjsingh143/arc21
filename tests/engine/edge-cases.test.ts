/**
 * Failure paths and invariants. These are the behaviours a product is tempted
 * to skip because they are tedious — which is exactly why they are tested.
 */

import { describe, expect, it } from "vitest";

import {
  applyCommand,
  beginNextHand,
  createGame,
  startSession,
} from "../../shared/blackjack/reducer.js";
import { SeededTestRandomSource } from "../../shared/blackjack/rng.js";
import { createPreorderedShoe } from "../../shared/blackjack/shoe.js";
import { EngineError } from "../../shared/blackjack/types.js";
import { betAndDeal, cards, findEvent, harness, TEST_CONTEXT } from "../helpers/engine-harness.js";

describe("shoe exhaustion invariant", () => {
  it("aborts the hand instead of fabricating a card", () => {
    // Three cards cannot complete a four-card deal.
    const h = harness({ shoe: "5S 6D 7H 8C" }).patch((state) => ({
      ...state,
      shoe: createPreorderedShoe(cards("5S 6D 7H")),
    }));

    const staged = h.send({ type: "PLACE_BET", seatId: "s1", amount: 100 });
    expect(() => staged.send({ type: "LOCK_BET", seatId: "s1" })).toThrow(EngineError);

    try {
      staged.send({ type: "LOCK_BET", seatId: "s1" });
    } catch (error) {
      expect((error as EngineError).code).toBe("SHOE_EXHAUSTED");
    }
  });

  it("leaves the pre-command state untouched when it aborts", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" }).patch((state) => ({
      ...state,
      shoe: createPreorderedShoe(cards("5S 6D 7H")),
    }));
    const staged = h.send({ type: "PLACE_BET", seatId: "s1", amount: 100 });
    const before = JSON.stringify(staged.state);

    expect(() => staged.send({ type: "LOCK_BET", seatId: "s1" })).toThrow();
    expect(JSON.stringify(staged.state)).toBe(before);
    // The wager is still staged, not silently consumed.
    expect(staged.seat().originalBet).toBe(100);
  });
});

describe("reshuffling between hands", () => {
  it("reshuffles once the cut card is passed and emits the event", () => {
    const played = betAndDeal(harness({ shoe: "AS 7D KH 9C" }), 100);

    // Force the shoe past its cut card, as a long session would.
    const exhausted = played.patch((state) => ({
      ...state,
      shoe: { ...state.shoe, nextIndex: state.shoe.cutIndex },
    }));

    const next = exhausted.nextHand();
    const event = findEvent(next.events, "SHOE_SHUFFLED");
    expect(event).toBeDefined();
    expect(event?.deckCount).toBe(6);
    expect(next.state.shoe.shuffleNumber).toBe(2);
    expect(next.state.shoe.nextIndex).toBe(0);
    // A real 6-deck shoe replaces the short test fixture.
    expect(next.state.shoe.cards).toHaveLength(312);
  });

  it("refuses to reshuffle without a random source rather than reusing order", () => {
    const played = betAndDeal(harness({ shoe: "AS 7D KH 9C" }), 100);
    const exhausted = played.patch((state) => ({
      ...state,
      shoe: { ...state.shoe, nextIndex: state.shoe.cutIndex },
    }));

    expect(() => beginNextHand(exhausted.state, {})).toThrow(/no RandomSource/);
  });

  it("does not reshuffle mid-hand", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 4H 9C 2D 3H 4S" }), 100);
    const shuffleBefore = h.state.shoe.shuffleNumber;
    const after = h.send({ type: "HIT", seatId: "s1" }).send({ type: "HIT", seatId: "s1" });
    expect(after.state.shoe.shuffleNumber).toBe(shuffleBefore);
  });
});

describe("leaving a table", () => {
  it("refunds an uncommitted bet and sits the seat out", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" })
      .send({ type: "PLACE_BET", seatId: "s1", amount: 100 })
      .send({ type: "LEAVE", seatId: "s1" });

    expect(h.seat().stack).toBe(10_000);
    expect(h.seat().originalBet).toBe(0);
    expect(h.seat().sittingOut).toBe(true);
    expect(h.seat().connected).toBe(false);
  });

  it("does not let a player escape a committed wager mid-hand", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C" }), 100).send({
      type: "LEAVE",
      seatId: "s1",
    });
    // The hand is still live and the wager is still at risk.
    expect(h.seat().hands[0]!.wager).toBe(100);
    expect(h.seat().stack).toBe(9_900);
    expect(findEvent(h.events, "SEAT_LEFT")).toBeDefined();
  });

  it("rejects a leave from an unknown seat", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" });
    expect(() => h.send({ type: "LEAVE", seatId: "ghost" })).toThrow(/No seat/);
  });
});

describe("session lifecycle", () => {
  it("refuses to start twice", () => {
    const state = createGame({
      gameId: "g",
      seats: [{ seatId: "s1", displayName: "T", stack: 1_000 }],
      random: new SeededTestRandomSource(1),
    });
    const started = startSession(state, TEST_CONTEXT);
    expect(() => startSession(started.state, TEST_CONTEXT)).toThrow(/Cannot start a session/);
  });

  it("refuses to begin the next hand before the current one completes", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C" }), 100);
    expect(h.state.phase).toBe("PLAYER_TURNS");
    expect(() => beginNextHand(h.state, TEST_CONTEXT)).toThrow(/Cannot begin a new hand/);
  });

  it("rejects an unknown command type", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" });
    expect(() =>
      applyCommand(h.state, { type: "NONSENSE" } as never, TEST_CONTEXT),
    ).toThrow(/Unknown command/);
  });

  it("treats ADVANCE as a no-op while waiting on a player", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C" }), 100);
    const after = h.send({ type: "ADVANCE" });
    expect(after.state.phase).toBe("PLAYER_TURNS");
  });

  it("keeps a seat sitting out until it can afford the minimum again", () => {
    // Stack of 60 covers one 50-chip bet; losing it drops the seat below the
    // minimum, so it sits out rather than being dealt an unfundable hand.
    const h = betAndDeal(
      harness({
        shoe: "10S 10D 7H 9C",
        seats: [{ seatId: "s1", displayName: "T", stack: 60 }],
      }),
      50,
    ).send({ type: "STAND", seatId: "s1" });

    expect(h.seat().stack).toBe(10);
    const next = h.nextHand();
    expect(next.seat().stack).toBeLessThan(50);
    expect(next.state.phase).toBe("BETTING_OPEN");
    // No bet is possible, so the round cannot start.
    expect(() => next.send({ type: "PLACE_BET", seatId: "s1", amount: 50 })).toThrow(EngineError);
  });
});

describe("bet handling across rounds", () => {
  it("clears bets and hands when a new round opens", () => {
    const first = betAndDeal(harness({ shoe: "10S 10D 7H 9C" }), 100).send({
      type: "STAND",
      seatId: "s1",
    });
    const next = first.nextHand();

    expect(next.seat().originalBet).toBe(0);
    expect(next.seat().insuranceBet).toBe(0);
    expect(next.seat().insuranceDecision).toBe("NOT_OFFERED");
    expect(next.seat().betLocked).toBe(false);
    expect(next.seat().hands).toHaveLength(0);
    expect(next.state.dealer.cards).toHaveLength(0);
    expect(next.state.dealer.holeCardRevealed).toBe(false);
  });

  it("clears a staged bet with an amount of zero and refunds it", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" })
      .send({ type: "PLACE_BET", seatId: "s1", amount: 300 })
      .send({ type: "PLACE_BET", seatId: "s1", amount: 0 });

    expect(h.seat().originalBet).toBe(0);
    expect(h.seat().stack).toBe(10_000);
    expect(h.state.phase).toBe("BETTING_OPEN");
  });

  it("does not start a round when every seat has cleared its bet", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" })
      .send({ type: "PLACE_BET", seatId: "s1", amount: 300 })
      .send({ type: "PLACE_BET", seatId: "s1", amount: 0 });
    // Locking with nothing staged is still rejected.
    expect(() => h.send({ type: "LOCK_BET", seatId: "s1" })).toThrow(EngineError);
  });

  it("refunds the staged bet when it is replaced", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" })
      .send({ type: "PLACE_BET", seatId: "s1", amount: 1_000 })
      .send({ type: "PLACE_BET", seatId: "s1", amount: 50 });
    expect(h.seat().stack).toBe(9_950);
  });

  it("rejects placing a bet after locking", () => {
    const h = harness({
      shoe: "5S 6D 7H 8C",
      seats: [
        { seatId: "s1", displayName: "One", stack: 10_000 },
        { seatId: "s2", displayName: "Two", stack: 10_000 },
      ],
    })
      .send({ type: "PLACE_BET", seatId: "s1", amount: 100 })
      .send({ type: "PLACE_BET", seatId: "s2", amount: 100 })
      .send({ type: "LOCK_BET", seatId: "s1" });

    // s1 is locked; the round has not started because s2 has not locked.
    expect(h.state.phase).toBe("BETTING_OPEN");
    expect(() => h.send({ type: "PLACE_BET", seatId: "s1", amount: 200 })).toThrow(
      /already locked/,
    );
  });
});
