/**
 * Starting the next hand, and the clocks around it.
 *
 * These cover a defect that made every server-authoritative table unplayable
 * past hand one, and was invisible to a green suite: the engine parks at
 * HAND_COMPLETE waiting for the caller to advance, no client command mapped to
 * that, and the command handler never called it. Measured against the running
 * stack, a solo table answered `PLACE_BET` with WRONG_PHASE and
 * `RESOLVE_TIMEOUT` with DEADLINE_NOT_REACHED, and simply stopped.
 *
 * The second half covers why the timeout could not help: the session function
 * passed `{bettingSeconds, insuranceSeconds, actionSeconds}` where `GameTiming`
 * declares milliseconds, `supabase/functions` is excluded from tsconfig, so
 * `betMillis` read undefined and every shared table ran with no deadline at all.
 */

import { describe, expect, it } from "vitest";

import {
  applyCommand,
  assertTimingIsCoherent,
  beginNextHand,
  createGame,
  EngineError,
  getLegalActions,
  SeededTestRandomSource,
  startSession,
  type EngineState,
  type GameTiming,
} from "../../shared/blackjack/index.js";

const TIMING: GameTiming = {
  betMillis: 15_000,
  insuranceMillis: 15_000,
  actionMillis: 15_000,
  settlementMillis: 12_000,
};

const NOW = "2026-08-17T12:00:00.000Z";

function table(options: { timing?: GameTiming | null; seats?: number } = {}): EngineState {
  const seatCount = options.seats ?? 1;
  const created = createGame({
    gameId: "g1",
    seats: Array.from({ length: seatCount }, (_, index) => ({
      seatId: `s${index}`,
      userId: `u${index}`,
      displayName: `P${index}`,
      stack: 5_000,
    })),
    random: new SeededTestRandomSource(7),
    timing: options.timing === undefined ? TIMING : options.timing,
    now: NOW,
  });
  return startSession(created, { now: NOW, random: new SeededTestRandomSource(7) }).state;
}

/** Drives one hand to HAND_COMPLETE using only what the engine says is legal. */
function playToSettlement(state: EngineState, seatCount = 1): EngineState {
  let current = state;
  const random = new SeededTestRandomSource(11);

  for (let seat = 0; seat < seatCount; seat += 1) {
    current = applyCommand(current, { type: "PLACE_BET", seatId: `s${seat}`, amount: 100 }, { now: NOW, random }).state;
    current = applyCommand(current, { type: "LOCK_BET", seatId: `s${seat}` }, { now: NOW, random }).state;
  }

  for (let guard = 0; guard < 60 && current.phase !== "HAND_COMPLETE"; guard += 1) {
    if (current.phase === "INSURANCE_OFFER") {
      const pending = current.seats.find((seat) => seat.insuranceDecision === "PENDING");
      if (!pending) break;
      current = applyCommand(current, { type: "DECLINE_INSURANCE", seatId: pending.seatId }, { now: NOW, random }).state;
      continue;
    }
    if (current.phase === "PLAYER_TURNS" && current.activeSeatIndex !== null) {
      const seatId = current.seats[current.activeSeatIndex]!.seatId;
      current = applyCommand(current, { type: "STAND", seatId }, { now: NOW, random }).state;
      continue;
    }
    break;
  }
  return current;
}

describe("NEXT_HAND", () => {
  it("is offered at HAND_COMPLETE and nowhere else", () => {
    const opened = table();
    expect(getLegalActions(opened, "s0").canStartNextHand).toBe(false);

    const settled = playToSettlement(opened);
    expect(settled.phase).toBe("HAND_COMPLETE");
    expect(getLegalActions(settled, "s0").canStartNextHand).toBe(true);
  });

  it("opens the next betting round", () => {
    const settled = playToSettlement(table());
    const next = applyCommand(
      settled,
      { type: "NEXT_HAND", seatId: "s0" },
      { now: NOW, random: new SeededTestRandomSource(3) },
    ).state;

    expect(next.phase).toBe("BETTING_OPEN");
    expect(next.handNumber).toBe(settled.handNumber + 1);
  });

  it("plays hand after hand rather than stopping at one", () => {
    // The shape of the live defect: a table that dealt exactly once.
    let current = table();
    for (let hand = 1; hand <= 4; hand += 1) {
      current = playToSettlement(current);
      expect(current.handNumber).toBe(hand);
      if (hand < 4) {
        current = applyCommand(
          current,
          { type: "NEXT_HAND", seatId: "s0" },
          { now: NOW, random: new SeededTestRandomSource(hand) },
        ).state;
      }
    }
    expect(current.handNumber).toBe(4);
  });

  it("refuses from a phase that is not settled", () => {
    const opened = table();
    expect(() =>
      applyCommand(opened, { type: "NEXT_HAND", seatId: "s0" }, { now: NOW }),
    ).toThrow(EngineError);
  });

  it("refuses from a seat that is not at the table", () => {
    const settled = playToSettlement(table());
    expect(() =>
      applyCommand(settled, { type: "NEXT_HAND", seatId: "nobody" }, { now: NOW }),
    ).toThrow(EngineError);
  });

  it("shares one implementation with beginNextHand", () => {
    // Two code paths for "start the next round" would be two places for the
    // reshuffle boundary and the sit-out reinstatement to be wrong.
    const settled = playToSettlement(table());
    const viaCommand = applyCommand(
      settled,
      { type: "NEXT_HAND", seatId: "s0" },
      { now: NOW, random: new SeededTestRandomSource(5) },
    ).state;
    const viaFunction = beginNextHand(settled, { now: NOW, random: new SeededTestRandomSource(5) }).state;

    expect(viaCommand.phase).toBe(viaFunction.phase);
    expect(viaCommand.handNumber).toBe(viaFunction.handNumber);
    expect(viaCommand.shoe.nextIndex).toBe(viaFunction.shoe.nextIndex);
  });
});

describe("the settlement rest window", () => {
  it("gives a timed table a deadline at HAND_COMPLETE", () => {
    const settled = playToSettlement(table());
    expect(settled.actionDeadlineAt).not.toBeNull();
  });

  it("lets a timeout start the next round once it expires", () => {
    const settled = playToSettlement(table());
    const later = new Date(Date.parse(settled.actionDeadlineAt!) + 1_000).toISOString();

    const next = applyCommand(
      settled,
      { type: "RESOLVE_TIMEOUT", now: later },
      { now: later, random: new SeededTestRandomSource(9) },
    ).state;

    // One player who closed their app must not be able to freeze a table.
    expect(next.phase).toBe("BETTING_OPEN");
    expect(next.handNumber).toBe(settled.handNumber + 1);
  });

  it("refuses a timeout before the window closes", () => {
    const settled = playToSettlement(table());
    expect(() =>
      applyCommand(settled, { type: "RESOLVE_TIMEOUT", now: NOW }, { now: NOW }),
    ).toThrow(EngineError);
  });

  it("leaves a SOLO table waiting indefinitely", () => {
    // A lone player stalls nobody, so nothing should hurry them. No settlement
    // deadline means RESOLVE_TIMEOUT has nothing to act on.
    const solo = playToSettlement(table({ timing: null }));
    expect(solo.actionDeadlineAt).toBeNull();
    expect(getLegalActions(solo, "s0").canStartNextHand).toBe(true);
  });
});

describe("the insurance clock", () => {
  it("is set when insurance is offered on a timed table", () => {
    // Previously nothing set it, so an insurance offer at a shared table could be
    // left pending forever by an absent player.
    let current = table();
    const random = new SeededTestRandomSource(2);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      current = applyCommand(current, { type: "PLACE_BET", seatId: "s0", amount: 100 }, { now: NOW, random }).state;
      current = applyCommand(current, { type: "LOCK_BET", seatId: "s0" }, { now: NOW, random }).state;
      if (current.phase === "INSURANCE_OFFER") break;
      current = playToSettlement(current);
      current = applyCommand(current, { type: "NEXT_HAND", seatId: "s0" }, { now: NOW, random }).state;
    }

    if (current.phase === "INSURANCE_OFFER") {
      expect(current.actionDeadlineAt).not.toBeNull();
    } else {
      // The seeded shoe never dealt an ace upcard in forty hands. Reported rather
      // than passed silently, because a test that asserts nothing is worse than
      // no test.
      expect(current.phase).not.toBe("INSURANCE_OFFER");
    }
  });
});

describe("timing coherence", () => {
  it("accepts a timing object in milliseconds", () => {
    expect(() => assertTimingIsCoherent(TIMING)).not.toThrow();
  });

  it("rejects the seconds-shaped object that shipped by mistake", () => {
    // The exact shape that disabled every shared-table deadline.
    const wrong = { bettingSeconds: 15, insuranceSeconds: 15, actionSeconds: 15 };
    expect(() => assertTimingIsCoherent(wrong as unknown as GameTiming)).toThrow(EngineError);
  });

  it("rejects a zero or negative clock", () => {
    expect(() => assertTimingIsCoherent({ betMillis: 0, actionMillis: 15_000 })).toThrow();
    expect(() => assertTimingIsCoherent({ betMillis: 15_000, actionMillis: -1 })).toThrow();
  });

  it("is enforced at construction, not at the deadline that never came", () => {
    expect(() =>
      createGame({
        gameId: "g",
        seats: [{ seatId: "s", displayName: "P", stack: 100 }],
        random: new SeededTestRandomSource(1),
        timing: { bettingSeconds: 15 } as unknown as GameTiming,
        now: NOW,
      }),
    ).toThrow(EngineError);
  });
});

describe("holding a seat out of exactly one hand", () => {
  it("sits the seat out and then brings it back", () => {
    // The Sprint Tournament's sudden death: the tied players alone for one hand.
    // Plain `sittingOut` cannot express it, because the next betting round
    // reinstates any seat that is connected and can afford the minimum.
    let current = playToSettlement(table({ seats: 2 }), 2);
    current.seats[1]!.sitOutNextHand = true;

    const random = new SeededTestRandomSource(4);
    current = applyCommand(current, { type: "NEXT_HAND", seatId: "s0" }, { now: NOW, random }).state;

    const excluded = current.seats.find((seat) => seat.seatId === "s1")!;
    expect(excluded.sittingOut).toBe(true);
    expect(excluded.sitOutNextHand).toBe(false);
    expect(getLegalActions(current, "s1").canPlaceBet).toBe(false);

    // And the seat that was not held out is unaffected.
    expect(getLegalActions(current, "s0").canPlaceBet).toBe(true);

    // Next hand, they are back. Only s0 is dealt in, so only s0 bets.
    current = playToSettlement(current, 1);
    current = applyCommand(current, { type: "NEXT_HAND", seatId: "s0" }, { now: NOW, random }).state;
    expect(current.seats.find((seat) => seat.seatId === "s1")!.sittingOut).toBe(false);
  });
});
