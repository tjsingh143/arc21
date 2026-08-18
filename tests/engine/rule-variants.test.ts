/**
 * Alternative rule configurations. The engine must be genuinely rule-driven —
 * if any of these fail, a rule assumption has been hardcoded somewhere.
 */

import { describe, expect, it } from "vitest";

import { getLegalActions } from "../../shared/blackjack/legal-actions.js";
import { toPublicState } from "../../shared/blackjack/public-state.js";
import { applyCommand, createGame, startSession } from "../../shared/blackjack/reducer.js";
import { SeededTestRandomSource } from "../../shared/blackjack/rng.js";
import { createPreorderedShoe } from "../../shared/blackjack/shoe.js";
import { EngineError, isHiddenCard } from "../../shared/blackjack/types.js";
import { betAndDeal, cards, findEvent, harness, TEST_CONTEXT } from "../helpers/engine-harness.js";

describe("split ace variants", () => {
  it("allows hitting split aces when the ruleset permits", () => {
    const h = betAndDeal(
      harness({ shoe: "AS 6D AH 9C 3D 4H", rules: { hitSplitAcesAllowed: true } }),
      100,
    ).send({ type: "SPLIT", seatId: "s1" });

    expect(h.hand("s1", 0).status).toBe("ACTIVE");
    expect(getLegalActions(h.state, "s1").actions).toContain("HIT");
  });

  it("allows resplitting aces when the ruleset permits", () => {
    const h = betAndDeal(
      harness({
        shoe: "AS 6D AH 9C AD 4H 5S 7C",
        rules: { hitSplitAcesAllowed: true, resplitAcesAllowed: true },
      }),
      100,
    ).send({ type: "SPLIT", seatId: "s1" });

    // First split hand is now A + A again.
    expect(h.hand("s1", 0).cards.map((c) => c.rank)).toEqual(["A", "A"]);
    expect(getLegalActions(h.state, "s1").actions).toContain("SPLIT");
  });

  it("pays split-ace 21 as a natural when the ruleset says so", () => {
    const h = betAndDeal(
      harness({ shoe: "AS 6D AH 9C 10D KH", rules: { splitAceTwentyOneIsBlackjack: true } }),
      100,
    ).send({ type: "SPLIT", seatId: "s1" });

    expect(h.hand("s1", 0).status).toBe("BLACKJACK");
    expect(h.hand("s1", 0).outcome?.kind).toBe("BLACKJACK");
    expect(h.hand("s1", 0).outcome?.credit).toBe(250);
  });

  it("forbids splitting aces entirely when disallowed", () => {
    const h = betAndDeal(
      harness({ shoe: "AS 6D AH 9C 3D 4H", rules: { splitAcesAllowed: false } }),
      100,
    );
    expect(getLegalActions(h.state, "s1").actions).not.toContain("SPLIT");
  });
});

describe("insurance variants", () => {
  it("skips the offer entirely when insurance is disabled", () => {
    const h = betAndDeal(
      harness({ shoe: "10S AD 6H 5C", rules: { insuranceAllowed: false } }),
      100,
    );
    // Straight to the peek, then player turns.
    expect(h.state.phase).toBe("PLAYER_TURNS");
    expect(h.seat().insuranceDecision).toBe("NOT_OFFERED");
  });

  it("refuses insurance a seat cannot afford", () => {
    const h = betAndDeal(
      harness({
        shoe: "10S AD 6H 5C",
        seats: [{ seatId: "s1", displayName: "T", stack: 130 }],
      }),
      100,
    );
    // 30 chips left, insurance costs 50.
    expect(h.state.phase).toBe("INSURANCE_OFFER");
    expect(getLegalActions(h.state, "s1").canTakeInsurance).toBe(false);
    expect(getLegalActions(h.state, "s1").canDeclineInsurance).toBe(true);
    expect(() => h.send({ type: "INSURANCE", seatId: "s1" })).toThrow(/cannot take insurance/);
  });
});

describe("no-hole-card (European style) variant", () => {
  const EUROPEAN = { dealerHoleCard: false, dealerPeeksForBlackjack: false };

  it("deals the dealer a single card and plays it out at the end", () => {
    const h = betAndDeal(harness({ shoe: "10S 6D 7H 5C 4D", rules: EUROPEAN }), 100);
    expect(h.state.dealer.cards).toHaveLength(1);
    expect(h.state.phase).toBe("PLAYER_TURNS");

    const after = h.send({ type: "STAND", seatId: "s1" });
    // Dealer 6 draws to at least 17.
    expect(after.state.dealer.cards.length).toBeGreaterThan(1);
    expect(findEvent(after.events, "HOLE_CARD_REVEALED")).toBeUndefined();
  });

  it("shows no hidden placeholder in public state", () => {
    const h = betAndDeal(harness({ shoe: "10S 6D 7H 5C 4D", rules: EUROPEAN }), 100);
    const payload = toPublicState(h.state);
    expect(payload.dealer.cards.every((card) => !isHiddenCard(card))).toBe(true);
    expect(payload.dealer.displayedTotal).toBe(6);
  });
});

describe("locking without a bet", () => {
  it("refuses to lock a seat that staged nothing", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" });
    expect(() => h.send({ type: "LOCK_BET", seatId: "s1" })).toThrow(EngineError);
  });
});

describe("deadlines", () => {
  const NOW = "2026-01-01T00:00:00.000Z";

  function timedGame() {
    const state = createGame({
      gameId: "timed",
      seats: [{ seatId: "s1", displayName: "T", stack: 5_000 }],
      random: new SeededTestRandomSource(3),
      timing: { betMillis: 15_000, actionMillis: 15_000 },
    });
    const seeded = {
      ...state,
      shoe: createPreorderedShoe(cards("10S 10D 6H 9C 2D 3H 4S 5C 6D 7H")),
    };
    return startSession(seeded, { ...TEST_CONTEXT, now: NOW }).state;
  }

  it("sets an absolute betting deadline from server time", () => {
    const state = timedGame();
    expect(state.actionDeadlineAt).toBe("2026-01-01T00:00:15.000Z");
  });

  it("sets an action deadline when the turn begins", () => {
    let state = timedGame();
    state = applyCommand(state, { type: "PLACE_BET", seatId: "s1", amount: 100 }, {
      ...TEST_CONTEXT,
      now: NOW,
    }).state;
    state = applyCommand(state, { type: "LOCK_BET", seatId: "s1" }, {
      ...TEST_CONTEXT,
      now: "2026-01-01T00:00:05.000Z",
    }).state;

    expect(state.phase).toBe("PLAYER_TURNS");
    expect(state.actionDeadlineAt).toBe("2026-01-01T00:00:20.000Z");
  });

  it("leaves deadlines null for local practice with no timing", () => {
    const h = harness({ shoe: "10S 10D 6H 9C" });
    expect(h.state.actionDeadlineAt).toBeNull();
  });
});

describe("public state with idle seats", () => {
  it("reports an empty seat without hands or totals", () => {
    const h = harness({
      shoe: "5S 6D 7H 8C",
      seats: [
        { seatId: "s1", displayName: "One", stack: 10_000 },
        { seatId: "s2", displayName: "Two", stack: 10_000 },
      ],
    });
    const payload = toPublicState(h.state);

    expect(payload.seats).toHaveLength(2);
    expect(payload.seats[1]!.hands).toEqual([]);
    expect(payload.activeSeatId).toBeNull();
    expect(payload.activeHandId).toBeNull();
    expect(payload.dealer.displayedTotal).toBeNull();
  });

  it("names the active seat and hand during player turns", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C" }), 100);
    const payload = toPublicState(h.state);
    expect(payload.activeSeatId).toBe("s1");
    expect(payload.activeHandId).toBe(h.hand().id);
  });
});
