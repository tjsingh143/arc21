/**
 * Resume safety.
 *
 * Engine state is persisted in two places that matter — a `jsonb` column on the
 * server and a SQLite blob on the device — and both round-trip it through JSON.
 * A hand that survives the app being killed is a promise the product makes, so
 * the round trip has to preserve every fact the next command depends on: the
 * phase, the shoe's ORDER and cursor, each hand's wager and status, which split
 * hand is in play, and the dealer's hidden card staying hidden.
 *
 * The strongest form of that check is not field-by-field equality, which only
 * proves the fields somebody thought to list. It is: apply the same command to
 * the original and to the restored copy and require the two results to be
 * indistinguishable. Anything lost in the round trip changes an outcome.
 */

import { describe, expect, it } from "vitest";

import { applyCommand, beginNextHand, type EngineState } from "../../shared/blackjack/reducer.js";
import { toPublicState, assertNoHiddenCardLeak } from "../../shared/blackjack/public-state.js";
import { assertShoeIntegrity } from "../../shared/blackjack/shoe.js";
import type { EngineCommand } from "../../shared/blackjack/types.js";
import { betAndDeal, harness, TEST_CONTEXT } from "../helpers/engine-harness.js";

function roundTrip(state: EngineState): EngineState {
  return JSON.parse(JSON.stringify(state)) as EngineState;
}

/** Dealer shows a seven — no insurance, no peek. */
const PLAIN = "10S 7H 7D 5C";
/** Dealer shows an ace, so the round rests at INSURANCE_OFFER. */
const ACE_UP = "10S AH 7D 5C";
/** s1 holds 8,8 and can split. */
const PAIR = "8S 7H 8D 5C 10H 10D";

const CASES: Array<{ label: string; build: () => EngineState; next: EngineCommand }> = [
  {
    label: "BETTING_OPEN with a staged but unlocked bet",
    build: () => harness({ shoe: PLAIN }).send({ type: "PLACE_BET", seatId: "s1", amount: 250 }).state,
    next: { type: "LOCK_BET", seatId: "s1" },
  },
  {
    label: "INSURANCE_OFFER with the decision still pending",
    build: () => betAndDeal(harness({ shoe: ACE_UP }), 100).state,
    next: { type: "INSURANCE", seatId: "s1" },
  },
  {
    label: "PLAYER_TURNS on an ordinary two-card hand",
    build: () => betAndDeal(harness({ shoe: PLAIN }), 100).state,
    next: { type: "HIT", seatId: "s1" },
  },
  {
    label: "PLAYER_TURNS between two split hands",
    build: () =>
      betAndDeal(harness({ shoe: PAIR }), 100)
        .send({ type: "SPLIT", seatId: "s1" })
        .send({ type: "STAND", seatId: "s1" }).state,
    next: { type: "STAND", seatId: "s1" },
  },
  {
    label: "HAND_COMPLETE after settlement",
    build: () => betAndDeal(harness({ shoe: PLAIN }), 100).send({ type: "STAND", seatId: "s1" }).state,
    next: { type: "NEXT_HAND", seatId: "s1" },
  },
];

describe("a serialised hand resumes as the same hand", () => {
  for (const { label, build, next } of CASES) {
    it(`survives a JSON round trip: ${label}`, () => {
      const original = build();
      const restored = roundTrip(original);

      expect(restored).toEqual(original);
      expect(restored.phase).toBe(original.phase);
      expect(restored.version).toBe(original.version);
      expect(restored.handNumber).toBe(original.handNumber);

      // The shoe's ORDER, not merely its length: a reordered shoe is a
      // different game dealt from the same cards.
      expect(restored.shoe.cards.map((card) => card.id)).toEqual(
        original.shoe.cards.map((card) => card.id),
      );
      expect(restored.shoe.nextIndex).toBe(original.shoe.nextIndex);
      expect(restored.shoe.cutIndex).toBe(original.shoe.cutIndex);
      expect(restored.shoe.shuffleNumber).toBe(original.shoe.shuffleNumber);

      // Wagers, hand statuses and the split cursor.
      expect(restored.seats.map((seat) => seat.stack)).toEqual(
        original.seats.map((seat) => seat.stack),
      );
      expect(restored.seats.flatMap((seat) => seat.hands.map((hand) => hand.wager))).toEqual(
        original.seats.flatMap((seat) => seat.hands.map((hand) => hand.wager)),
      );
      expect(restored.seats.flatMap((seat) => seat.hands.map((hand) => hand.status))).toEqual(
        original.seats.flatMap((seat) => seat.hands.map((hand) => hand.status)),
      );
      expect(restored.activeSeatIndex).toBe(original.activeSeatIndex);
      expect(restored.activeHandIndex).toBe(original.activeHandIndex);
      expect(restored.seats.map((seat) => seat.currentHandIndex)).toEqual(
        original.seats.map((seat) => seat.currentHandIndex),
      );

      // Dealer hidden information: the same cards, still hidden.
      expect(restored.dealer.cards.map((card) => card.id)).toEqual(
        original.dealer.cards.map((card) => card.id),
      );
      expect(restored.dealer.holeCardRevealed).toBe(original.dealer.holeCardRevealed);
    });

    it(`plays on identically after the round trip: ${label}`, () => {
      const original = build();
      const restored = roundTrip(original);

      const a = applyCommand(original, next, TEST_CONTEXT);
      const b = applyCommand(restored, next, TEST_CONTEXT);

      // Byte-for-byte, state and events. A field lost in the round trip either
      // changes a card, a chip or a status, and all three are in here.
      expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
      expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
    });
  }
});

describe("what a restored state must not do", () => {
  it("does not re-settle a hand that is already settled", () => {
    const settled = betAndDeal(harness({ shoe: PLAIN }), 100).send({ type: "STAND", seatId: "s1" }).state;
    const stackAfterSettlement = settled.seats[0]!.stack;
    const outcome = settled.seats[0]!.hands[0]!.outcome;
    expect(outcome).toBeDefined();

    // Restore, then push the engine as hard as a confused caller might: three
    // ADVANCEs at the resting phase.
    let restored = roundTrip(settled);
    for (let i = 0; i < 3; i++) {
      const result = applyCommand(restored, { type: "ADVANCE" }, TEST_CONTEXT);
      restored = result.state;
      expect(result.events).toEqual([]);
    }

    expect(restored.phase).toBe("HAND_COMPLETE");
    expect(restored.seats[0]!.stack).toBe(stackAfterSettlement);
    expect(restored.seats[0]!.hands[0]!.outcome).toEqual(outcome);
  });

  it("does not let a restored HAND_COMPLETE start two rounds", () => {
    const settled = betAndDeal(harness({ shoe: PLAIN }), 100).send({ type: "STAND", seatId: "s1" }).state;
    const first = beginNextHand(roundTrip(settled), TEST_CONTEXT);
    expect(first.state.handNumber).toBe(settled.handNumber + 1);

    // The round has begun; asking again is a phase error, not a second round.
    expect(() => beginNextHand(first.state, TEST_CONTEXT)).toThrow(/Cannot begin a new hand/);
    expect(first.state.handNumber).toBe(settled.handNumber + 1);
  });

  it("keeps the hole card hidden across a round trip", () => {
    const live = betAndDeal(harness({ shoe: PLAIN }), 100).state;
    const restored = roundTrip(live);

    expect(restored.dealer.holeCardRevealed).toBe(false);
    const payload = toPublicState(restored);
    expect(payload.dealer.cards[1]).toEqual({ hidden: true });
    // Proved against the RESTORED state, so a round trip that shuffled the
    // dealer's cards would be caught rather than compared against itself.
    expect(() => assertNoHiddenCardLeak(payload, restored)).not.toThrow();
    expect(payload.dealer.displayedTotal).toBe(7);
  });

  it("keeps the undealt shoe out of the public payload after a round trip", () => {
    const live = betAndDeal(harness({ shoe: PLAIN }), 100).state;
    const restored = roundTrip(live);
    expect(() => assertNoHiddenCardLeak(toPublicState(restored), restored)).not.toThrow();
  });
});

describe("a shuffled six-deck shoe survives persistence intact", () => {
  it("round-trips a real shoe with every card present exactly once", () => {
    // The fixture shoes above are short by design; this one is what a live
    // session actually persists.
    const live = betAndDeal(harness({ shoe: PLAIN }), 100).send({ type: "STAND", seatId: "s1" });
    const reshuffled = live
      .patch((state) => ({ ...state, shoe: { ...state.shoe, nextIndex: state.shoe.cutIndex } }))
      .nextHand().state;

    expect(reshuffled.shoe.cards).toHaveLength(312);

    const restored = roundTrip(reshuffled);
    expect(() => assertShoeIntegrity(restored.shoe, 6)).not.toThrow();
    expect(restored.shoe.cards.map((card) => card.id)).toEqual(
      reshuffled.shoe.cards.map((card) => card.id),
    );
  });
});

describe("structuredClone and JSON agree on engine state", () => {
  it("produces the same state either way, at every resting phase", () => {
    for (const { build } of CASES) {
      const original = build();
      expect(structuredClone(original)).toEqual(roundTrip(original));
    }
  });

  it("does not resurrect an absent optional flag as a present one", () => {
    // `sitOutNextHand` is optional so that states persisted before it existed
    // still load. JSON drops `undefined`; the restored seat must simply not
    // carry the key rather than carrying `false`, or "held out of one hand"
    // and "never held out" would stop being distinguishable in storage.
    const state = harness({ shoe: PLAIN }).state;
    expect("sitOutNextHand" in state.seats[0]!).toBe(false);
    expect("sitOutNextHand" in roundTrip(state).seats[0]!).toBe(false);

    const held: EngineState = {
      ...state,
      seats: state.seats.map((seat) => ({ ...seat, sitOutNextHand: true })),
    };
    expect(roundTrip(held).seats[0]!.sitOutNextHand).toBe(true);
  });
});

describe("the clone the engine uses to keep a rejected command harmless", () => {
  /*
   * `applyCommand` deep-clones its input so a throw cannot leave the caller's
   * state half-mutated. It prefers `structuredClone` and falls back to a JSON
   * round trip for runtimes that lack it. The fallback is the path an older
   * Hermes takes, and nothing exercised it — which would make "resume works"
   * true only on the machines the tests happen to run on.
   */
  it("produces the same result with structuredClone removed", () => {
    const before = betAndDeal(harness({ shoe: PAIR }), 100).state;
    const withNative = applyCommand(before, { type: "SPLIT", seatId: "s1" }, TEST_CONTEXT);

    const original = globalThis.structuredClone;
    try {
      // @ts-expect-error deliberately removing a global to reach the fallback
      delete globalThis.structuredClone;
      expect(typeof globalThis.structuredClone).toBe("undefined");

      const withFallback = applyCommand(before, { type: "SPLIT", seatId: "s1" }, TEST_CONTEXT);
      expect(JSON.stringify(withFallback.state)).toBe(JSON.stringify(withNative.state));
      expect(JSON.stringify(withFallback.events)).toBe(JSON.stringify(withNative.events));
    } finally {
      globalThis.structuredClone = original;
    }
  });

  it("still leaves the caller's state untouched on a refusal without structuredClone", () => {
    const before = betAndDeal(harness({ shoe: PLAIN }), 100).state;
    const snapshot = JSON.stringify(before);

    const original = globalThis.structuredClone;
    try {
      // @ts-expect-error deliberately removing a global to reach the fallback
      delete globalThis.structuredClone;
      expect(() => applyCommand(before, { type: "SPLIT", seatId: "s1" }, TEST_CONTEXT)).toThrow();
      expect(JSON.stringify(before)).toBe(snapshot);
    } finally {
      globalThis.structuredClone = original;
    }
  });
});
