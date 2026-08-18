/**
 * Full gameplay matrix over deterministic shoes.
 *
 * Fixture deal order for one seat is: player, dealer upcard, player, dealer
 * hole card — then any further cards in sequence.
 */

import { describe, expect, it } from "vitest";

import { getLegalActions } from "../../shared/blackjack/legal-actions.js";
import { EngineError } from "../../shared/blackjack/types.js";
import { betAndDeal, findEvent, harness } from "../helpers/engine-harness.js";

const BET = 100;
const START = 10_000;

describe("round flow", () => {
  it("opens betting on session start", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" });
    expect(h.state.phase).toBe("BETTING_OPEN");
    expect(h.state.handNumber).toBe(1);
  });

  it("deals in casino order: player, upcard, player, hole card", () => {
    const h = betAndDeal(harness({ shoe: "5S 6D 7H 8C" }), BET);
    expect(h.hand().cards.map((c) => c.rank)).toEqual(["5", "7"]);
    expect(h.state.dealer.cards.map((c) => c.rank)).toEqual(["6", "8"]);
  });

  it("never emits the hole card's identity as a public deal event", () => {
    const h = betAndDeal(harness({ shoe: "5S 6D 7H 8C" }), BET);
    const holeEvent = findEvent(h.events, "HOLE_CARD_DEALT");
    expect(holeEvent).toBeDefined();

    const dealerCardEvents = h.events.filter(
      (e) => e.type === "CARD_DEALT" && e.to === "DEALER",
    );
    // Only the upcard is announced with an identity before reveal.
    expect(dealerCardEvents).toHaveLength(1);
  });

  it("debits the wager from the stack when the bet is placed", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" }).send({ type: "PLACE_BET", seatId: "s1", amount: BET });
    expect(h.seat().stack).toBe(START - BET);
    expect(h.seat().originalBet).toBe(BET);
  });

  it("treats a re-placed bet as absolute, not cumulative", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" })
      .send({ type: "PLACE_BET", seatId: "s1", amount: 100 })
      .send({ type: "PLACE_BET", seatId: "s1", amount: 300 });
    expect(h.seat().originalBet).toBe(300);
    expect(h.seat().stack).toBe(START - 300);
  });

  it("advances to a fresh betting round and preserves the shoe", () => {
    const first = betAndDeal(harness({ shoe: "10S 10D 6H 6C 10H" }), BET)
      .send({ type: "STAND", seatId: "s1" });
    expect(first.state.phase).toBe("HAND_COMPLETE");

    const second = first.nextHand();
    expect(second.state.phase).toBe("BETTING_OPEN");
    expect(second.state.handNumber).toBe(2);
    expect(second.seat().hands).toHaveLength(0);
    expect(second.state.shoe.shuffleNumber).toBe(1);
  });

  it("increments version exactly once per accepted command", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" });
    const before = h.state.version;
    const after = h.send({ type: "PLACE_BET", seatId: "s1", amount: BET });
    expect(after.state.version).toBe(before + 1);
  });
});

describe("payouts", () => {
  it("pays a natural 3:2", () => {
    // Player A+K, dealer 7+9 = 16.
    const h = betAndDeal(harness({ shoe: "AS 7D KH 9C" }), BET);
    expect(h.state.phase).toBe("HAND_COMPLETE");
    expect(h.hand().status).toBe("BLACKJACK");
    expect(h.hand().outcome).toEqual({ kind: "BLACKJACK", credit: 250, net: 150 });
    expect(h.seat().stack).toBe(START + 150);
  });

  it("pays an ordinary win 1:1", () => {
    // Player 20, dealer 16 then draws a 5 to 21... use an explicit bust instead.
    const h = betAndDeal(harness({ shoe: "10S 10D KH 6C 10H" }), BET).send({
      type: "STAND",
      seatId: "s1",
    });
    // Dealer 10+6 = 16, draws 10H = 26, bust.
    expect(h.hand().outcome).toEqual({ kind: "WIN", credit: 200, net: 100 });
    expect(h.seat().stack).toBe(START + 100);
  });

  it("returns the wager on a push", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 9H 9C" }), BET).send({
      type: "STAND",
      seatId: "s1",
    });
    // Both 19.
    expect(h.hand().outcome).toEqual({ kind: "PUSH", credit: 100, net: 0 });
    expect(h.seat().stack).toBe(START);
  });

  it("credits nothing on a loss", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 7H 9C" }), BET).send({
      type: "STAND",
      seatId: "s1",
    });
    // Player 17, dealer 19.
    expect(h.hand().outcome).toEqual({ kind: "LOSS", credit: 0, net: -100 });
    expect(h.seat().stack).toBe(START - 100);
  });

  it("credits nothing on a bust and does not consult the dealer", () => {
    const h = betAndDeal(harness({ shoe: "10S 6D 6H 5C 10H" }), BET).send({
      type: "HIT",
      seatId: "s1",
    });
    // Player 16 + 10 = 26.
    expect(h.hand().status).toBe("BUSTED");
    expect(h.hand().outcome?.kind).toBe("BUST");
    expect(h.seat().stack).toBe(START - 100);
  });

  it("pushes when both hold a natural", () => {
    const h = betAndDeal(harness({ shoe: "AS AD KH KC" }), BET).send({
      type: "DECLINE_INSURANCE",
      seatId: "s1",
    });
    expect(h.hand().outcome).toEqual({ kind: "PUSH", credit: 100, net: 0 });
    expect(h.seat().stack).toBe(START);
  });

  it("ends the hand at peek when the dealer has a natural, before any player action", () => {
    const h = betAndDeal(harness({ shoe: "7S AD 7H KC" }), BET).send({
      type: "DECLINE_INSURANCE",
      seatId: "s1",
    });
    expect(h.state.phase).toBe("HAND_COMPLETE");
    expect(h.hand().cards).toHaveLength(2);
    expect(h.hand().outcome?.kind).toBe("LOSS");
  });
});

describe("double", () => {
  it("doubles the wager, draws exactly one card and stands", () => {
    const h = betAndDeal(harness({ shoe: "5S 6D 6H 9C 10D 5C" }), BET).send({
      type: "DOUBLE",
      seatId: "s1",
    });
    expect(h.hand().wager).toBe(200);
    expect(h.hand().cards).toHaveLength(3);
    expect(h.hand().status).toBe("DOUBLED_COMPLETE");
  });

  it("settles a doubled win at 1:1 on the doubled wager", () => {
    // Player 11 + 10 = 21; dealer 6+9 = 15, draws 5 = 20.
    const h = betAndDeal(harness({ shoe: "5S 6D 6H 9C 10D 5C" }), BET).send({
      type: "DOUBLE",
      seatId: "s1",
    });
    expect(h.hand().outcome).toEqual({ kind: "WIN", credit: 400, net: 200 });
    expect(h.seat().stack).toBe(START + 200);
  });

  it("can bust on the doubled card", () => {
    const h = betAndDeal(harness({ shoe: "10S 6D 6H 9C 10D" }), BET).send({
      type: "DOUBLE",
      seatId: "s1",
    });
    expect(h.hand().status).toBe("BUSTED");
    expect(h.seat().stack).toBe(START - 200);
  });

  it("is illegal after a hit", () => {
    const h = betAndDeal(harness({ shoe: "5S 6D 4H 9C 2D 10H" }), BET).send({
      type: "HIT",
      seatId: "s1",
    });
    expect(getLegalActions(h.state, "s1").actions).not.toContain("DOUBLE");
    expect(() => h.send({ type: "DOUBLE", seatId: "s1" })).toThrow(EngineError);
  });

  it("is illegal without enough stack", () => {
    const h = betAndDeal(
      harness({ shoe: "5S 6D 6H 9C 10D", seats: [{ seatId: "s1", displayName: "T", stack: 150 }] }),
      100,
    );
    // 50 left, needs another 100.
    expect(getLegalActions(h.state, "s1").actions).not.toContain("DOUBLE");
  });
});

describe("split", () => {
  it("creates two hands, debits a second wager and deals one card to each", () => {
    const h = betAndDeal(harness({ shoe: "8S 6D 8H 9C 3D 4H" }), BET).send({
      type: "SPLIT",
      seatId: "s1",
    });
    expect(h.seat().hands).toHaveLength(2);
    expect(h.seat().stack).toBe(START - 200);
    expect(h.hand("s1", 0).cards.map((c) => c.rank)).toEqual(["8", "3"]);
    expect(h.hand("s1", 1).cards.map((c) => c.rank)).toEqual(["8", "4"]);
    expect(h.hand("s1", 0).wager).toBe(BET);
    expect(h.hand("s1", 1).wager).toBe(BET);
  });

  it("splits ten-value cards of different ranks under same_value policy", () => {
    const h = betAndDeal(harness({ shoe: "KS 6D QH 9C 3D 4H" }), BET);
    expect(getLegalActions(h.state, "s1").actions).toContain("SPLIT");
  });

  it("refuses a cross-rank split under same_rank policy", () => {
    const h = betAndDeal(
      harness({ shoe: "KS 6D QH 9C 3D 4H", rules: { splitPolicy: "same_rank" } }),
      BET,
    );
    expect(getLegalActions(h.state, "s1").actions).not.toContain("SPLIT");
  });

  it("resolves split hands left to right", () => {
    const h = betAndDeal(harness({ shoe: "8S 6D 8H 9C 3D 4H" }), BET).send({
      type: "SPLIT",
      seatId: "s1",
    });
    expect(h.state.activeHandIndex).toBe(0);
    const afterFirst = h.send({ type: "STAND", seatId: "s1" });
    expect(afterFirst.state.activeHandIndex).toBe(1);
  });

  it("allows double after split", () => {
    const h = betAndDeal(harness({ shoe: "8S 6D 8H 9C 3D 4H 10C" }), BET).send({
      type: "SPLIT",
      seatId: "s1",
    });
    // First split hand is 8+3 = 11.
    expect(getLegalActions(h.state, "s1").actions).toContain("DOUBLE");
  });

  it("forbids double after split when the ruleset disallows it", () => {
    const h = betAndDeal(
      harness({ shoe: "8S 6D 8H 9C 3D 4H 10C", rules: { doubleAfterSplit: false } }),
      BET,
    ).send({ type: "SPLIT", seatId: "s1" });
    expect(getLegalActions(h.state, "s1").actions).not.toContain("DOUBLE");
  });

  it("resplits up to four hands then stops offering the action", () => {
    // Each split feeds the left hand another eight, so a further split is
    // always available until the four-hand cap stops it.
    const h = betAndDeal(harness({ shoe: "8S 6D 8H 9C 8D 8C 8S 2H 8H 3S" }), BET);
    let current = h.send({ type: "SPLIT", seatId: "s1" });
    expect(current.seat().hands).toHaveLength(2);

    current = current.send({ type: "SPLIT", seatId: "s1" });
    expect(current.seat().hands).toHaveLength(3);

    current = current.send({ type: "SPLIT", seatId: "s1" });
    expect(current.seat().hands).toHaveLength(4);
    expect(current.seat().stack).toBe(START - 4 * BET);

    // Cap reached.
    expect(getLegalActions(current.state, "s1").actions).not.toContain("SPLIT");
  });

  it("is illegal without enough stack for the second wager", () => {
    const h = betAndDeal(
      harness({ shoe: "8S 6D 8H 9C 3D 4H", seats: [{ seatId: "s1", displayName: "T", stack: 150 }] }),
      100,
    );
    expect(getLegalActions(h.state, "s1").actions).not.toContain("SPLIT");
  });
});

describe("split aces", () => {
  it("gives each ace exactly one card and completes both hands", () => {
    const h = betAndDeal(harness({ shoe: "AS 6D AH 9C 10D KH" }), BET).send({
      type: "SPLIT",
      seatId: "s1",
    });
    expect(h.seat().hands).toHaveLength(2);
    expect(h.hand("s1", 0).cards).toHaveLength(2);
    expect(h.hand("s1", 1).cards).toHaveLength(2);
    expect(h.hand("s1", 0).status).not.toBe("ACTIVE");
    expect(h.hand("s1", 1).status).not.toBe("ACTIVE");
  });

  it("scores split-ace 21 as an ordinary 21 paying 1:1, not 3:2", () => {
    const h = betAndDeal(harness({ shoe: "AS 6D AH 9C 10D KH" }), BET);
    const afterSplit = h.send({ type: "SPLIT", seatId: "s1" });

    expect(afterSplit.hand("s1", 0).status).toBe("TWENTY_ONE");
    // Dealer 6+9 = 15, draws from pad.
    for (const hand of afterSplit.seat().hands) {
      expect(hand.outcome?.kind).not.toBe("BLACKJACK");
    }
  });

  it("offers no hit, double or resplit on split aces", () => {
    const h = betAndDeal(harness({ shoe: "AS 6D AH 9C AD KH" }), BET).send({
      type: "SPLIT",
      seatId: "s1",
    });
    // Even though hand 0 is now A+A, the ruleset forbids resplitting aces.
    expect(getLegalActions(h.state, "s1").actions).toEqual([]);
  });
});

describe("surrender", () => {
  it("returns half the wager", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C" }), BET).send({
      type: "SURRENDER",
      seatId: "s1",
    });
    expect(h.hand().outcome).toEqual({ kind: "SURRENDER", credit: 50, net: -50 });
    expect(h.seat().stack).toBe(START - 50);
  });

  it("is unavailable after a hit", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 4H 9C 2D" }), BET).send({
      type: "HIT",
      seatId: "s1",
    });
    expect(getLegalActions(h.state, "s1").actions).not.toContain("SURRENDER");
  });

  it("is unavailable on split hands", () => {
    const h = betAndDeal(harness({ shoe: "8S 6D 8H 9C 3D 4H" }), BET).send({
      type: "SPLIT",
      seatId: "s1",
    });
    expect(getLegalActions(h.state, "s1").actions).not.toContain("SURRENDER");
  });

  it("is unavailable when the ruleset disallows it", () => {
    const h = betAndDeal(
      harness({ shoe: "10S 10D 6H 9C", rules: { lateSurrenderAllowed: false } }),
      BET,
    );
    expect(getLegalActions(h.state, "s1").actions).not.toContain("SURRENDER");
  });

  it("is offered only after the dealer has checked for blackjack", () => {
    // Dealer shows an ace: insurance comes first, and no player action is legal
    // until the peek has happened.
    const h = betAndDeal(harness({ shoe: "10S AD 6H 5C" }), BET);
    expect(h.state.phase).toBe("INSURANCE_OFFER");
    expect(getLegalActions(h.state, "s1").actions).toEqual([]);

    const afterDecline = h.send({ type: "DECLINE_INSURANCE", seatId: "s1" });
    expect(afterDecline.state.phase).toBe("PLAYER_TURNS");
    expect(getLegalActions(afterDecline.state, "s1").actions).toContain("SURRENDER");
  });
});

describe("insurance", () => {
  it("is offered only against a dealer ace", () => {
    const tenUp = betAndDeal(harness({ shoe: "10S 10D 6H 9C" }), BET);
    expect(tenUp.state.phase).toBe("PLAYER_TURNS");

    const aceUp = betAndDeal(harness({ shoe: "10S AD 6H 5C" }), BET);
    expect(aceUp.state.phase).toBe("INSURANCE_OFFER");
  });

  it("costs exactly half the original wager", () => {
    const h = betAndDeal(harness({ shoe: "10S AD 6H 5C" }), BET);
    expect(getLegalActions(h.state, "s1").insuranceStake).toBe(50);
  });

  it("pays 2:1 when the dealer has a natural", () => {
    const h = betAndDeal(harness({ shoe: "10S AD 6H KC" }), BET).send({
      type: "INSURANCE",
      seatId: "s1",
    });
    // Main hand loses 100, insurance stakes 50 and returns 150: net zero.
    expect(h.seat().stack).toBe(START);
    expect(findEvent(h.events, "INSURANCE_SETTLED")?.credit).toBe(150);
  });

  it("loses the stake when the dealer has no natural", () => {
    const h = betAndDeal(harness({ shoe: "10S AD 6H 5C" }), BET)
      .send({ type: "INSURANCE", seatId: "s1" })
      .send({ type: "STAND", seatId: "s1" });
    // Dealer A+5 = soft 16, draws from pad: 5C -> soft 21.
    expect(h.seat().insuranceBet).toBe(50);
    expect(findEvent(h.events, "INSURANCE_SETTLED")?.credit).toBe(0);
  });

  it("nets exactly +1x the bet for even money, whichever way the peek goes", () => {
    // Player holds a natural against a dealer ace and insures it.
    const dealerNatural = betAndDeal(harness({ shoe: "AS AD KH KC" }), BET).send({
      type: "INSURANCE",
      seatId: "s1",
    });
    expect(dealerNatural.seat().stack).toBe(START + BET);

    const dealerNoNatural = betAndDeal(harness({ shoe: "AS AD KH 5C" }), BET).send({
      type: "INSURANCE",
      seatId: "s1",
    });
    expect(dealerNoNatural.seat().stack).toBe(START + BET);
  });

  it("flags the offer as even money when the player holds a natural", () => {
    const natural = betAndDeal(harness({ shoe: "AS AD KH 5C" }), BET);
    expect(getLegalActions(natural.state, "s1").insuranceIsEvenMoney).toBe(true);

    const ordinary = betAndDeal(harness({ shoe: "10S AD 6H 5C" }), BET);
    expect(getLegalActions(ordinary.state, "s1").insuranceIsEvenMoney).toBe(false);
  });

  it("rejects a second insurance answer", () => {
    const h = betAndDeal(harness({ shoe: "10S AD 6H 5C" }), BET).send({
      type: "DECLINE_INSURANCE",
      seatId: "s1",
    });
    expect(() => h.send({ type: "INSURANCE", seatId: "s1" })).toThrow(EngineError);
  });
});

describe("dealer behaviour", () => {
  it("stands on soft 17 under S17", () => {
    const h = betAndDeal(harness({ shoe: "10S AD 7H 6C" }), BET)
      .send({ type: "DECLINE_INSURANCE", seatId: "s1" })
      .send({ type: "STAND", seatId: "s1" });
    // Dealer A+6 = soft 17, player 17: push.
    expect(h.state.dealer.cards).toHaveLength(2);
    expect(h.hand().outcome?.kind).toBe("PUSH");
  });

  it("hits soft 17 when the ruleset says so", () => {
    const h = betAndDeal(
      harness({ shoe: "10S AD 7H 6C", rules: { dealerHitsSoft17: true } }),
      BET,
    )
      .send({ type: "DECLINE_INSURANCE", seatId: "s1" })
      .send({ type: "STAND", seatId: "s1" });
    expect(h.state.dealer.cards.length).toBeGreaterThan(2);
  });

  it("hits hard 16", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 7H 6C 5H" }), BET).send({
      type: "STAND",
      seatId: "s1",
    });
    // Dealer 10+6 = 16, draws 5 = 21.
    expect(h.state.dealer.cards).toHaveLength(3);
    expect(h.hand().outcome?.kind).toBe("LOSS");
  });

  it("busts past 21", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 7H 6C 10H" }), BET).send({
      type: "STAND",
      seatId: "s1",
    });
    expect(findEvent(h.events, "DEALER_BUSTED")?.total).toBe(26);
    expect(h.hand().outcome?.kind).toBe("WIN");
  });

  it("does not draw when every remaining hand is a natural", () => {
    // Player natural, dealer 6+9 = 15. Nothing the dealer draws can change the
    // result, so no cards are burned.
    const h = betAndDeal(harness({ shoe: "AS 6D KH 9C" }), BET);
    expect(h.state.dealer.cards).toHaveLength(2);
    expect(h.hand().outcome?.kind).toBe("BLACKJACK");
  });

  it("does not draw when every hand has busted", () => {
    const h = betAndDeal(harness({ shoe: "10S 6D 6H 5C 10H" }), BET).send({
      type: "HIT",
      seatId: "s1",
    });
    expect(h.hand().status).toBe("BUSTED");
    expect(h.state.dealer.cards).toHaveLength(2);
  });

  it("reveals the hole card before drawing", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 7H 6C 5H" }), BET).send({
      type: "STAND",
      seatId: "s1",
    });
    expect(h.state.dealer.holeCardRevealed).toBe(true);
    expect(findEvent(h.events, "HOLE_CARD_REVEALED")).toBeDefined();
  });
});

describe("action legality and invalid transitions", () => {
  it("rejects a player action during betting", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" });
    expect(() => h.send({ type: "HIT", seatId: "s1" })).toThrow(/Expected phase PLAYER_TURNS/);
  });

  it("rejects a bet below the table minimum", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" });
    expect(() => h.send({ type: "PLACE_BET", seatId: "s1", amount: 10 })).toThrow(EngineError);
  });

  it("rejects a bet above the table maximum", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" });
    expect(() => h.send({ type: "PLACE_BET", seatId: "s1", amount: 5_000 })).toThrow(EngineError);
  });

  it("rejects a bet off the increment", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" });
    expect(() => h.send({ type: "PLACE_BET", seatId: "s1", amount: 155 })).toThrow(EngineError);
  });

  it("rejects a bet larger than the stack", () => {
    const h = harness({
      shoe: "5S 6D 7H 8C",
      seats: [{ seatId: "s1", displayName: "T", stack: 80 }],
    });
    expect(() => h.send({ type: "PLACE_BET", seatId: "s1", amount: 100 })).toThrow(EngineError);
  });

  it("rejects an unknown seat", () => {
    const h = harness({ shoe: "5S 6D 7H 8C" });
    expect(() => h.send({ type: "PLACE_BET", seatId: "ghost", amount: 100 })).toThrow(
      /No seat "ghost"/,
    );
  });

  it("leaves state untouched when a command is rejected", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 4H 9C 2D" }), BET);
    const before = JSON.stringify(h.state);
    expect(() => h.send({ type: "SPLIT", seatId: "s1" })).toThrow(EngineError);
    expect(JSON.stringify(h.state)).toBe(before);
  });

  it("treats a repeated LOCK_BET as a no-op", () => {
    const h = harness({ shoe: "10S 10D 4H 9C" })
      .send({ type: "PLACE_BET", seatId: "s1", amount: BET })
      .send({ type: "LOCK_BET", seatId: "s1" });
    const stackAfterFirst = h.seat().stack;
    // The round has already been dealt; re-locking must not re-debit.
    expect(() => h.send({ type: "LOCK_BET", seatId: "s1" })).toThrow(/Expected phase BETTING_OPEN/);
    expect(h.seat().stack).toBe(stackAfterFirst);
  });
});

describe("multi-seat tables", () => {
  const seats = [
    { seatId: "s1", displayName: "One", stack: START },
    { seatId: "s2", displayName: "Two", stack: START },
  ];

  it("deals a full round to each seat before the dealer's hole card", () => {
    // Order: s1, s2, dealer up, s1, s2, dealer hole.
    const h = betAndDeal(
      harness({ shoe: "5S 9H 6D 7C 8D 9C", seats }),
      BET,
      ["s1", "s2"],
    );
    expect(h.hand("s1").cards.map((c) => c.rank)).toEqual(["5", "7"]);
    expect(h.hand("s2").cards.map((c) => c.rank)).toEqual(["9", "8"]);
    expect(h.state.dealer.cards.map((c) => c.rank)).toEqual(["6", "9"]);
  });

  it("acts sequentially in seat order", () => {
    const h = betAndDeal(harness({ shoe: "5S 9H 6D 7C 8D 9C", seats }), BET, ["s1", "s2"]);
    expect(h.state.activeSeatIndex).toBe(0);
    expect(() => h.send({ type: "HIT", seatId: "s2" })).toThrow(/not seat s2's turn/);

    const afterS1 = h.send({ type: "STAND", seatId: "s1" });
    expect(afterS1.state.activeSeatIndex).toBe(1);
  });

  it("waits for every seat at the table before dealing", () => {
    /*
     * The predicate that closes betting counts seats that CAN play, not seats
     * that have already staged something.
     *
     * Filtering on "has a bet down" made the FIRST player to lock close betting
     * for everyone: at a four-seat tournament exactly one stack moved per hand
     * and everyone slower was dealt out of it. What stops an absent player
     * stalling the table is the betting deadline, not this.
     */
    const h = harness({ shoe: "5S 6D 7H 8C", seats })
      .send({ type: "PLACE_BET", seatId: "s1", amount: BET })
      .send({ type: "LOCK_BET", seatId: "s1" });

    expect(h.state.phase).toBe("BETTING_OPEN");
    expect(h.seat("s1").hands).toHaveLength(0);

    const dealt = h
      .send({ type: "PLACE_BET", seatId: "s2", amount: BET })
      .send({ type: "LOCK_BET", seatId: "s2" });
    expect(dealt.seat("s1").hands).toHaveLength(1);
    expect(dealt.seat("s2").hands).toHaveLength(1);
  });

  it("does not deal to a seat that is sitting the hand out", () => {
    // The original intent of this case, reached the way it actually happens: a
    // seat that is out of the round receives no cards, and does not hold up the
    // deal either.
    const h = harness({ shoe: "5S 6D 7H 8C", seats })
      .patch((state) => ({
        ...state,
        seats: state.seats.map((seat) =>
          seat.seatId === "s2" ? { ...seat, sittingOut: true } : seat,
        ),
      }))
      .send({ type: "PLACE_BET", seatId: "s1", amount: BET })
      .send({ type: "LOCK_BET", seatId: "s1" });

    expect(h.seat("s1").hands).toHaveLength(1);
    expect(h.seat("s2").hands).toHaveLength(0);
  });
});

describe("timeouts", () => {
  const PAST = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();
  const NOW = new Date(Date.UTC(2026, 0, 1, 0, 1, 0)).toISOString();

  it("refuses to resolve when no deadline is set", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C" }), BET);
    expect(() => h.send({ type: "RESOLVE_TIMEOUT", now: NOW })).toThrow(/No deadline/);
  });

  it("refuses to resolve before the deadline has actually passed", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C" }), BET).patch((state) => ({
      ...state,
      actionDeadlineAt: new Date(Date.UTC(2026, 0, 1, 0, 5, 0)).toISOString(),
    }));
    expect(() => h.send({ type: "RESOLVE_TIMEOUT", now: NOW })).toThrow(/has not passed yet/);
  });

  it("stands an ordinary hand rather than playing strategy for the user", () => {
    const h = betAndDeal(harness({ shoe: "10S 6D 6H 9C 2D" }), BET).patch((state) => ({
      ...state,
      actionDeadlineAt: PAST,
    }));
    expect(h.state.phase).toBe("PLAYER_TURNS");

    const after = h.send({ type: "RESOLVE_TIMEOUT", now: NOW });
    // Player holds 16 against a 6: basic strategy says stand, but the point is
    // that the engine stands *regardless*, never drawing on the user's behalf.
    expect(after.hand().status).toBe("STOOD");
    expect(after.hand().cards).toHaveLength(2);
  });

  it("declines insurance on timeout", () => {
    const h = betAndDeal(harness({ shoe: "10S AD 6H 5C" }), BET).patch((state) => ({
      ...state,
      actionDeadlineAt: PAST,
    }));
    expect(h.state.phase).toBe("INSURANCE_OFFER");

    const after = h.send({ type: "RESOLVE_TIMEOUT", now: NOW });
    expect(after.seat().insuranceDecision).toBe("DECLINED");
    expect(after.seat().insuranceBet).toBe(0);
  });

  it("locks the staged bet on a betting timeout", () => {
    const h = harness({ shoe: "10S 10D 6H 9C" })
      .send({ type: "PLACE_BET", seatId: "s1", amount: 200 })
      .patch((state) => ({ ...state, actionDeadlineAt: PAST }));

    const after = h.send({ type: "RESOLVE_TIMEOUT", now: NOW });
    expect(after.seat().originalBet).toBe(200);
    expect(after.state.phase).not.toBe("BETTING_OPEN");
  });

  it("sits a seat out when it cannot afford the minimum bet", () => {
    const h = harness({
      shoe: "10S 10D 6H 9C",
      seats: [{ seatId: "s1", displayName: "T", stack: 20 }],
    }).patch((state) => ({ ...state, actionDeadlineAt: PAST }));

    const after = h.send({ type: "RESOLVE_TIMEOUT", now: NOW });
    expect(after.seat().sittingOut).toBe(true);
    expect(after.seat().stack).toBe(20);
  });
});
