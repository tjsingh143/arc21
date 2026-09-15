/**
 * The reconnectable active-game identifier.
 *
 * THE DEFECT, reproduced against the running stack before any of this existed:
 *
 *   OPEN                200 {"gameId":"b3bcfb9b-…","seatId":"41745c30-…","wallet":23000}
 *   (the app is killed; both ids lived only in a route parameter)
 *   OPEN again          409 {"code":"SESSION_ALREADY_ACTIVE"}
 *   wallets?balance         [{"balance":23000}]   ← 2,000 stranded, permanently
 *
 * Nothing anywhere asked the server which table the player was at, and all three
 * client stores answered that refusal with "leave that table first" — advice
 * that names the id the player has lost. This suite covers the reading of that
 * answer and the CONTROL that decides whether the way back is offered, because
 * a test that calls `resumeTargetFor` proves `resumeTargetFor` works and proves
 * nothing about whether anybody can reach it.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  ACTIVE_SESSION_MODES,
  ACTIVE_SESSION_ROUTE,
  canResume,
  describeActiveSession,
  resolveTableSeat,
  describeActiveSessionMode,
  parseActiveSession,
  parseActiveSessionRows,
  resumeTargetFor,
  selectActiveSession,
  setActiveSessionGateway,
  useActiveSessionStore,
  type ActiveSession,
  type ActiveSessionGateway,
  type ActiveSessionOutcome,
} from "../../src/features/table/index.js";
import { ALL_SESSION_MODES } from "../../supabase/functions/_shared/session-economics.js";

const GAME = "b3bcfb9b-8199-452b-b808-c5ce4d8b74c5";
const SEAT = "41745c30-26b5-40fe-8e81-406a448c5a3c";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    game_session_id: GAME,
    seat_id: SEAT,
    mode: "solo",
    tier: "casual",
    started_at: "2026-08-30T05:39:20.795112+00:00",
    ...overrides,
  };
}

function session(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    gameId: GAME,
    seatId: SEAT,
    mode: "solo",
    tier: "casual",
    startedAt: new Date("2026-08-30T05:39:20.795Z"),
    ...overrides,
  };
}

describe("reading the server's answer", () => {
  it("parses a live seat", () => {
    expect(parseActiveSession(row())).toEqual({
      gameId: GAME,
      seatId: SEAT,
      mode: "solo",
      tier: "casual",
      startedAt: new Date("2026-08-30T05:39:20.795Z"),
    });
  });

  it("takes the first row of a result set", () => {
    expect(parseActiveSessionRows([row()])?.gameId).toBe(GAME);
  });

  it("reports no live seat for an empty result", () => {
    expect(parseActiveSessionRows([])).toBeNull();
  });

  it.each([
    ["a missing game id", { game_session_id: undefined }],
    ["a game id that is not a uuid", { game_session_id: "not-a-uuid" }],
    ["a missing seat id", { seat_id: undefined }],
    ["a seat id that is not a uuid", { seat_id: "1234" }],
    ["a mode outside the enum", { mode: "roulette" }],
    ["a numeric mode", { mode: 3 }],
  ])("drops a row with %s rather than repairing it", (_label, overrides) => {
    // A repaired id routes the player to a screen that cannot load, which reads
    // as a broken app rather than as the bad row it is.
    expect(parseActiveSession(row(overrides))).toBeNull();
  });

  it("keeps the address when only the timestamp is unreadable", () => {
    const parsed = parseActiveSession(row({ started_at: "yesterday" }));
    expect(parsed?.gameId).toBe(GAME);
    expect(parsed?.startedAt).toBeNull();
  });

  it("treats an absent tier as a closed economy rather than a broken row", () => {
    expect(parseActiveSession(row({ mode: "career", tier: null })))
      .toMatchObject({ mode: "career", tier: null });
  });

  it.each([null, undefined, 7, "solo", []])("rejects %p", (value) => {
    expect(parseActiveSession(value)).toBeNull();
  });
});

describe("the mode vocabulary", () => {
  /*
   * The same lesson as `status-taxonomy.test.ts`: a mode added to the database
   * enum and not to this list would parse as a bad row and strand the player it
   * was added for.
   */
  it("covers every mode the session enum can hold", () => {
    expect([...ACTIVE_SESSION_MODES].sort()).toEqual([...ALL_SESSION_MODES].sort());
  });

  it("names every one of them", () => {
    for (const mode of ACTIVE_SESSION_MODES) {
      expect(describeActiveSessionMode(mode).length).toBeGreaterThan(0);
    }
  });
});

describe("what the player is told", () => {
  it("says the buy-in is at the table for a wallet-backed mode", () => {
    expect(describeActiveSession(session({ mode: "solo" }))).toContain("buy-in is there");
    expect(describeActiveSession(session({ mode: "public_table" }))).toContain("buy-in is there");
  });

  it("claims nothing about a wallet for a closed economy", () => {
    // A private table, a tournament and a career node are closed economies:
    // their chips never came from a wallet and never return to one.
    for (const mode of ["private_table", "tournament", "daily_challenge", "career"] as const) {
      expect(describeActiveSession(session({ mode }))).not.toContain("buy-in");
    }
  });

  it("never names a chip figure it has not read", () => {
    // The stack at a table is the server's number and this layer has not asked
    // for it. The same rule `describeRecoveryGrant` follows.
    for (const mode of ACTIVE_SESSION_MODES) {
      expect(describeActiveSession(session({ mode }))).not.toMatch(/\d/);
    }
  });
});

describe("the route back", () => {
  it("addresses the one screen every mode enters play through", () => {
    expect(resumeTargetFor(session())).toEqual({
      pathname: ACTIVE_SESSION_ROUTE,
      params: { gameId: GAME, seatId: SEAT },
    });
  });

  it("carries the seat id as well as the game id", () => {
    // The table screen needs both; sending only the game id was how the guest
    // path at a private table stranded everyone but the host.
    expect(resumeTargetFor(session()).params.seatId).toBe(SEAT);
  });
});

describe("the control that decides whether the way back is offered", () => {
  it("is offered when the server named a seat", () => {
    expect(canResume(session())).toBe(true);
  });

  it("is not offered when there is none", () => {
    expect(canResume(null)).toBe(false);
  });

  it("is not offered while the question could not be asked", () => {
    // "You are not at a table" and "we could not find out" are different
    // statements. Offering a resume on the second would be a button leading
    // nowhere; the screen shows nothing instead.
    expect(selectActiveSession({ kind: "unavailable", reason: "unreachable" })).toBeNull();
    expect(selectActiveSession({ kind: "loading" })).toBeNull();
    expect(selectActiveSession({ kind: "idle" })).toBeNull();
  });

  it("is not offered for a genuinely empty answer", () => {
    expect(selectActiveSession({ kind: "ready", session: null })).toBeNull();
  });
});

describe("the store", () => {
  function gateway(outcome: ActiveSessionOutcome): ActiveSessionGateway {
    return { kind: "fake", fetch: async () => outcome };
  }

  function throwingGateway(): ActiveSessionGateway {
    return {
      kind: "fake",
      fetch: async () => {
        throw new Error("no network");
      },
    };
  }

  beforeEach(() => {
    setActiveSessionGateway(null);
    useActiveSessionStore.getState().clear();
  });

  it("holds the seat the server named", async () => {
    setActiveSessionGateway(gateway({ ok: true, session: session() }));
    const found = await useActiveSessionStore.getState().refresh();
    expect(found?.gameId).toBe(GAME);
    expect(selectActiveSession(useActiveSessionStore.getState().status)?.seatId).toBe(SEAT);
  });

  it("distinguishes no seat from no answer", async () => {
    setActiveSessionGateway(gateway({ ok: true, session: null }));
    await useActiveSessionStore.getState().refresh();
    expect(useActiveSessionStore.getState().status).toEqual({ kind: "ready", session: null });

    setActiveSessionGateway(gateway({ ok: false, reason: "unreachable" }));
    await useActiveSessionStore.getState().refresh();
    expect(useActiveSessionStore.getState().status).toEqual({
      kind: "unavailable",
      reason: "unreachable",
    });
  });

  it("survives a gateway that throws", async () => {
    setActiveSessionGateway(throwingGateway());
    await expect(useActiveSessionStore.getState().refresh()).resolves.toBeNull();
    expect(useActiveSessionStore.getState().status).toEqual({
      kind: "unavailable",
      reason: "unreachable",
    });
  });

  it("drops the cached seat on clear, so no table outlives a session", async () => {
    setActiveSessionGateway(gateway({ ok: true, session: session() }));
    await useActiveSessionStore.getState().refresh();
    useActiveSessionStore.getState().clear();
    expect(selectActiveSession(useActiveSessionStore.getState().status)).toBeNull();
  });
});

/**
 * THE ONE ROUTE THAT CANNOT CARRY A SEAT ID.
 *
 * `/table/[gameId]` needs both ids, and every in-app route supplies both —
 * except the `your_turn` notification. `notifications.data` may hold only a
 * fixed set of short scalars by CHECK constraint (so a seed, a shoe or a hole
 * card cannot ride out through a push), `notifyTurnPlayedByTimeout` writes
 * `game_id` alone, and `destinationFor` maps the kind to `/table/<gameId>`.
 *
 * So the one message written specifically to bring an absent player back —
 * *"A hand was played for you. You are still seated at a table."* — opened a
 * screen answering *"This screen needs a table to open. Start or join one from
 * Social."* Both sentences were true of their own half and they contradict each
 * other, which is the shape this project keeps finding: a mechanism complete on
 * one side of a boundary and absent on the other.
 */
describe("resolving the seat when the route did not name one", () => {
  it("uses the route's own seat id whenever there is one", () => {
    expect(
      resolveTableSeat({ gameId: GAME, paramSeatId: SEAT, checked: false, session: null }),
    ).toEqual({ kind: "known", seatId: SEAT });
  });

  it("falls back to the server's answer for THIS game", () => {
    expect(
      resolveTableSeat({
        gameId: GAME,
        paramSeatId: null,
        checked: true,
        session: session(),
      }),
    ).toEqual({ kind: "known", seatId: SEAT });
  });

  /**
   * `checked` is the same rule as `mayOpenDealtTable`'s, one screen along: the
   * store behind this lookup is a module-level cache the Play screen also
   * fills, so a `ready` reading can arrive already carried over. Announcing
   * "you have no table" before this mount's own ask has answered is the dead
   * end, one beat earlier.
   */
  it("says it is still checking rather than refusing early", () => {
    expect(
      resolveTableSeat({ gameId: GAME, paramSeatId: null, checked: false, session: null }),
    ).toEqual({ kind: "checking" });
  });

  it("refuses once the server has answered with nothing", () => {
    expect(
      resolveTableSeat({ gameId: GAME, paramSeatId: null, checked: true, session: null }),
    ).toEqual({ kind: "unknown" });
  });

  it("never borrows a seat from a DIFFERENT table", () => {
    // One live seat per player is an invariant, not a guarantee. A session
    // naming another game is an answer about another game.
    const elsewhere = session({ gameId: "99999999-9999-4999-8999-999999999999" });
    expect(
      resolveTableSeat({ gameId: GAME, paramSeatId: null, checked: true, session: elsewhere }),
    ).toEqual({ kind: "unknown" });
    // And while unchecked it is still "checking", not a borrowed seat.
    expect(
      resolveTableSeat({ gameId: GAME, paramSeatId: null, checked: false, session: elsewhere }),
    ).toEqual({ kind: "checking" });
  });

  it("cannot resolve anything without a game either", () => {
    expect(
      resolveTableSeat({ gameId: null, paramSeatId: null, checked: true, session: session() }),
    ).toEqual({ kind: "unknown" });
  });
});
