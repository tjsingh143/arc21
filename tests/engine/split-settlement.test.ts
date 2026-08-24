/**
 * Settlement across several hands at one seat.
 *
 * A split is where the money model is easiest to get wrong: one seat, several
 * wagers, one of them possibly doubled, an insurance stake alongside, and a
 * dealer hand each of them is settled against independently. The single-hand
 * payout cases are covered next door; this file is about the ARITHMETIC when
 * there is more than one.
 */

import { describe, expect, it } from "vitest";

import { settlementRows } from "../../src/features/learn/ruleset-facts.js";
import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";
import { settleHand, settleInsurance } from "../../shared/blackjack/settlement.js";
import { ALL_HAND_OUTCOME_KINDS, type PlayerHand } from "../../shared/blackjack/types.js";
import { betAndDeal, cards, harness } from "../helpers/engine-harness.js";

const START = 10_000;

describe("three split hands with three different results", () => {
  /*
   * Deal order at one seat is player, dealer up, player, dealer hole, then the
   * split cards in the order the hands were created.
   *
   *   8S  6H  8D  10C   player 8,8   dealer 6 over 10 = 16, must draw
   *   8H  3D            split one   -> [8,8] and [8,3]
   *   2S  10H           split two   -> [8,2] [8,10] [8,3]
   *   5H  10D           first hand hits to 25 and busts
   *   10S               third hand doubles into 21
   *   2C                dealer draws to 18
   */
  const SHOE = "8S 6H 8D 10C 8H 3D 2S 10H 5H 10D 10S 2C";

  function playOut() {
    return betAndDeal(harness({ shoe: SHOE }), 100)
      .send({ type: "SPLIT", seatId: "s1" })
      .send({ type: "SPLIT", seatId: "s1" })
      .send({ type: "HIT", seatId: "s1" })
      .send({ type: "HIT", seatId: "s1" })
      .send({ type: "STAND", seatId: "s1" })
      .send({ type: "DOUBLE", seatId: "s1" });
  }

  it("holds three hands, resolved left to right", () => {
    const h = playOut();
    expect(h.state.phase).toBe("HAND_COMPLETE");
    expect(h.seat().hands).toHaveLength(3);
    expect(h.seat().hands.map((hand) => hand.status)).toEqual([
      "BUSTED",
      "STOOD",
      "DOUBLED_COMPLETE",
    ]);
    expect(h.seat().hands.every((hand) => hand.cameFromSplit)).toBe(true);
    expect(h.seat().hands.every((hand) => hand.cameFromSplitAces)).toBe(false);
  });

  it("settles each hand against the dealer independently", () => {
    const h = playOut();
    expect(h.state.dealer.cards).toHaveLength(3);

    const outcomes = h.seat().hands.map((hand) => hand.outcome);
    expect(outcomes[0]).toEqual({ kind: "BUST", credit: 0, net: -100 });
    expect(outcomes[1]).toEqual({ kind: "PUSH", credit: 100, net: 0 });
    // The doubled hand is settled on the DOUBLED wager, not the original.
    expect(outcomes[2]).toEqual({ kind: "WIN", credit: 400, net: 200 });
  });

  it("charges one wager per hand plus the double, and credits exactly the total", () => {
    const h = playOut();
    const wagers = h.seat().hands.map((hand) => hand.wager);
    expect(wagers).toEqual([100, 100, 200]);

    const committed = wagers.reduce((sum, wager) => sum + wager, 0);
    expect(committed).toBe(400);

    const credited = h.seat().hands.reduce((sum, hand) => sum + (hand.outcome?.credit ?? 0), 0);
    expect(credited).toBe(500);
    expect(h.seat().stack).toBe(START - committed + credited);
    expect(h.seat().stack).toBe(10_100);
  });

  it("gives every split hand its own id and its own settlement event", () => {
    const h = playOut();
    const ids = h.seat().hands.map((hand) => hand.id);
    expect(new Set(ids).size).toBe(3);

    const settled = h.events.filter((event) => event.type === "HAND_SETTLED");
    expect(settled).toHaveLength(3);
    expect(settled.map((event) => (event as { handId: string }).handId).sort()).toEqual(
      [...ids].sort(),
    );
  });
});

describe("insurance alongside a split", () => {
  /*
   *   8S  AH  8D  5C    player 8,8   dealer ace over five: an offer, no natural
   *   10H 9D            split       -> [8,10] = 18 and [8,9] = 17
   *   2C                dealer draws from soft 16 to soft 18
   */
  const SHOE = "8S AH 8D 5C 10H 9D 2C";

  function playOut() {
    return betAndDeal(harness({ shoe: SHOE }), 100)
      .send({ type: "INSURANCE", seatId: "s1" })
      .send({ type: "SPLIT", seatId: "s1" })
      .send({ type: "STAND", seatId: "s1" })
      .send({ type: "STAND", seatId: "s1" });
  }

  it("charges the insurance stake against the ORIGINAL bet, not the split total", () => {
    const h = playOut();
    // Half of 100, even though 200 ends up on the felt.
    expect(h.seat().insuranceBet).toBe(50);
  });

  it("loses the side bet and settles the two hands on their own merits", () => {
    const h = playOut();
    expect(h.state.phase).toBe("HAND_COMPLETE");

    const outcomes = h.seat().hands.map((hand) => hand.outcome?.kind);
    expect(outcomes).toEqual(["PUSH", "LOSS"]);

    // 100 bet + 50 insurance + 100 second wager committed; 100 comes back.
    expect(h.seat().stack).toBe(START - 250 + 100);
  });

  it("pays the side bet 2:1 when the dealer's ace really is a natural", () => {
    // Same offer, a ten underneath. The peek ends the hand before any split.
    const h = betAndDeal(harness({ shoe: "9S AH 8D KC" }), 100).send({
      type: "INSURANCE",
      seatId: "s1",
    });

    expect(h.state.phase).toBe("HAND_COMPLETE");
    expect(h.hand().outcome?.kind).toBe("LOSS");
    // 100 lost on the hand, 50 staked and 150 returned on insurance: level.
    expect(h.seat().stack).toBe(START - 150 + 150);
    expect(h.seat().stack).toBe(START);
  });
});

describe("surrender returns exactly half, floored", () => {
  it("halves an even wager", () => {
    const h = betAndDeal(harness({ shoe: "10S 7H 6D 5C" }), 200).send({
      type: "SURRENDER",
      seatId: "s1",
    });
    expect(h.hand().outcome).toEqual({ kind: "SURRENDER", credit: 100, net: -100 });
    expect(h.seat().stack).toBe(START - 200 + 100);
  });

  it("floors an odd one rather than rounding a chip into existence", () => {
    // 250 is a legal wager: it clears the 50 minimum and the 10 increment.
    const h = betAndDeal(harness({ shoe: "10S 7H 6D 5C" }), 250).send({
      type: "SURRENDER",
      seatId: "s1",
    });
    expect(h.hand().outcome).toEqual({ kind: "SURRENDER", credit: 125, net: -125 });
    expect(Number.isInteger(h.seat().stack)).toBe(true);
    expect(h.seat().stack).toBe(START - 250 + 125);
  });

  it("does not consult the dealer's hand at all", () => {
    // The dealer holds a natural under a ten. Surrender still returns half,
    // which is the point of surrendering LATE — after the peek cleared it.
    const surrenderedAgainstNothing = betAndDeal(harness({ shoe: "10S 7H 6D 5C" }), 100).send({
      type: "SURRENDER",
      seatId: "s1",
    });
    expect(surrenderedAgainstNothing.hand().outcome?.credit).toBe(50);
  });
});

describe("split aces are settled as ordinary hands", () => {
  /*
   *   AS  7H  AD  5C    player A,A   dealer 7 over 5 = 12, must draw
   *   KH  9D            one card each: 21 and 20, both complete
   *   9C                dealer draws to 21
   */
  it("pays a split-ace 21 at 1:1 and can still push against the dealer", () => {
    const h = betAndDeal(harness({ shoe: "AS 7H AD 5C KH 9D 9C" }), 100).send({
      type: "SPLIT",
      seatId: "s1",
    });

    expect(h.state.phase).toBe("HAND_COMPLETE");
    expect(h.seat().hands.map((hand) => hand.cards.length)).toEqual([2, 2]);
    expect(h.seat().hands.map((hand) => hand.status)).toEqual(["TWENTY_ONE", "STOOD"]);

    // Dealer reaches 21 too, so the split-ace 21 PUSHES. Had it been treated as
    // a natural it would have won 3:2 against a non-natural 21 instead.
    expect(h.seat().hands[0]!.outcome).toEqual({ kind: "PUSH", credit: 100, net: 0 });
    expect(h.seat().hands[1]!.outcome?.kind).toBe("LOSS");
    expect(h.seat().stack).toBe(START - 200 + 100);
  });
});

describe("every outcome kind the domain declares is one the engine produces", () => {
  it("produces WIN, LOSS, PUSH, BLACKJACK, BUST and SURRENDER from real play", () => {
    const produced = new Set<string>();
    const record = (h: ReturnType<typeof harness>) => {
      for (const seat of h.state.seats) {
        for (const hand of seat.hands) if (hand.outcome) produced.add(hand.outcome.kind);
      }
    };

    // WIN and PUSH and BUST come out of the three-way split above.
    record(
      betAndDeal(harness({ shoe: "8S 6H 8D 10C 8H 3D 2S 10H 5H 10D 10S 2C" }), 100)
        .send({ type: "SPLIT", seatId: "s1" })
        .send({ type: "SPLIT", seatId: "s1" })
        .send({ type: "HIT", seatId: "s1" })
        .send({ type: "HIT", seatId: "s1" })
        .send({ type: "STAND", seatId: "s1" })
        .send({ type: "DOUBLE", seatId: "s1" }),
    );
    // BLACKJACK.
    record(betAndDeal(harness({ shoe: "AS 7H KD 5C 9D" }), 100));
    // LOSS.
    record(
      betAndDeal(harness({ shoe: "9S 8H 8D 10C 3H" }), 100).send({ type: "STAND", seatId: "s1" }),
    );
    // SURRENDER.
    record(
      betAndDeal(harness({ shoe: "10S 7H 6D 5C" }), 100).send({ type: "SURRENDER", seatId: "s1" }),
    );

    expect([...produced].sort()).toEqual([...ALL_HAND_OUTCOME_KINDS].sort());
  });
});

describe("the settlement table the app SHOWS agrees with what the engine PAYS", () => {
  /*
   * `settlementRows` builds the Learn screen's payout table from the ruleset's
   * ratios, and its own tests assert the STRINGS: "2.5× your bet", "0.5× your
   * bet". Nothing compared either side to `settleHand`. Both could drift
   * together and both suites would still be green, which would leave the app
   * telling players something about the engine that was no longer true — and a
   * payout claim is one the Fair Play screen is not allowed to get wrong.
   *
   * So this reads the published table and settles a real hand for each row.
   */
  const rules = ARC_STANDARD_RULES;
  const WAGER = 100;

  const hand = (spec: string, overrides: Partial<PlayerHand> = {}): PlayerHand => ({
    id: "h",
    cards: cards(spec),
    wager: WAGER,
    status: "STOOD",
    cameFromSplit: false,
    cameFromSplitAces: false,
    ...overrides,
  });

  /** "2.5× your bet" -> 2.5; "Nothing" -> 0. */
  function multipleFrom(returns: string): number {
    if (returns === "Nothing") return 0;
    const match = /^([\d.]+)×/.exec(returns);
    if (!match) throw new Error(`unparseable settlement row "${returns}"`);
    return Number(match[1]);
  }

  const rows = new Map(settlementRows(rules).map((row) => [row.result, row.returns]));

  it("parses the table it is about to check, so a reworded row cannot pass silently", () => {
    expect([...rows.keys()].sort()).toEqual(
      ["Blackjack", "Insurance", "Loss or bust", "Push", "Surrender", "Win"].sort(),
    );
  });

  it("pays a natural exactly the multiple the Blackjack row promises", () => {
    const outcome = settleHand(hand("AS KD", { status: "BLACKJACK" }), { cards: cards("9H 8D"), hasNaturalBlackjack: false }, rules);
    expect(outcome.credit).toBe(WAGER * multipleFrom(rows.get("Blackjack")!));
  });

  it("pays an ordinary win exactly the multiple the Win row promises", () => {
    const outcome = settleHand(hand("10S 9D"), { cards: cards("9H 8D"), hasNaturalBlackjack: false }, rules);
    expect(outcome.kind).toBe("WIN");
    expect(outcome.credit).toBe(WAGER * multipleFrom(rows.get("Win")!));
  });

  it("returns exactly the multiple the Push row promises", () => {
    const outcome = settleHand(hand("10S 7D"), { cards: cards("9H 8D"), hasNaturalBlackjack: false }, rules);
    expect(outcome.kind).toBe("PUSH");
    expect(outcome.credit).toBe(WAGER * multipleFrom(rows.get("Push")!));
  });

  it("credits exactly what the Loss or bust row promises", () => {
    const lost = settleHand(hand("10S 5D"), { cards: cards("9H 8D"), hasNaturalBlackjack: false }, rules);
    const busted = settleHand(hand("10S 5D 9C", { status: "BUSTED" }), { cards: cards("9H 8D"), hasNaturalBlackjack: false }, rules);
    expect(lost.credit).toBe(WAGER * multipleFrom(rows.get("Loss or bust")!));
    expect(busted.credit).toBe(WAGER * multipleFrom(rows.get("Loss or bust")!));
  });

  it("returns exactly the multiple the Surrender row promises", () => {
    const outcome = settleHand(hand("10S 6D", { status: "SURRENDERED" }), { cards: cards("9H 8D"), hasNaturalBlackjack: false }, rules);
    expect(outcome.credit).toBe(WAGER * multipleFrom(rows.get("Surrender")!));
  });

  it("returns exactly the multiple the Insurance row promises, on the STAKE", () => {
    const stake = 50;
    const returns = rows.get("Insurance")!;
    const match = /^([\d.]+)× the insurance stake$/.exec(returns);
    expect(match, `unexpected insurance row "${returns}"`).not.toBeNull();
    const credit = settleInsurance(stake, { cards: cards("AS KD"), hasNaturalBlackjack: true }, rules);
    expect(credit).toBe(stake * Number(match![1]));
  });

  it("moves together when the payout ratio moves", () => {
    // 6:5 is the ratio a table would advertise if it wanted a bigger edge. The
    // claim and the engine must reach the same place from the same field.
    const sixToFive = { ...rules, blackjackPayoutNumerator: 6, blackjackPayoutDenominator: 5 };
    const claimed = new Map(settlementRows(sixToFive).map((row) => [row.result, row.returns]));
    const outcome = settleHand(
      hand("AS KD", { status: "BLACKJACK" }),
      { cards: cards("9H 8D"), hasNaturalBlackjack: false },
      sixToFive,
    );
    /*
     * `toBeCloseTo`, and only here, for an honest reason: the published row is a
     * DECIMAL rendering (1 + 6/5 = 2.2000000000000002, shown as "2.2") while the
     * engine floors integer arithmetic. `100 * 2.2` is 220.00000000000003 in
     * binary floating point and the engine's credit is exactly 220 — which is
     * the two models agreeing, not disagreeing. The exact integer assertion on
     * the next line is the one that pins the payout.
     */
    expect(outcome.credit).toBeCloseTo(WAGER * multipleFrom(claimed.get("Blackjack")!), 6);
    expect(outcome.credit).toBe(220);
    expect(Number.isInteger(outcome.credit)).toBe(true);
  });
});
