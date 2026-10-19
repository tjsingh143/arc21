/**
 * Playing the computer seats inside the person's command (Astra Refresh C).
 *
 * `driveAiSeats` is what `game-command` and `create-session` call after the
 * engine has applied a person's command. It must:
 *
 *   * ask computer players to stake only once every person has locked a bet;
 *   * answer insurance for them at once, and play their turns, until the table
 *     waits on a person, rests, or ends;
 *   * apply every decision through the person's own path — the server's
 *     legality gate, the wire-to-engine translation and the engine — so an
 *     illegal one is refused like an illegal tap;
 *   * never act for a person, and never start a hand;
 *   * stop, always, within a bound that throws when it is reached.
 *
 * Shoes are named card by card. For the default layout — `ai-0`, `person-1`,
 * `ai-2` — the deal is ai-0, person-1, ai-2, UP, ai-0, person-1, ai-2, HOLE,
 * and every card after that goes to whoever draws next.
 */

import { describe, expect, it } from "vitest";

import {
  AI_TABLE_MIN_BET,
  applyCommand,
  EngineError,
  getLegalActions,
  SeededTestRandomSource,
  toPublicState,
  type EngineCommand,
  type EngineState,
} from "../../shared/blackjack/index.js";
import {
  AI_SEAT_COMMAND_LIMIT_PER_SEAT,
  aiSeatsMayBet,
  AiSeatDriverError,
  applyAiSeatDecision,
  driveAiSeats,
  driveAiSeatsWithin,
  nextAiSeatAction,
  type AiSeatContext,
} from "../../supabase/functions/_shared/ai-seat-driver.js";
import {
  AI_TEST_CONTEXT,
  aiTable,
  personBets,
  personSends,
  shuffledAiTable,
  type SeatKind,
} from "../helpers/ai-table-harness.js";

const PERSON = "person-1";

/** A command applied by the engine alone, with no computer decision taken after it. */
function engineOnly(state: EngineState, command: EngineCommand): EngineState {
  return applyCommand(state, command, AI_TEST_CONTEXT).state;
}

function decisionsOf(actions: readonly { seatId: string; decision: { type: string } }[]): string[] {
  return actions.map((action) => `${action.seatId}:${action.decision.type}`);
}

// ---------------------------------------------------------------------------
// Betting waits for the person
// ---------------------------------------------------------------------------

describe("when computer players stake", () => {
  // ai-0 10,7 · person 9,7 · ai-2 10,9 · dealer 6 up, 10 in the hole.
  const SHOE = "10S 9H 10D 6C 7S 7H 9D 10C";

  it("not while the person is still choosing", () => {
    const state = aiTable({ shoe: SHOE });
    const drive = driveAiSeats(state, AI_TEST_CONTEXT);
    expect(drive.actions).toEqual([]);
    expect(drive.state).toBe(state);

    // A bet staged but not locked is still a person choosing.
    const staged = personSends(state, { type: "PLACE_BET", seatId: PERSON, amount: 100 });
    expect(staged.aiActions).toEqual([]);
    expect(staged.state.seats[0]!.originalBet).toBe(0);
  });

  it("the moment the person locks — and the last of them to lock deals the hand", () => {
    const step = personBets(aiTable({ shoe: SHOE }), 100);
    expect(decisionsOf(step.aiActions)).toEqual([
      "ai-0:PLACE_BET",
      "ai-0:LOCK_BET",
      "ai-2:PLACE_BET",
      "ai-2:LOCK_BET",
      // Dealt, and ai-0 acts first: 17 against a 6 stands.
      "ai-0:STAND",
    ]);
    expect(step.state.seats[0]!.hands[0]!.wager).toBe(AI_TABLE_MIN_BET);
    expect(step.state.seats[2]!.hands[0]!.wager).toBe(AI_TABLE_MIN_BET);
    // And the table hands the turn to the person.
    expect(step.state.phase).toBe("PLAYER_TURNS");
    expect(toPublicState(step.state).activeSeatId).toBe(PERSON);
  });

  it("is judged from the public snapshot: people still in the round, all locked", () => {
    const fresh = toPublicState(aiTable({ shoe: SHOE }));
    expect(aiSeatsMayBet(fresh)).toBe(false);

    const lockedPerson = {
      ...fresh,
      seats: fresh.seats.map((seat) => (seat.isAi === true ? seat : { ...seat, betLocked: true })),
    };
    expect(aiSeatsMayBet(lockedPerson)).toBe(true);

    // A person who has gone, or is sitting the hand out, is not waited for — and
    // with nobody left to play with, computer players do not bet at all.
    const nobodyHere = {
      ...fresh,
      seats: fresh.seats.map((seat) => (seat.isAi === true ? seat : { ...seat, connected: false })),
    };
    expect(aiSeatsMayBet(nobodyHere)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

describe("turns", () => {
  it("passes from a computer player to the person, and from the person to a computer player", () => {
    // ai-0 10,7 · person 9,7 · ai-2 10,9 · dealer 6 up, 10 hole; dealer then draws a 5.
    const dealt = personBets(aiTable({ shoe: "10S 9H 10D 6C 7S 7H 9D 10C 5S" }), 100);
    expect(toPublicState(dealt.state).activeSeatId).toBe(PERSON);

    const stood = personSends(dealt.state, { type: "STAND", seatId: PERSON });
    // ai-2 holds 19 against a 6 and stands; the dealer plays; the hand settles.
    expect(decisionsOf(stood.aiActions)).toEqual(["ai-2:STAND"]);
    expect(stood.state.phase).toBe("HAND_COMPLETE");

    // The person's own events come first, the computer player's after them.
    const types = stood.events.map((event) => event.type);
    expect(types[0]).toBe("PLAYER_ACTION");
    expect(stood.events[0]).toMatchObject({ seatId: PERSON, action: "STAND" });
    expect(stood.events.find((event, index) => index > 0 && event.type === "PLAYER_ACTION")).toMatchObject(
      { seatId: "ai-2", action: "STAND" },
    );
    const settled = stood.events.filter((event) => event.type === "HAND_SETTLED");
    expect(settled.map((event) => (event as { seatId: string }).seatId).sort()).toEqual(
      ["ai-0", "ai-2", PERSON].sort(),
    );
  });

  it("plays consecutive computer turns without stopping", () => {
    // person 10,9 · ai-1 10,8 · ai-2 10,7 · dealer 6 up, 10 hole.
    const layout: SeatKind[] = ["person", "ai", "ai"];
    const dealt = personBets(aiTable({ shoe: "10S 10H 10D 6C 9S 8H 7D 10C 5S", layout }), 100, "person-0");
    expect(toPublicState(dealt.state).activeSeatId).toBe("person-0");

    const stood = personSends(dealt.state, { type: "STAND", seatId: "person-0" });
    expect(decisionsOf(stood.aiActions)).toEqual(["ai-1:STAND", "ai-2:STAND"]);
    expect(stood.state.phase).toBe("HAND_COMPLETE");
  });

  it("plays a computer player's every hand after a split, in order", () => {
    // ai-0 8,8 against a 6 splits; its halves draw a 3 (11) and a 10 (18).
    // person 10,9 · ai-2 10,9 · dealer 6 up, 10 hole.
    const step = personBets(aiTable({ shoe: "8S 10H 10D 6C 8H 9S 9D 10C 3S 10S 5D" }), 100);
    const ai0 = step.aiActions.filter((action) => action.seatId === "ai-0").map((a) => a.decision.type);
    expect(ai0).toEqual(["PLACE_BET", "LOCK_BET", "SPLIT", "DOUBLE", "STAND"]);
    const hands = step.state.seats[0]!.hands;
    expect(hands).toHaveLength(2);
    // The doubled half carries twice the wager; the stack paid for the split and the double.
    expect(hands.map((hand) => hand.wager)).toEqual([2 * AI_TABLE_MIN_BET, AI_TABLE_MIN_BET]);
    expect(step.state.seats[0]!.stack).toBe(5_000 - 3 * AI_TABLE_MIN_BET);
    expect(toPublicState(step.state).activeSeatId).toBe(PERSON);
  });

  it("doubles where the chart doubles", () => {
    // ai-0 6,5 = 11 against a 6, then draws a 9.
    const step = personBets(aiTable({ shoe: "6S 10H 10D 6C 5S 9H 9D 10C 9S" }), 100);
    expect(step.aiActions.map((action) => action.decision.type)).toContain("DOUBLE");
    expect(step.state.seats[0]!.hands[0]!.status).toBe("DOUBLED_COMPLETE");
  });

  it("surrenders where the chart surrenders", () => {
    // ai-0 10,6 = hard 16 against a 10 (the dealer peeks: a 7 in the hole).
    const step = personBets(aiTable({ shoe: "10S 9H 10D 10C 6S 8H 9D 7C" }), 100);
    expect(decisionsOf(step.aiActions)).toContain("ai-0:SURRENDER");
    expect(step.state.seats[0]!.hands[0]!.status).toBe("SURRENDERED");
  });
});

// ---------------------------------------------------------------------------
// Insurance
// ---------------------------------------------------------------------------

describe("the insurance offer", () => {
  // ai-0 10,8 · person 9,7 · ai-2 8,9 · dealer ACE up, 5 in the hole.
  const SHOE = "10S 9H 8D AC 8S 7H 9D 5C 5S";

  it("is answered for the computer players at once, and then waits for the person", () => {
    const step = personBets(aiTable({ shoe: SHOE }), 100);
    expect(step.state.phase).toBe("INSURANCE_OFFER");
    expect(decisionsOf(step.aiActions)).toEqual([
      "ai-0:PLACE_BET",
      "ai-0:LOCK_BET",
      "ai-2:PLACE_BET",
      "ai-2:LOCK_BET",
      "ai-0:DECLINE_INSURANCE",
      "ai-2:DECLINE_INSURANCE",
    ]);
    expect(step.state.seats.map((seat) => seat.insuranceDecision)).toEqual([
      "DECLINED",
      "PENDING",
      "DECLINED",
    ]);
    expect(nextAiSeatAction(step.state)).toBeNull();
  });

  it("moves on when the person answers: the dealer peeks, and the computer player before them plays", () => {
    const offered = personBets(aiTable({ shoe: SHOE }), 100);
    const answered = personSends(offered.state, { type: "DECLINE_INSURANCE", seatId: PERSON });
    // ai-0 holds 18 against an ace: stand.
    expect(decisionsOf(answered.aiActions)).toEqual(["ai-0:STAND"]);
    expect(toPublicState(answered.state).activeSeatId).toBe(PERSON);
  });

  it("ends the hand with nobody asked anything when the dealer turns over a natural", () => {
    // Same seats, but a KING in the hole.
    const offered = personBets(aiTable({ shoe: "10S 9H 8D AC 8S 7H 9D KC" }), 100);
    const answered = personSends(offered.state, { type: "DECLINE_INSURANCE", seatId: PERSON });
    expect(answered.aiActions).toEqual([]);
    expect(answered.state.phase).toBe("HAND_COMPLETE");
  });
});

// ---------------------------------------------------------------------------
// The edges of the table's life
// ---------------------------------------------------------------------------

describe("the edges", () => {
  it("lets a computer player that cannot cover the minimum leave, rather than freeze the round", () => {
    const state = aiTable({ shoe: "10S 9H 10D 6C 7S 7H 9D 10C", stacks: [AI_TABLE_MIN_BET - 10, 5_000, 5_000] });
    const step = personBets(state, 100);
    expect(decisionsOf(step.aiActions).slice(0, 3)).toEqual([
      "ai-0:LEAVE",
      "ai-2:PLACE_BET",
      "ai-2:LOCK_BET",
    ]);
    const ai0 = step.state.seats[0]!;
    expect(ai0.connected).toBe(false);
    expect(ai0.sittingOut).toBe(true);
    expect(ai0.hands).toEqual([]);
    // The hand was dealt to everybody still in it.
    expect(step.state.seats[1]!.hands).toHaveLength(1);
    expect(step.state.seats[2]!.hands).toHaveLength(1);
  });

  it("deals nothing to computer players alone when the person stands up to leave", () => {
    const left = personSends(aiTable({ shoe: "10S 9H 10D 6C 7S 7H 9D 10C" }), {
      type: "LEAVE",
      seatId: PERSON,
    });
    expect(left.aiActions).toEqual([]);
    expect(left.state.phase).toBe("BETTING_OPEN");
    expect(left.state.dealer.cards).toEqual([]);
    expect(left.state.shoe.nextIndex).toBe(0);
  });

  it("never starts the next hand: the settled table rests until the person asks", () => {
    const dealt = personBets(aiTable({ shoe: "10S 9H 10D 6C 7S 7H 9D 10C 5S" }), 100);
    const settled = personSends(dealt.state, { type: "STAND", seatId: PERSON }).state;
    expect(settled.phase).toBe("HAND_COMPLETE");
    expect(driveAiSeats(settled, AI_TEST_CONTEXT).actions).toEqual([]);
    expect(getLegalActions(settled, "ai-0").canStartNextHand).toBe(true);
  });

  it("leaves a table with no computer seats exactly as it was", () => {
    const state = aiTable({ shoe: "10S 9H 10D 6C", layout: ["person"] });
    const drive = driveAiSeats(state, AI_TEST_CONTEXT);
    expect(drive.state).toBe(state);
    expect(drive.actions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The server's gate, and the people at the table
// ---------------------------------------------------------------------------

describe("an AI decision takes the person's path", () => {
  const betting = () => aiTable({ shoe: "10S 9H 10D 6C 7S 7H 9D 10C" });

  it("is refused, like a person's, when it is not legal", () => {
    const state = betting();
    const refused = (decision: Parameters<typeof applyAiSeatDecision>[2]) => {
      try {
        applyAiSeatDecision(state, "ai-0", decision, AI_TEST_CONTEXT);
      } catch (error) {
        return error instanceof EngineError ? error.code : String(error);
      }
      return "accepted";
    };
    expect(refused({ type: "DOUBLE" })).toBe("WRONG_PHASE");
    expect(refused({ type: "LOCK_BET" })).toBe("ILLEGAL_ACTION");
    expect(refused({ type: "DECLINE_INSURANCE" })).toBe("INSURANCE_NOT_AVAILABLE");
    // Betting IS open, so the gate lets the bet through and the engine refuses
    // the amount — exactly the answer a person's oversized bet gets.
    expect(refused({ type: "PLACE_BET", amount: 1_000_000 })).toBe("BET_ABOVE_MAXIMUM");
  });

  it("is refused out of turn with the same code a person would get", () => {
    const dealt = personBets(aiTable({ shoe: "10S 9H 10D 6C 7S 7H 9D 10C" }), 100).state;
    expect(() => applyAiSeatDecision(dealt, "ai-2", { type: "HIT" }, AI_TEST_CONTEXT)).toThrow(
      expect.objectContaining({ code: "NOT_YOUR_TURN" }),
    );
  });

  it("never acts for a person", () => {
    const state = betting();
    expect(() =>
      applyAiSeatDecision(state, PERSON, { type: "PLACE_BET", amount: 20 }, AI_TEST_CONTEXT),
    ).toThrow(AiSeatDriverError);
  });

  it("leaves the state it was given untouched when it is refused", () => {
    const state = betting();
    const before = JSON.stringify(state);
    expect(() => applyAiSeatDecision(state, "ai-0", { type: "STAND" }, AI_TEST_CONTEXT)).toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("the bound", () => {
  it("allows the most one hand can ask of a computer seat, with room to spare", () => {
    // Two to bet (or one to leave), one insurance answer, three splits and at
    // most ten decisions on each of four hands: 46.
    expect(AI_SEAT_COMMAND_LIMIT_PER_SEAT).toBeGreaterThanOrEqual(46);
  });

  it("throws, rather than committing, when a drive reaches it", () => {
    const staged = personSends(aiTable({ shoe: "10S 9H 10D 6C 7S 7H 9D 10C" }), {
      type: "PLACE_BET",
      seatId: PERSON,
      amount: 100,
    }).state;
    // The person's lock applied by the engine alone: the table now owes the
    // computer players five decisions (two bets each, then ai-0's stand).
    const locked = engineOnly(staged, { type: "LOCK_BET", seatId: PERSON });
    const snapshot = JSON.stringify(locked);

    // One per seat — two in all — is not enough, and the drive says so.
    expect(() => driveAiSeatsWithin(locked, AI_TEST_CONTEXT, 1)).toThrow(AiSeatDriverError);
    // Pure: the table it was handed is exactly as it was.
    expect(JSON.stringify(locked)).toBe(snapshot);
    // The production bound lets the same drive finish.
    expect(driveAiSeats(locked, AI_TEST_CONTEXT).actions).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Many hands
// ---------------------------------------------------------------------------

/** The person's side of a long session: deterministic, and covering every family. */
function personMove(state: EngineState, step: number, seatId: string): EngineCommand | null {
  const legal = getLegalActions(state, seatId);
  switch (state.phase) {
    case "BETTING_OPEN": {
      if (legal.canLockBet) return { type: "LOCK_BET", seatId };
      if (legal.canPlaceBet && legal.betBounds) {
        const amount = Math.min(legal.betBounds.min * (1 + (step % 5)), legal.betBounds.max);
        return { type: "PLACE_BET", seatId, amount };
      }
      return null;
    }
    case "INSURANCE_OFFER":
      if (legal.canTakeInsurance && step % 3 === 0) return { type: "INSURANCE", seatId };
      return legal.canDeclineInsurance ? { type: "DECLINE_INSURANCE", seatId } : null;
    case "PLAYER_TURNS": {
      const action = legal.actions[step % Math.max(1, legal.actions.length)];
      return action ? { type: action, seatId } : null;
    }
    case "HAND_COMPLETE":
      return { type: "NEXT_HAND", seatId };
    default:
      return null;
  }
}

describe("a long session", () => {
  it.each([7, 13, 101])(
    "always hands the table back waiting on the person, at rest, or over (seed %i)",
    (seed) => {
      const context: AiSeatContext = { random: new SeededTestRandomSource(seed * 3), now: AI_TEST_CONTEXT.now };
      let state = shuffledAiTable(seed);
      let hands = 0;
      let aiDecisions = 0;

      for (let step = 0; step < 2_000 && hands < 60; step += 1) {
        const command = personMove(state, step, PERSON);
        if (command === null) break; // the person cannot cover the minimum
        if (command.type === "NEXT_HAND") hands += 1;

        const before = state.version;
        const next = personSends(state, command, context);
        state = next.state;
        aiDecisions += next.aiActions.length;

        // One version per accepted command, the person's and each AI decision.
        expect(state.version).toBe(before + 1 + next.aiActions.length);
        // Nothing the computer players owe is left unanswered.
        expect(nextAiSeatAction(state)).toBeNull();
        // And only computer seats were ever decided for.
        for (const action of next.aiActions) expect(action.seatId).not.toBe(PERSON);

        const table = toPublicState(state);
        switch (state.phase) {
          case "BETTING_OPEN":
            expect(table.seats.find((seat) => seat.seatId === PERSON)?.betLocked).toBe(false);
            for (const seat of state.seats) if (seat.isAi === true) expect(seat.betLocked).toBe(false);
            break;
          case "INSURANCE_OFFER":
            expect(state.seats.find((seat) => seat.seatId === PERSON)?.insuranceDecision).toBe("PENDING");
            for (const seat of state.seats) {
              if (seat.isAi === true) expect(seat.insuranceDecision).not.toBe("PENDING");
            }
            break;
          case "PLAYER_TURNS":
            expect(table.activeSeatId).toBe(PERSON);
            break;
          case "HAND_COMPLETE":
            break;
          default:
            throw new Error(`the table was handed back in ${state.phase}`);
        }
        for (const seat of state.seats) {
          expect(Number.isInteger(seat.stack) && seat.stack >= 0).toBe(true);
        }
      }

      expect(hands).toBeGreaterThanOrEqual(40);
      expect(aiDecisions).toBeGreaterThan(hands * 4);
    },
  );

  it("is deterministic: the same table and the same command produce the same drive", () => {
    const state = engineOnly(
      engineOnly(shuffledAiTable(77), { type: "PLACE_BET", seatId: PERSON, amount: 60 }),
      { type: "LOCK_BET", seatId: PERSON },
    );
    const first = driveAiSeats(state, { ...AI_TEST_CONTEXT, random: new SeededTestRandomSource(1) });
    const second = driveAiSeats(state, { ...AI_TEST_CONTEXT, random: new SeededTestRandomSource(1) });
    expect(second).toEqual(first);
    expect(first.actions.length).toBeGreaterThanOrEqual(4);
  });
});
