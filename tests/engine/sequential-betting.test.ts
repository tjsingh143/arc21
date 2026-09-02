/**
 * Betting one seat at a time.
 *
 * THE DEFECT THIS FILE PINS, measured against the running stack before it was
 * written. The Sprint Tournament's defining mechanic is the specification's
 * *"Betting is sequential. Earlier committed tournament bets become visible.
 * This is intentional because bankroll-position strategy matters."* — and it did
 * not exist. Every tournament seat could stake at any moment during
 * BETTING_OPEN; a probe had the LAST seat in button order place and lock before
 * the first, and the server answered 200 to both. `activeSeatId` was null for
 * the whole betting round, so nothing named a first bettor at all and the one
 * shared seven-second clock covered all four players rather than giving each
 * their own. The project's own test plan recorded this area as "the data is
 * sent; no test yet reads one seat's staged bet from another's snapshot",
 * which is the visibility half — the ORDER half was simply absent.
 *
 * Everything here runs against the engine directly, over a fixed shoe. The
 * server half is proved in `tests/server/sprint-tournament.integration.test.ts`,
 * where a real four-player tournament refuses an out-of-turn bet with
 * NOT_YOUR_TURN.
 */

import { describe, expect, it } from "vitest";

import { harness, TEST_CONTEXT } from "../helpers/engine-harness.js";
import { getLegalActions, isBettingTurn } from "../../shared/blackjack/legal-actions.js";
import { applyCommand, type EngineState } from "../../shared/blackjack/reducer.js";
import { EngineError } from "../../shared/blackjack/types.js";

const SEATS = [
  { seatId: "s1", displayName: "One", stack: 10_000 },
  { seatId: "s2", displayName: "Two", stack: 10_000 },
  { seatId: "s3", displayName: "Three", stack: 10_000 },
  { seatId: "s4", displayName: "Four", stack: 10_000 },
];

/** A four-seat table with the tournament's own betting rules and clocks. */
function sprintTable(overrides: Partial<Parameters<typeof harness>[0]> = {}) {
  return harness({
    rules: { minBet: 100, maxBet: 2_000, sequentialBetting: true },
    seats: SEATS,
    // Enough cards that the fixture survives the safety reserve; the cards
    // themselves are irrelevant to betting order.
    shoe: "10S 9H 10D 8C 10C 7S 10H 6D 5C",
    ...overrides,
  });
}

const activeSeatId = (state: EngineState): string | null =>
  state.activeSeatIndex === null ? null : (state.seats[state.activeSeatIndex]?.seatId ?? null);

describe("sequential betting", () => {
  it("names the first bettor as soon as betting opens", () => {
    const table = sprintTable();
    expect(table.state.phase).toBe("BETTING_OPEN");
    // Seat order IS action order: the Sprint Tournament rotates this array to
    // move its button, so the first element is the seat on the button.
    expect(activeSeatId(table.state)).toBe("s1");
  });

  it("offers the bet controls to the current bettor and to nobody else", () => {
    const table = sprintTable();

    const first = getLegalActions(table.state, "s1");
    expect(first.canPlaceBet).toBe(true);
    expect(first.betBounds).toEqual({ min: 100, max: 2_000, increment: 10 });

    for (const seatId of ["s2", "s3", "s4"]) {
      const legal = getLegalActions(table.state, seatId);
      expect(legal.canPlaceBet).toBe(false);
      expect(legal.canLockBet).toBe(false);
      // Bounds go with the turn. A client holding bounds would draw a chip tray
      // for a player who cannot use it.
      expect(legal.betBounds).toBeNull();
    }
  });

  it("refuses a bet from a seat whose turn has not arrived", () => {
    const table = sprintTable();

    expect(() => table.send({ type: "PLACE_BET", seatId: "s3", amount: 500 })).toThrow(EngineError);
    try {
      table.send({ type: "PLACE_BET", seatId: "s3", amount: 500 });
    } catch (error) {
      expect((error as EngineError).code).toBe("NOT_YOUR_TURN");
    }
    try {
      table.send({ type: "LOCK_BET", seatId: "s4" });
    } catch (error) {
      expect((error as EngineError).code).toBe("NOT_YOUR_TURN");
    }
  });

  it("moves the turn one seat along each time a bet locks, and no further", () => {
    let table = sprintTable();
    const order: (string | null)[] = [activeSeatId(table.state)];

    for (const seatId of ["s1", "s2", "s3"]) {
      table = table
        .send({ type: "PLACE_BET", seatId, amount: 200 })
        .send({ type: "LOCK_BET", seatId });
      order.push(activeSeatId(table.state));
    }

    expect(order).toEqual(["s1", "s2", "s3", "s4"]);
    // Still betting: the fourth seat has not acted.
    expect(table.state.phase).toBe("BETTING_OPEN");
  });

  it("closes betting and clears the bettor once the last seat locks", () => {
    let table = sprintTable();
    for (const seatId of ["s1", "s2", "s3", "s4"]) {
      table = table
        .send({ type: "PLACE_BET", seatId, amount: 200 })
        .send({ type: "LOCK_BET", seatId });
    }
    // The cascade runs on past BETTING_OPEN; whichever phase it parks in, the
    // betting cursor must not still be pointing at a bettor.
    expect(table.state.phase).not.toBe("BETTING_OPEN");
    if (table.state.phase !== "PLAYER_TURNS") {
      expect(activeSeatId(table.state)).toBeNull();
    }
  });

  it("shows every committed bet to every seat while the round is still open", () => {
    /*
     * The whole point of betting in turn: the players after you can see what you
     * committed. `toPublicState` already carries `originalBet` and `betLocked`
     * for every seat, so this asserts the ENGINE keeps them, which is what the
     * sanitiser publishes.
     */
    const table = sprintTable()
      .send({ type: "PLACE_BET", seatId: "s1", amount: 900 })
      .send({ type: "LOCK_BET", seatId: "s1" });

    const first = table.state.seats.find((seat) => seat.seatId === "s1");
    expect(first?.originalBet).toBe(900);
    expect(first?.betLocked).toBe(true);
    expect(activeSeatId(table.state)).toBe("s2");
  });

  it("gives each bettor their own clock, restarted when the turn moves", () => {
    const first = sprintTable({
      rules: { minBet: 100, maxBet: 2_000, sequentialBetting: true },
      seats: SEATS,
      shoe: "10S 9H 10D 8C 10C 7S 10H 6D 5C",
    });
    // The harness supplies no `now`, so no deadline is set; drive the clock
    // explicitly to assert the RESTART rather than the value.
    const at = (iso: string, state: EngineState, seatId: string) =>
      applyCommand(state, { type: "LOCK_BET", seatId }, { ...TEST_CONTEXT, now: iso });

    let state = applyCommand(
      first.state,
      { type: "PLACE_BET", seatId: "s1", amount: 100 },
      TEST_CONTEXT,
    ).state;
    state = { ...state, timing: { betMillis: 7_000, actionMillis: 15_000 } };

    const locked = at("2026-09-02T10:00:00.000Z", state, "s1").state;
    expect(activeSeatId(locked)).toBe("s2");
    // Seven seconds from the moment the turn moved, not from when the round
    // opened: "7 seconds/person", not seven seconds between four people.
    expect(locked.actionDeadlineAt).toBe("2026-09-02T10:00:07.000Z");
  });

  it("times out the CURRENT bettor only, then moves on", () => {
    /*
     * With one shared clock a lapse stakes the minimum for everybody at once.
     * At a sequential table that would collapse the entire round the moment the
     * first player looked away, and the players after them would never see the
     * bets they are entitled to bet against.
     */
    const table = sprintTable();
    let state: EngineState = { ...table.state, timing: { betMillis: 7_000, actionMillis: 15_000 } };
    state = applyCommand(
      state,
      { type: "PLACE_BET", seatId: "s1", amount: 100 },
      { ...TEST_CONTEXT, now: "2026-09-02T10:00:00.000Z" },
    ).state;
    state = applyCommand(
      state,
      { type: "LOCK_BET", seatId: "s1" },
      { ...TEST_CONTEXT, now: "2026-09-02T10:00:00.000Z" },
    ).state;
    expect(activeSeatId(state)).toBe("s2");

    const resolved = applyCommand(
      state,
      { type: "RESOLVE_TIMEOUT", now: "2026-09-02T10:00:30.000Z" },
      { ...TEST_CONTEXT, now: "2026-09-02T10:00:30.000Z" },
    ).state;

    const second = resolved.seats.find((seat) => seat.seatId === "s2");
    const third = resolved.seats.find((seat) => seat.seatId === "s3");
    expect(second?.betLocked).toBe(true);
    expect(second?.originalBet).toBe(100); // the table minimum, as promised
    // Seat three was NOT staked by seat two's lapse.
    expect(third?.betLocked).toBe(false);
    expect(third?.originalBet).toBe(0);
    expect(activeSeatId(resolved)).toBe("s3");
  });

  it("sits out a seat that cannot cover the minimum instead of stalling on it", () => {
    /*
     * A broke seat has no turn to take. Left in the rotation it would hold the
     * table for a full betting clock every hand and the round could never close,
     * because closing requires every eligible seat to have locked.
     */
    const table = sprintTable().patch((state) => {
      const seats = state.seats.map((seat) =>
        seat.seatId === "s2" ? { ...seat, stack: 50 } : seat,
      );
      return { ...state, seats };
    });

    const advanced = table
      .send({ type: "PLACE_BET", seatId: "s1", amount: 100 })
      .send({ type: "LOCK_BET", seatId: "s1" });

    expect(advanced.seat("s2").sittingOut).toBe(true);
    expect(activeSeatId(advanced.state)).toBe("s3");
  });

  it("passes the turn on when the current bettor leaves", () => {
    const table = sprintTable().send({ type: "LEAVE", seatId: "s1" });
    expect(activeSeatId(table.state)).toBe("s2");
  });

  it("keeps a re-locked bet idempotent rather than answering NOT_YOUR_TURN", () => {
    // The turn has moved on by the time a retry arrives, and a replay of an
    // accepted lock must still be a no-op — the server replays commands byte for
    // byte and a second answer here would contradict the first.
    const table = sprintTable()
      .send({ type: "PLACE_BET", seatId: "s1", amount: 300 })
      .send({ type: "LOCK_BET", seatId: "s1" });
    expect(() => table.send({ type: "LOCK_BET", seatId: "s1" })).not.toThrow();
  });
});

describe("an ordinary table is unaffected", () => {
  /**
   * `sequentialBetting` is off everywhere except the Sprint Tournament, and the
   * point of these is that adding it changed nothing for the other five modes.
   */
  function ordinaryTable() {
    return harness({
      rules: { minBet: 100, maxBet: 2_000 },
      seats: SEATS,
      shoe: "10S 9H 10D 8C 10C 7S 10H 6D 5C",
    });
  }

  it("names no bettor and lets any seat bet in any order", () => {
    const table = ordinaryTable();
    expect(table.state.activeSeatIndex).toBeNull();
    for (const seatId of ["s1", "s2", "s3", "s4"]) {
      expect(getLegalActions(table.state, seatId).canPlaceBet).toBe(true);
      expect(isBettingTurn(table.state, seatId)).toBe(true);
    }
    const outOfOrder = table
      .send({ type: "PLACE_BET", seatId: "s4", amount: 500 })
      .send({ type: "LOCK_BET", seatId: "s4" });
    expect(outOfOrder.seat("s4").betLocked).toBe(true);
    expect(outOfOrder.state.phase).toBe("BETTING_OPEN");
  });

  it("still stakes the minimum for EVERY unlocked seat when the shared clock lapses", () => {
    let state: EngineState = {
      ...ordinaryTable().state,
      timing: { betMillis: 7_000, actionMillis: 15_000 },
    };
    state = applyCommand(
      state,
      { type: "PLACE_BET", seatId: "s1", amount: 400 },
      { ...TEST_CONTEXT, now: "2026-09-02T10:00:00.000Z" },
    ).state;
    state = { ...state, actionDeadlineAt: "2026-09-02T10:00:07.000Z" };

    const resolved = applyCommand(
      state,
      { type: "RESOLVE_TIMEOUT", now: "2026-09-02T10:00:30.000Z" },
      { ...TEST_CONTEXT, now: "2026-09-02T10:00:30.000Z" },
    ).state;

    for (const seat of resolved.seats) {
      expect(seat.betLocked).toBe(true);
    }
    expect(resolved.seats.find((seat) => seat.seatId === "s1")?.originalBet).toBe(400);
    expect(resolved.seats.find((seat) => seat.seatId === "s4")?.originalBet).toBe(100);
  });
});
