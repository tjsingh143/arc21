/**
 * What a computer player is allowed to see (Astra Refresh C).
 *
 * The rule is the specification's: AI seats "draw from the same fair shoe",
 * "do not see hidden cards", "do not know future cards". Running on the server
 * is not permission to look — the server holds the whole shoe in order and the
 * dealer's hole card, and a computer player must decide with exactly what a
 * person in its seat could see.
 *
 * The design makes that a property of a TYPE rather than of good behaviour: the
 * policy's only input is an `AiSeatObservation`, and the only way to build one
 * takes the sanitised `PublicGameState`. These tests attack that from four
 * sides, because each catches something the others cannot:
 *
 *   SHAPE      the observation's keys are an allowlist, so a field added to it
 *              fails here and has to be argued for;
 *   BYTES      the serialised observation carries no undealt card and no
 *              unrevealed hole card, over every state a real table produces —
 *              with a positive control, so the sweep cannot pass on a mismatch;
 *   BEHAVIOUR  two tables identical except for what is hidden — a different
 *              hole card, a different order of undealt cards — produce the SAME
 *              observation and therefore the same decision;
 *   SOURCE     the policy module names none of the engine's private types and
 *              imports nothing that could hand it one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyCommand,
  assertNoHiddenCardLeak,
  getLegalActions,
  toPublicState,
  type EngineCommand,
  type EngineState,
} from "../../shared/blackjack/index.js";
import {
  decideAiSeatAction,
  observeAiSeat,
  type AiSeatObservation,
} from "../../supabase/functions/_shared/ai-seat-policy.js";
import { AI_TEST_CONTEXT, aiTable, shuffledAiTable } from "../helpers/ai-table-harness.js";

const ROOT = new URL("../../", import.meta.url).pathname;

function observe(state: EngineState, seatId: string): AiSeatObservation {
  const observation = observeAiSeat(toPublicState(state), seatId, state.rules);
  if (observation === null) throw new Error(`no observation for ${seatId}`);
  return observation;
}

/** A scripted table, so every phase and every hidden-card situation is visited. */
function scriptedStep(state: EngineState, step: number): EngineCommand | null {
  switch (state.phase) {
    case "BETTING_OPEN":
      for (const seat of state.seats) {
        const legal = getLegalActions(state, seat.seatId);
        if (legal.canLockBet) return { type: "LOCK_BET", seatId: seat.seatId };
        if (legal.canPlaceBet && legal.betBounds) {
          return { type: "PLACE_BET", seatId: seat.seatId, amount: legal.betBounds.min };
        }
      }
      return null;
    case "INSURANCE_OFFER":
      for (const seat of state.seats) {
        if (getLegalActions(state, seat.seatId).canDeclineInsurance) {
          return { type: "DECLINE_INSURANCE", seatId: seat.seatId };
        }
      }
      return null;
    case "PLAYER_TURNS": {
      const seat = state.seats[state.activeSeatIndex ?? -1];
      if (!seat) return null;
      const actions = getLegalActions(state, seat.seatId).actions;
      const action = actions[step % actions.length];
      return action ? { type: action, seatId: seat.seatId } : null;
    }
    case "HAND_COMPLETE":
      return { type: "NEXT_HAND", seatId: state.seats[0]!.seatId };
    default:
      return null;
  }
}

/** Every state a few hundred scripted hands pass through. */
function sampledStates(): EngineState[] {
  const states: EngineState[] = [];
  for (const seed of [5, 19, 31]) {
    let state = shuffledAiTable(seed);
    for (let step = 0; step < 900; step += 1) {
      states.push(state);
      const command = scriptedStep(state, step);
      if (command === null) break;
      state = applyCommand(state, command, AI_TEST_CONTEXT).state;
    }
  }
  return states;
}

const SAMPLE = sampledStates();

/** The states in which something is genuinely hidden from the table. */
const HOLE_CARD_HIDDEN = SAMPLE.filter(
  (state) => state.dealer.cards.length >= 2 && !state.dealer.holeCardRevealed,
);

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("the observation's shape", () => {
  const observation = observe(SAMPLE.find((state) => state.phase === "PLAYER_TURNS")!, "ai-0");

  it("is exactly these fields — anything new has to be argued for here", () => {
    expect(Object.keys(observation).sort()).toEqual([
      "activeHandId",
      "dealerUpCard",
      "legal",
      "phase",
      "rules",
      "seat",
    ]);
    expect(Object.keys(observation.seat).sort()).toEqual([
      "betLocked",
      "connected",
      "hands",
      "originalBet",
      "seatId",
      "sittingOut",
      "stack",
    ]);
    for (const hand of observation.seat.hands) {
      expect(Object.keys(hand).sort()).toEqual(["cameFromSplit", "cards", "id", "status"]);
    }
  });

  it("carries no shoe, no dealer hand, no other seat and no random source", () => {
    const serialised = JSON.stringify(observation);
    for (const forbidden of ['"shoe"', '"nextIndex"', '"dealer"', '"seats"', '"random"', '"cutIndex"']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("holds no reference into the table it was built from", () => {
    const state = SAMPLE.find((candidate) => candidate.phase === "PLAYER_TURNS")!;
    const table = toPublicState(state);
    const built = observeAiSeat(table, "ai-0", state.rules)!;
    const card = built.seat.hands[0]?.cards[0];
    expect(card).toBeDefined();
    expect(card).not.toBe(table.seats[0]!.hands[0]!.cards[0]);
    expect(built.rules).not.toBe(state.rules);
  });

  it("is never built for a person's seat — nothing decides for a person", () => {
    const state = SAMPLE[0]!;
    expect(observeAiSeat(toPublicState(state), "person-1", state.rules)).toBeNull();
    expect(observeAiSeat(toPublicState(state), "nobody", state.rules)).toBeNull();
  });

  it("cannot be built from engine state, only from the public snapshot", () => {
    const state = SAMPLE[0]!;
    // A compile-time assertion: `tsc` fails if engine state were accepted here.
    // @ts-expect-error — the authoritative state is not a public snapshot.
    expect(() => observeAiSeat(state, "ai-0", state.rules)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

describe("what the observation contains", () => {
  it("found states with a hidden hole card to check", () => {
    expect(HOLE_CARD_HIDDEN.length).toBeGreaterThan(200);
  });

  it("never carries an undealt card or the unrevealed hole card, in any state", () => {
    for (const state of SAMPLE) {
      for (const seat of state.seats) {
        if (seat.isAi !== true) continue;
        // The same assertion the server runs on every observation it uses.
        expect(() => assertNoHiddenCardLeak(observe(state, seat.seatId), state)).not.toThrow();
      }
    }
  });

  it("names the hole card nowhere while it is face down — checked by id, directly", () => {
    for (const state of HOLE_CARD_HIDDEN) {
      const hole = state.dealer.cards[1]!;
      for (const seatId of ["ai-0", "ai-2"]) {
        expect(JSON.stringify(observe(state, seatId))).not.toContain(`"${hole.id}"`);
      }
    }
  });

  it("DOES carry the seat's own cards and the dealer's upcard — the sweep is not passing on a mismatch", () => {
    const state = HOLE_CARD_HIDDEN.find((candidate) =>
      candidate.seats[0]!.hands.some((hand) => hand.cards.length > 0),
    )!;
    const serialised = JSON.stringify(observe(state, "ai-0"));
    expect(serialised).toContain(`"${state.dealer.cards[0]!.id}"`);
    for (const card of state.seats[0]!.hands[0]!.cards) expect(serialised).toContain(`"${card.id}"`);
  });

  it("is refused by the server's own guard the moment it would carry the hole card", () => {
    // What a widened observation would trip in production: the driver runs this
    // exact assertion on every observation before the policy sees it.
    const state = HOLE_CARD_HIDDEN[0]!;
    const widened = { ...observe(state, "ai-0"), peek: state.dealer.cards[1] };
    expect(() => assertNoHiddenCardLeak(widened, state)).toThrow(/hole card/);
  });
});

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

/** The same table with a different card face down in the dealer's hole. */
function withAnotherHoleCard(state: EngineState): EngineState | null {
  const hole = state.dealer.cards[1];
  const undealt = state.shoe.cards.slice(state.shoe.nextIndex);
  const replacement = undealt.find(
    (card) => hole !== undefined && (card.rank !== hole.rank || card.suit !== hole.suit),
  );
  if (!hole || !replacement) return null;
  const shoeCards = state.shoe.cards.map((card) =>
    card.id === replacement.id ? hole : card,
  );
  return {
    ...state,
    dealer: { ...state.dealer, cards: [state.dealer.cards[0]!, replacement, ...state.dealer.cards.slice(2)] },
    shoe: { ...state.shoe, cards: shoeCards },
  };
}

/** The same table with every undealt card in the reverse order. */
function withShoeReversed(state: EngineState): EngineState {
  const dealt = state.shoe.cards.slice(0, state.shoe.nextIndex);
  const undealt = state.shoe.cards.slice(state.shoe.nextIndex).reverse();
  return { ...state, shoe: { ...state.shoe, cards: [...dealt, ...undealt] } };
}

describe("deciding with what is hidden changed", () => {
  const decisionStates = HOLE_CARD_HIDDEN.filter((state) =>
    state.seats.some(
      (seat) => seat.isAi === true && decideAiSeatAction(observe(state, seat.seatId)) !== null,
    ),
  );

  it("found decisions taken while the hole card was face down", () => {
    expect(decisionStates.length).toBeGreaterThan(100);
  });

  it("sees the same thing, and decides the same thing, whatever the hole card is", () => {
    let compared = 0;
    for (const state of decisionStates) {
      const other = withAnotherHoleCard(state);
      if (other === null) continue;
      expect(other.dealer.cards[1]!.id).not.toBe(state.dealer.cards[1]!.id);
      for (const seatId of ["ai-0", "ai-2"]) {
        const seen = observe(state, seatId);
        const seenOther = observe(other, seatId);
        expect(seenOther).toEqual(seen);
        expect(decideAiSeatAction(seenOther)).toEqual(decideAiSeatAction(seen));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  it("sees the same thing, and decides the same thing, whatever order the undealt cards are in", () => {
    for (const state of decisionStates) {
      const reordered = withShoeReversed(state);
      for (const seatId of ["ai-0", "ai-2"]) {
        expect(observe(reordered, seatId)).toEqual(observe(state, seatId));
        expect(decideAiSeatAction(observe(reordered, seatId))).toEqual(
          decideAiSeatAction(observe(state, seatId)),
        );
      }
    }
  });

  it("would notice if it could see the hole card: the engine state really did differ", () => {
    // The positive control for the two above. If the variant were identical to
    // the original, "the decision did not change" would prove nothing.
    const state = decisionStates[0]!;
    const other = withAnotherHoleCard(state)!;
    expect(other).not.toEqual(state);
    expect(toPublicState(other)).toEqual(toPublicState(state));
  });
});

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

describe("the policy's own source", () => {
  const source = readFileSync(
    join(ROOT, "supabase/functions/_shared/ai-seat-policy.ts"),
    "utf8",
  );
  const code = source
    // Comments explain the boundary and therefore NAME the forbidden things.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("is the file under test", () => {
    expect(code).toContain("export function decideAiSeatAction");
    expect(code).toContain("export function observeAiSeat");
  });

  it("names none of the engine's private shapes", () => {
    for (const name of [
      "EngineState",
      "BlackjackGameState",
      "SeatState",
      "DealerState",
      "Shoe",
      "RandomSource",
      "CommandContext",
      "holeCard",
      ".shoe",
      "nextIndex",
      "createShoe",
      "drawCard",
      "applyCommand",
    ]) {
      expect(code, `ai-seat-policy.ts mentions ${name}`).not.toContain(name);
    }
  });

  it("imports only the public engine surface and the strategy advisor", () => {
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual([
      "../../../shared/blackjack/index.js",
      "../../../shared/blackjack/index.js",
      "./strategy/index.ts",
    ]);
  });

  it("reaches the hole card's position only through the public snapshot's placeholder", () => {
    // `dealer.cards[0]` is the upcard by deal order; index 1 is the hole card,
    // and the policy never reads it.
    expect(code).toContain("table.dealer.cards[0]");
    expect(code).not.toMatch(/dealer\.cards\[1\]/);
  });
});

// A type-level check the compiler enforces: an observation has no way to name a
// card it was not given.
const _noShoe: AiSeatObservation extends { shoe: unknown } ? never : true = true;
const _noDealerHand: AiSeatObservation extends { dealer: unknown } ? never : true = true;
void _noShoe;
void _noDealerHand;
