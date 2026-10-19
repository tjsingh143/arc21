/**
 * The engine and the AI seat flag (Astra Refresh C).
 *
 * `SeatState.isAi` marks a computer-controlled participant at an AI Table. The
 * engine CARRIES it — into the persisted state and out through `toPublicState`
 * — and must never READ it: there is one set of blackjack rules, and a rule
 * that treated a computer seat differently would be a second one.
 *
 * The strongest form of that claim is behavioural, so the last section plays
 * the same command sequence on two tables that differ ONLY in which seats are
 * flagged, over many hands of real shuffles, and requires every state and every
 * event to be identical once the flag itself is set aside.
 */

import { describe, expect, it } from "vitest";

import {
  applyCommand,
  createGame,
  EngineError,
  getLegalActions,
  SeededTestRandomSource,
  startSession,
  toPublicState,
  type EngineCommand,
  type EngineEvent,
  type EngineState,
  type SeatSeed,
} from "../../shared/blackjack/index.js";

const RULES_STACK = 5_000;

function table(seats: SeatSeed[], seed: number): EngineState {
  const created = createGame({
    gameId: "ai-engine",
    seats,
    random: new SeededTestRandomSource(seed),
  });
  return startSession(created, { random: new SeededTestRandomSource(seed + 1) }).state;
}

describe("carrying the flag", () => {
  it("marks a computer seat and leaves a person's seat exactly as it was", () => {
    const state = table(
      [
        { seatId: "a", displayName: "AI Player 1", stack: RULES_STACK, isAi: true },
        { seatId: "p", userId: "user-1", displayName: "Person", stack: RULES_STACK },
      ],
      1,
    );
    expect(state.seats[0]?.isAi).toBe(true);
    // ABSENT, not false: a person's persisted seat has the shape it always had.
    expect("isAi" in (state.seats[1] ?? {})).toBe(false);
  });

  it("survives the JSON round trip the server's jsonb column puts it through", () => {
    const state = table([{ seatId: "a", displayName: "AI Player 1", stack: 100, isAi: true }], 2);
    const restored = JSON.parse(JSON.stringify(state)) as EngineState;
    expect(restored.seats[0]?.isAi).toBe(true);
  });

  it("refuses a computer seat that belongs to an account", () => {
    // A computer player with a user id would be counted as a person by every
    // per-account path the server has. The database refuses it too.
    expect(() =>
      createGame({
        gameId: "masquerade",
        seats: [{ seatId: "a", userId: "user-1", displayName: "AI", stack: 100, isAi: true }],
        random: new SeededTestRandomSource(3),
      }),
    ).toThrow(EngineError);
  });
});

describe("projecting the flag", () => {
  it("tells the client which seats are computer players — and only those", () => {
    const state = table(
      [
        { seatId: "a", displayName: "AI Player 1", stack: RULES_STACK, isAi: true },
        { seatId: "p", userId: "user-1", displayName: "Person", stack: RULES_STACK },
      ],
      4,
    );
    const seats = toPublicState(state).seats;
    expect(seats[0]?.isAi).toBe(true);
    expect("isAi" in (seats[1] ?? {})).toBe(false);
  });

  it("leaves a table with no computer players byte-for-byte as it was", () => {
    // The wire contract is strict, so a key older clients do not know would make
    // them refuse EVERY table. Emitted only where it is true, it cannot.
    const state = table([{ seatId: "p", userId: "u", displayName: "Person", stack: 500 }], 5);
    expect(JSON.stringify(toPublicState(state))).not.toContain("isAi");
  });
});

// ---------------------------------------------------------------------------
// The engine is blind to the flag
// ---------------------------------------------------------------------------

/**
 * A scripted table, deliberately NOT the AI policy — the point is to compare two
 * tables under identical commands, and a script that consulted the flag would
 * prove nothing. It walks every decision family: bets, insurance taken and
 * declined, and every legal play in turn, by a rotation over the legal set.
 */
function nextScriptedCommand(state: EngineState, step: number): EngineCommand | null {
  switch (state.phase) {
    case "BETTING_OPEN": {
      for (const seat of state.seats) {
        const legal = getLegalActions(state, seat.seatId);
        if (legal.canLockBet) return { type: "LOCK_BET", seatId: seat.seatId };
        if (legal.canPlaceBet && legal.betBounds) {
          const amount = legal.betBounds.min * (1 + (step % 3));
          return {
            type: "PLACE_BET",
            seatId: seat.seatId,
            amount: Math.min(amount, legal.betBounds.max),
          };
        }
      }
      return null;
    }
    case "INSURANCE_OFFER": {
      for (const seat of state.seats) {
        const legal = getLegalActions(state, seat.seatId);
        if (legal.canTakeInsurance && step % 2 === 0) return { type: "INSURANCE", seatId: seat.seatId };
        if (legal.canDeclineInsurance) return { type: "DECLINE_INSURANCE", seatId: seat.seatId };
      }
      return null;
    }
    case "PLAYER_TURNS": {
      const seat = state.activeSeatIndex === null ? undefined : state.seats[state.activeSeatIndex];
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

function stripFlag(state: EngineState): EngineState {
  return {
    ...state,
    seats: state.seats.map((seat) => {
      const { isAi: _flag, ...rest } = seat;
      void _flag;
      return rest;
    }),
  };
}

describe("the reducer never reads the flag", () => {
  const seats: SeatSeed[] = [
    { seatId: "s1", displayName: "One", stack: RULES_STACK },
    { seatId: "s2", displayName: "Two", stack: RULES_STACK },
    { seatId: "s3", displayName: "Three", stack: RULES_STACK },
  ];

  it.each([11, 23, 37, 41, 59])(
    "deals, plays and settles identically with and without computer seats (seed %i)",
    (seed) => {
      const flagged = seats.map((seat, index) => (index === 1 ? seat : { ...seat, isAi: true }));
      let plain = table(seats, seed);
      let marked = table(flagged, seed);
      const plainEvents: EngineEvent[] = [];
      const markedEvents: EngineEvent[] = [];
      const context = { random: new SeededTestRandomSource(seed * 7) };
      const markedContext = { random: new SeededTestRandomSource(seed * 7) };

      let handsSeen = 0;
      for (let step = 0; step < 600 && handsSeen < 25; step += 1) {
        const command = nextScriptedCommand(plain, step);
        if (command === null) break;
        if (command.type === "NEXT_HAND") handsSeen += 1;
        const a = applyCommand(plain, command, context);
        const b = applyCommand(marked, command, markedContext);
        plain = a.state;
        marked = b.state;
        plainEvents.push(...a.events);
        markedEvents.push(...b.events);
        expect(stripFlag(marked)).toEqual(plain);
      }

      expect(handsSeen).toBeGreaterThanOrEqual(10);
      expect(markedEvents).toEqual(plainEvents);
      // And the flag itself rode through every one of those hands untouched.
      expect(marked.seats.map((seat) => seat.isAi === true)).toEqual([true, false, true]);
    },
  );
});
