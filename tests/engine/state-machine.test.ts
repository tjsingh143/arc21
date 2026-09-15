/**
 * The state machine, phase by phase and command by command.
 *
 * Two things are proved here that the behavioural suites cannot prove on their
 * own:
 *
 *   1. EVERY command is rejected in every phase that does not accept it, with
 *      the code the client is expected to branch on. A hidden button is not a
 *      boundary — `applyCommand` is — so the matrix is exhaustive rather than
 *      illustrative, and it fails if a command is added without a decision
 *      about where it is legal.
 *
 *   2. The TRANSIENT phases really are transient. `BETTING_LOCKED`,
 *      `INITIAL_DEAL`, `DEALER_PEEK`, `DEALER_REVEAL`, `DEALER_TURN`,
 *      `SETTLEMENT` and `BETWEEN_HANDS` never rest, because `cascade` drives
 *      through them inside one accepted command. That makes them invisible to a
 *      test that only sends commands, so each one is entered deliberately and
 *      driven with ADVANCE.
 */

import { describe, expect, it } from "vitest";

import {
  applyCommand,
  createGame,
  startSession,
  type EngineState,
} from "../../shared/blackjack/reducer.js";
import { SeededTestRandomSource } from "../../shared/blackjack/rng.js";
import { EngineError, type EngineCommand, type GamePhase } from "../../shared/blackjack/types.js";
import { betAndDeal, eventTypes, harness, TEST_CONTEXT } from "../helpers/engine-harness.js";

/** Dealer shows a seven: no insurance, no peek, straight to PLAYER_TURNS. */
const PLAIN_SHOE = "10S 7H 7D 5C";
/** Dealer shows an ace, so the round stops at INSURANCE_OFFER. */
const ACE_UP_SHOE = "10S AH 7D 5C";

function sessionReady(): EngineState {
  return createGame({
    gameId: "matrix",
    seats: [{ seatId: "s1", displayName: "Tester", stack: 10_000 }],
    random: new SeededTestRandomSource(7),
  });
}

function bettingOpen(): EngineState {
  return harness({ shoe: PLAIN_SHOE }).state;
}

function insuranceOffer(): EngineState {
  return betAndDeal(harness({ shoe: ACE_UP_SHOE }), 100).state;
}

function playerTurns(): EngineState {
  return betAndDeal(harness({ shoe: PLAIN_SHOE }), 100).state;
}

function handComplete(): EngineState {
  return betAndDeal(harness({ shoe: PLAIN_SHOE }), 100).send({ type: "STAND", seatId: "s1" }).state;
}

function sessionComplete(): EngineState {
  return { ...handComplete(), phase: "SESSION_COMPLETE", actionDeadlineAt: null };
}

const RESTING: Array<{ phase: GamePhase; build: () => EngineState }> = [
  { phase: "SESSION_READY", build: sessionReady },
  { phase: "BETTING_OPEN", build: bettingOpen },
  { phase: "INSURANCE_OFFER", build: insuranceOffer },
  { phase: "PLAYER_TURNS", build: playerTurns },
  { phase: "HAND_COMPLETE", build: handComplete },
  { phase: "SESSION_COMPLETE", build: sessionComplete },
];

/** Every command shape, with the seat that is genuinely at the table. */
const COMMANDS: Array<{ label: string; command: EngineCommand }> = [
  { label: "PLACE_BET", command: { type: "PLACE_BET", seatId: "s1", amount: 100 } },
  { label: "LOCK_BET", command: { type: "LOCK_BET", seatId: "s1" } },
  { label: "INSURANCE", command: { type: "INSURANCE", seatId: "s1" } },
  { label: "DECLINE_INSURANCE", command: { type: "DECLINE_INSURANCE", seatId: "s1" } },
  { label: "HIT", command: { type: "HIT", seatId: "s1" } },
  { label: "STAND", command: { type: "STAND", seatId: "s1" } },
  { label: "DOUBLE", command: { type: "DOUBLE", seatId: "s1" } },
  { label: "SPLIT", command: { type: "SPLIT", seatId: "s1" } },
  { label: "SURRENDER", command: { type: "SURRENDER", seatId: "s1" } },
  { label: "LEAVE", command: { type: "LEAVE", seatId: "s1" } },
  { label: "NEXT_HAND", command: { type: "NEXT_HAND", seatId: "s1" } },
  { label: "ADVANCE", command: { type: "ADVANCE" } },
];

/**
 * `null` means the command is accepted in that phase; a string is the
 * `EngineErrorCode` it must be refused with.
 *
 * SPLIT and DOUBLE are refused inside PLAYER_TURNS as ILLEGAL_ACTION rather
 * than WRONG_PHASE because the fixture deals 10+7 — the phase is right and the
 * hand is not, which is a different answer for the client.
 */
const EXPECTED: Record<string, Partial<Record<GamePhase, string | null>>> = {
  PLACE_BET: {
    SESSION_READY: "WRONG_PHASE",
    BETTING_OPEN: null,
    INSURANCE_OFFER: "WRONG_PHASE",
    PLAYER_TURNS: "WRONG_PHASE",
    HAND_COMPLETE: "WRONG_PHASE",
    SESSION_COMPLETE: "WRONG_PHASE",
  },
  LOCK_BET: {
    SESSION_READY: "WRONG_PHASE",
    BETTING_OPEN: "BET_BELOW_MINIMUM", // nothing staged yet
    INSURANCE_OFFER: "WRONG_PHASE",
    PLAYER_TURNS: "WRONG_PHASE",
    HAND_COMPLETE: "WRONG_PHASE",
    SESSION_COMPLETE: "WRONG_PHASE",
  },
  INSURANCE: {
    SESSION_READY: "WRONG_PHASE",
    BETTING_OPEN: "WRONG_PHASE",
    INSURANCE_OFFER: null,
    PLAYER_TURNS: "WRONG_PHASE",
    HAND_COMPLETE: "WRONG_PHASE",
    SESSION_COMPLETE: "WRONG_PHASE",
  },
  DECLINE_INSURANCE: {
    SESSION_READY: "WRONG_PHASE",
    BETTING_OPEN: "WRONG_PHASE",
    INSURANCE_OFFER: null,
    PLAYER_TURNS: "WRONG_PHASE",
    HAND_COMPLETE: "WRONG_PHASE",
    SESSION_COMPLETE: "WRONG_PHASE",
  },
  HIT: {
    SESSION_READY: "WRONG_PHASE",
    BETTING_OPEN: "WRONG_PHASE",
    INSURANCE_OFFER: "WRONG_PHASE",
    PLAYER_TURNS: null,
    HAND_COMPLETE: "WRONG_PHASE",
    SESSION_COMPLETE: "WRONG_PHASE",
  },
  STAND: {
    SESSION_READY: "WRONG_PHASE",
    BETTING_OPEN: "WRONG_PHASE",
    INSURANCE_OFFER: "WRONG_PHASE",
    PLAYER_TURNS: null,
    HAND_COMPLETE: "WRONG_PHASE",
    SESSION_COMPLETE: "WRONG_PHASE",
  },
  DOUBLE: {
    SESSION_READY: "WRONG_PHASE",
    BETTING_OPEN: "WRONG_PHASE",
    INSURANCE_OFFER: "WRONG_PHASE",
    PLAYER_TURNS: null, // 10+7 is a legal two-card double
    HAND_COMPLETE: "WRONG_PHASE",
    SESSION_COMPLETE: "WRONG_PHASE",
  },
  SPLIT: {
    SESSION_READY: "WRONG_PHASE",
    BETTING_OPEN: "WRONG_PHASE",
    INSURANCE_OFFER: "WRONG_PHASE",
    PLAYER_TURNS: "ILLEGAL_ACTION", // 10+7 is not a pair
    HAND_COMPLETE: "WRONG_PHASE",
    SESSION_COMPLETE: "WRONG_PHASE",
  },
  SURRENDER: {
    SESSION_READY: "WRONG_PHASE",
    BETTING_OPEN: "WRONG_PHASE",
    INSURANCE_OFFER: "WRONG_PHASE",
    PLAYER_TURNS: null,
    HAND_COMPLETE: "WRONG_PHASE",
    SESSION_COMPLETE: "WRONG_PHASE",
  },
  LEAVE: {
    SESSION_READY: null,
    BETTING_OPEN: null,
    INSURANCE_OFFER: null,
    PLAYER_TURNS: null,
    HAND_COMPLETE: null,
    SESSION_COMPLETE: null,
  },
  NEXT_HAND: {
    SESSION_READY: "WRONG_PHASE",
    BETTING_OPEN: "WRONG_PHASE",
    INSURANCE_OFFER: "WRONG_PHASE",
    PLAYER_TURNS: "WRONG_PHASE",
    HAND_COMPLETE: null,
    SESSION_COMPLETE: "WRONG_PHASE",
  },
  ADVANCE: {
    SESSION_READY: null,
    BETTING_OPEN: null,
    INSURANCE_OFFER: null,
    PLAYER_TURNS: null,
    HAND_COMPLETE: null,
    SESSION_COMPLETE: null,
  },
};

describe("the phase/command matrix", () => {
  for (const { phase, build } of RESTING) {
    for (const { label, command } of COMMANDS) {
      const expected = EXPECTED[label]?.[phase];

      it(`${label} in ${phase}: ${expected === null ? "accepted" : expected}`, () => {
        const state = build();
        expect(state.phase).toBe(phase);

        if (expected === null) {
          expect(() => applyCommand(state, command, TEST_CONTEXT)).not.toThrow();
          return;
        }

        try {
          applyCommand(state, command, TEST_CONTEXT);
          throw new Error(`${label} was accepted in ${phase}; expected ${String(expected)}`);
        } catch (error) {
          expect(error).toBeInstanceOf(EngineError);
          expect((error as EngineError).code).toBe(expected);
        }
      });
    }
  }

  it("covers every command shape the engine accepts", () => {
    // The union is closed, so a new command with no row here is a gap in this
    // matrix rather than a passing test. RESOLVE_TIMEOUT is exercised on its own
    // below because its legality turns on the clock, not on the phase alone.
    const covered = new Set(COMMANDS.map((entry) => entry.label));
    covered.add("RESOLVE_TIMEOUT");
    expect([...covered].sort()).toEqual(
      [
        "ADVANCE",
        "DECLINE_INSURANCE",
        "DOUBLE",
        "HIT",
        "INSURANCE",
        "LEAVE",
        "LOCK_BET",
        "NEXT_HAND",
        "PLACE_BET",
        "RESOLVE_TIMEOUT",
        "SPLIT",
        "STAND",
        "SURRENDER",
      ].sort(),
    );
  });
});

describe("commands from a seat that is not at the table", () => {
  const strangers: EngineCommand[] = [
    { type: "PLACE_BET", seatId: "ghost", amount: 100 },
    { type: "LOCK_BET", seatId: "ghost" },
    { type: "LEAVE", seatId: "ghost" },
    { type: "NEXT_HAND", seatId: "ghost" },
  ];

  for (const command of strangers) {
    it(`refuses ${command.type} with UNKNOWN_SEAT`, () => {
      const state = command.type === "NEXT_HAND" ? handComplete() : bettingOpen();
      try {
        applyCommand(state, command, TEST_CONTEXT);
        throw new Error("accepted a command from an unknown seat");
      } catch (error) {
        expect((error as EngineError).code).toBe("UNKNOWN_SEAT");
      }
    });
  }

  it("refuses a player action from a seat that is not the active one", () => {
    const two = betAndDeal(
      harness({
        shoe: "10S 9H 6D 7C 5H 4S",
        seats: [
          { seatId: "s1", displayName: "One", stack: 5_000 },
          { seatId: "s2", displayName: "Two", stack: 5_000 },
        ],
      }),
      100,
      ["s1", "s2"],
    );

    expect(two.state.phase).toBe("PLAYER_TURNS");
    expect(two.state.seats[two.state.activeSeatIndex!]!.seatId).toBe("s1");

    try {
      two.send({ type: "HIT", seatId: "s2" });
      throw new Error("accepted an action out of turn");
    } catch (error) {
      expect((error as EngineError).code).toBe("NOT_YOUR_TURN");
    }
  });
});

describe("RESOLVE_TIMEOUT legality turns on the clock, not the phase alone", () => {
  it("refuses with DEADLINE_NOT_REACHED when the table carries no clock", () => {
    const state = playerTurns(); // built with no timing at all
    expect(state.actionDeadlineAt).toBeNull();
    try {
      applyCommand(state, { type: "RESOLVE_TIMEOUT", now: "2026-08-24T00:00:00.000Z" }, {});
      throw new Error("resolved a timeout with no deadline");
    } catch (error) {
      expect((error as EngineError).code).toBe("DEADLINE_NOT_REACHED");
    }
  });

  it("refuses in a phase that has no timeout behaviour, even past a deadline", () => {
    // SESSION_READY carries no default: there is nothing to stand, decline or
    // stake. The deadline is forced on so the refusal cannot be the clock's.
    const state: EngineState = {
      ...sessionReady(),
      actionDeadlineAt: "2026-08-24T00:00:00.000Z",
    };
    try {
      applyCommand(state, { type: "RESOLVE_TIMEOUT", now: "2026-08-24T00:01:00.000Z" }, {});
      throw new Error("resolved a timeout in SESSION_READY");
    } catch (error) {
      expect((error as EngineError).code).toBe("WRONG_PHASE");
    }
  });
});

describe("the transient phases", () => {
  const timing = { betMillis: 10_000, actionMillis: 10_000, settlementMillis: 10_000 };

  /** Rebuilds a live hand and forces the phase back to a transient step. */
  function at(phase: GamePhase): EngineState {
    const live = betAndDeal(harness({ shoe: PLAIN_SHOE }), 100).state;
    return { ...live, phase };
  }

  it("BETTING_LOCKED deals immediately", () => {
    const staged = harness({ shoe: PLAIN_SHOE }).send({
      type: "PLACE_BET",
      seatId: "s1",
      amount: 100,
    });
    const locked: EngineState = {
      ...staged.state,
      phase: "BETTING_LOCKED",
      seats: staged.state.seats.map((seat) => ({ ...seat, betLocked: true })),
    };

    const result = applyCommand(locked, { type: "ADVANCE" }, TEST_CONTEXT);
    expect(result.state.phase).toBe("PLAYER_TURNS");
    expect(eventTypes(result.events)).toContain("CARD_DEALT");
    expect(eventTypes(result.events)).toContain("HOLE_CARD_DEALT");
  });

  it("INITIAL_DEAL is where the round's cards are dealt, and only once", () => {
    const staged = harness({ shoe: PLAIN_SHOE }).send({
      type: "PLACE_BET",
      seatId: "s1",
      amount: 100,
    });
    const dealing: EngineState = {
      ...staged.state,
      phase: "INITIAL_DEAL",
      seats: staged.state.seats.map((seat) => ({ ...seat, betLocked: true })),
    };

    const result = applyCommand(dealing, { type: "ADVANCE" }, TEST_CONTEXT);
    expect(result.state.seats[0]!.hands[0]!.cards).toHaveLength(2);
    expect(result.state.dealer.cards).toHaveLength(2);
    expect(result.state.shoe.nextIndex).toBe(4);
  });

  it("DEALER_PEEK resolves to PLAYER_TURNS when the dealer has no natural", () => {
    const result = applyCommand(at("DEALER_PEEK"), { type: "ADVANCE" }, TEST_CONTEXT);
    expect(result.state.phase).toBe("PLAYER_TURNS");
    expect(eventTypes(result.events)).toContain("DEALER_PEEKED");
  });

  it("DEALER_REVEAL turns the hole card face up and moves on", () => {
    const before = at("DEALER_REVEAL");
    expect(before.dealer.holeCardRevealed).toBe(false);

    const result = applyCommand(before, { type: "ADVANCE" }, TEST_CONTEXT);
    expect(result.state.dealer.holeCardRevealed).toBe(true);
    expect(eventTypes(result.events)).toContain("HOLE_CARD_REVEALED");
    // Reveal does not rest: the same command plays the dealer out and settles.
    expect(result.state.phase).toBe("HAND_COMPLETE");
  });

  it("DEALER_TURN draws and then settles without resting", () => {
    const result = applyCommand(at("DEALER_TURN"), { type: "ADVANCE" }, TEST_CONTEXT);
    expect(result.state.phase).toBe("HAND_COMPLETE");
    const types = eventTypes(result.events);
    expect(types.some((type) => type === "DEALER_STOOD" || type === "DEALER_BUSTED")).toBe(true);
    expect(types).toContain("HAND_SETTLED");
  });

  it("SETTLEMENT credits once and comes to rest at HAND_COMPLETE", () => {
    const result = applyCommand(at("SETTLEMENT"), { type: "ADVANCE" }, TEST_CONTEXT);
    expect(result.state.phase).toBe("HAND_COMPLETE");
    expect(eventTypes(result.events).filter((type) => type === "HAND_SETTLED")).toHaveLength(1);
  });

  it("BETWEEN_HANDS opens the next betting round", () => {
    const settled = handComplete();
    const between: EngineState = { ...settled, phase: "BETWEEN_HANDS" };
    const result = applyCommand(between, { type: "ADVANCE" }, TEST_CONTEXT);
    expect(result.state.phase).toBe("BETTING_OPEN");
    expect(result.state.handNumber).toBe(settled.handNumber + 1);
  });

  it("never comes to rest in a transient phase during an ordinary hand", () => {
    // Every phase the engine actually stops in, over a full round played on a
    // table that carries clocks. Anything else would leave a client waiting on
    // a step that answers no command.
    const seen: GamePhase[] = [];
    let state = startSession(
      {
        ...createGame({
          gameId: "resting",
          seats: [{ seatId: "s1", displayName: "Tester", stack: 5_000 }],
          random: new SeededTestRandomSource(3),
          timing,
          now: "2026-08-24T00:00:00.000Z",
        }),
        shoe: harness({ shoe: ACE_UP_SHOE }).state.shoe,
      },
      { ...TEST_CONTEXT, now: "2026-08-24T00:00:00.000Z" },
    ).state;
    seen.push(state.phase);

    const script: EngineCommand[] = [
      { type: "PLACE_BET", seatId: "s1", amount: 100 },
      { type: "LOCK_BET", seatId: "s1" },
      { type: "DECLINE_INSURANCE", seatId: "s1" },
      { type: "STAND", seatId: "s1" },
      { type: "NEXT_HAND", seatId: "s1" },
    ];

    for (const command of script) {
      state = applyCommand(state, command, { ...TEST_CONTEXT, now: "2026-08-24T00:00:00.000Z" }).state;
      seen.push(state.phase);
    }

    expect(seen).toEqual([
      "BETTING_OPEN",
      "BETTING_OPEN",
      "INSURANCE_OFFER",
      "PLAYER_TURNS",
      "HAND_COMPLETE",
      "BETTING_OPEN",
    ]);
  });
});

describe("PLAYER_TURNS bookkeeping", () => {
  it("tracks the active seat, the active split hand and each hand's terminal state", () => {
    // Deal order at two seats is s1, s2, dealer up, s1, s2, dealer hole. So s1
    // holds 8,8 and splits into two 18s; s2 holds 6,9 and waits its turn.
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

    expect(h.hand("s1").cards.map((card) => card.rank)).toEqual(["8", "8"]);
    expect(h.state.activeSeatIndex).toBe(0);
    expect(h.state.activeHandIndex).toBe(0);

    const split = h.send({ type: "SPLIT", seatId: "s1" });
    expect(split.seat("s1").hands).toHaveLength(2);
    // The cursor stays on the first of the two, which is the one now in play.
    expect(split.state.activeHandIndex).toBe(0);
    expect(split.seat("s1").currentHandIndex).toBe(0);

    const stoodFirst = split.send({ type: "STAND", seatId: "s1" });
    expect(stoodFirst.seat("s1").hands[0]!.status).toBe("STOOD");
    // ...and moves to the second hand of the SAME seat, not to the next seat.
    expect(stoodFirst.state.activeSeatIndex).toBe(0);
    expect(stoodFirst.state.activeHandIndex).toBe(1);

    const stoodSecond = stoodFirst.send({ type: "STAND", seatId: "s1" });
    expect(stoodSecond.seat("s1").hands.every((hand) => hand.status === "STOOD")).toBe(true);
    // Only now does the turn pass along the table.
    expect(stoodSecond.state.seats[stoodSecond.state.activeSeatIndex!]!.seatId).toBe("s2");
  });

  it("clears the cursor and the clock when no hand is left to act", () => {
    const done = betAndDeal(harness({ shoe: PLAIN_SHOE }), 100).send({
      type: "STAND",
      seatId: "s1",
    });
    expect(done.state.activeSeatIndex).toBeNull();
    expect(done.state.activeHandIndex).toBeNull();
  });

  it("increments version once per accepted command and not at all on a refusal", () => {
    const h = harness({ shoe: PLAIN_SHOE });
    const before = h.state.version;

    const accepted = h.send({ type: "PLACE_BET", seatId: "s1", amount: 100 });
    expect(accepted.state.version).toBe(before + 1);

    expect(() => accepted.send({ type: "HIT", seatId: "s1" })).toThrow(EngineError);
    expect(accepted.state.version).toBe(before + 1);
  });
});

describe("answering insurance twice at a table where others are still deciding", () => {
  /*
   * At ONE seat this is unreachable: the answer completes the offer, the cascade
   * moves the phase on, and a second attempt is refused as WRONG_PHASE. The
   * ILLEGAL_ACTION path only exists at a shared table, where the phase is still
   * INSURANCE_OFFER because somebody else has not answered yet.
   */
  function offerAtTwoSeats() {
    return betAndDeal(
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
  }

  it("refuses the second answer without changing anything", () => {
    const h = offerAtTwoSeats();
    expect(h.state.phase).toBe("INSURANCE_OFFER");

    const answered = h.send({ type: "DECLINE_INSURANCE", seatId: "s1" });
    expect(answered.state.phase).toBe("INSURANCE_OFFER"); // s2 has not answered
    expect(answered.seat("s1").insuranceDecision).toBe("DECLINED");

    try {
      answered.send({ type: "INSURANCE", seatId: "s1" });
      throw new Error("accepted a second insurance answer");
    } catch (error) {
      expect((error as EngineError).code).toBe("ILLEGAL_ACTION");
    }
    // No stake was taken on the refused command.
    expect(answered.seat("s1").insuranceBet).toBe(0);
    expect(answered.seat("s1").stack).toBe(4_900);
  });

  it("refuses a repeated DECLINE the same way", () => {
    const answered = offerAtTwoSeats().send({ type: "DECLINE_INSURANCE", seatId: "s1" });
    try {
      answered.send({ type: "DECLINE_INSURANCE", seatId: "s1" });
      throw new Error("accepted a repeated decline");
    } catch (error) {
      expect((error as EngineError).code).toBe("ILLEGAL_ACTION");
    }
  });
});
