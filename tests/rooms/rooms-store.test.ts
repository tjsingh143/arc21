/**
 * The private-table lobby's typed-code path.
 *
 * `app/room/[code].tsx` already refuses a malformed DEEP LINK without a
 * request — this proves the same discipline holds for the code a player TYPES
 * into `app/table/lobby.tsx`. A malformed code is a client-side fact, and
 * spending a network round trip (and, with rate limiting live since phase 14
 * session 2, a slice of the ten-per-minute join budget) to learn what
 * `looksLikeRoomCode` already knows would be a wasted request at best.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  setRoomsGateway,
  useRoomsStore,
  type RoomOutcome,
  type RoomsGateway,
} from "../../src/features/rooms/index.js";

function gateway(response: RoomOutcome): RoomsGateway & { joinCalls: string[] } {
  const joinCalls: string[] = [];
  return {
    kind: "fake",
    joinCalls,
    create: async () => response,
    join: async (code) => {
      joinCalls.push(code);
      return response;
    },
    read: async () => ({ ok: false, reason: "unreachable", message: "not used in this test" }),
    start: async () => ({ ok: false, reason: "unreachable", message: "not used in this test" }),
    findSeat: async () => ({ ok: false, reason: "unreachable", message: "not used in this test" }),
    leave: async () => ({ ok: false, reason: "unreachable", message: "not used in this test" }),
  };
}

beforeEach(() => {
  setRoomsGateway(null);
  useRoomsStore.setState({ status: { kind: "idle" }, dealt: null, codeInput: "", notice: null });
});

describe("joining with a typed code", () => {
  it("refuses a malformed code locally and sends no request", async () => {
    const spy = gateway({
      ok: false,
      reason: "refused",
      message: "should never be reached",
    });
    setRoomsGateway(spy);

    useRoomsStore.getState().setCodeInput("AB"); // too short
    await useRoomsStore.getState().joinRoom();

    expect(spy.joinCalls).toHaveLength(0);
    expect(useRoomsStore.getState().notice).toMatch(/six letters and numbers/i);
  });

  it("refuses a code containing an excluded character (O/0/I/1) locally", async () => {
    const spy = gateway({ ok: false, reason: "refused", message: "should never be reached" });
    setRoomsGateway(spy);

    // Six characters, but 'O' and '0' are never issued — see ROOM_CODE_PATTERN.
    useRoomsStore.getState().setCodeInput("ABCDO0");
    await useRoomsStore.getState().joinRoom();

    expect(spy.joinCalls).toHaveLength(0);
  });

  it("sends exactly one request for a well-formed code", async () => {
    const spy = gateway({
      ok: true,
      room: {
        id: "11111111-1111-4111-8111-111111111111",
        code: "ABCDEF",
        hostUserId: "22222222-2222-4222-8222-222222222222",
        maxSeats: 3,
        status: "lobby",
        gameSessionId: null,
      },
    });
    setRoomsGateway(spy);

    useRoomsStore.getState().setCodeInput("abcdef"); // typed lower-case, as a player would
    await useRoomsStore.getState().joinRoom();

    expect(spy.joinCalls).toEqual(["ABCDEF"]);
  });
});

/**
 * A private table needs TWO people to reach it, and for a long time only one
 * could.
 *
 * `startTable` sets `dealt` for whoever pressed Deal, and the lobby navigates
 * on `dealt` — so a guest polled every three seconds, watched the room's
 * `gameSessionId` appear, and stayed in the lobby while the host played. Found
 * across two simulators in phase 14 s4, where the host reached the table and
 * the second player never did.
 */
describe("following the host into a dealt table", () => {
  const ROOM_ID = "11111111-1111-4111-8111-111111111111";
  const SESSION_ID = "33333333-3333-4333-8333-333333333333";
  const SEAT_ID = "44444444-4444-4444-8444-444444444444";

  function seatedGateway(
    gameSessionId: string | null,
    seat: { ok: true; seatId: string | null } | { ok: false },
  ): RoomsGateway & { findSeatCalls: string[] } {
    const findSeatCalls: string[] = [];
    return {
      kind: "fake",
      findSeatCalls,
      create: async () => ({ ok: false, reason: "unreachable", message: "unused" }),
      join: async () => ({ ok: false, reason: "unreachable", message: "unused" }),
      read: async () => ({
        ok: true,
        state: {
          room: {
            id: ROOM_ID,
            code: "ABCDEF",
            hostUserId: "22222222-2222-4222-8222-222222222222",
            maxSeats: 3,
            status: gameSessionId === null ? "lobby" : "active",
            gameSessionId,
          },
          members: [],
        },
      }),
      start: async () => ({ ok: false, reason: "unreachable", message: "unused" }),
      findSeat: async (id) => {
        findSeatCalls.push(id);
        return seat.ok
          ? { ok: true, seatId: seat.seatId }
          : { ok: false, reason: "unreachable", message: "unused" };
      },
      leave: async () => ({ ok: false, reason: "unreachable", message: "unused" }),
    };
  }

  it("resolves a seat and navigates once the room points at a game", async () => {
    const spy = seatedGateway(SESSION_ID, { ok: true, seatId: SEAT_ID });
    setRoomsGateway(spy);

    await useRoomsStore.getState().refresh(ROOM_ID);

    expect(spy.findSeatCalls).toEqual([SESSION_ID]);
    expect(useRoomsStore.getState().dealt).toEqual({ gameId: SESSION_ID, seatId: SEAT_ID });
  });

  it("asks for no seat while the room is still a lobby", async () => {
    const spy = seatedGateway(null, { ok: true, seatId: SEAT_ID });
    setRoomsGateway(spy);

    await useRoomsStore.getState().refresh(ROOM_ID);

    expect(spy.findSeatCalls).toHaveLength(0);
    expect(useRoomsStore.getState().dealt).toBeNull();
  });

  it("stays put when the seat is not there yet, and retries on the next poll", async () => {
    // What a race between this poll and the host's deal looks like: the room
    // names a session, the seat row is not visible yet. It must not navigate
    // to a seat it does not have, and must not give up either.
    const spy = seatedGateway(SESSION_ID, { ok: true, seatId: null });
    setRoomsGateway(spy);

    await useRoomsStore.getState().refresh(ROOM_ID);
    expect(useRoomsStore.getState().dealt).toBeNull();

    await useRoomsStore.getState().refresh(ROOM_ID);
    expect(spy.findSeatCalls).toEqual([SESSION_ID, SESSION_ID]);
  });

  it("does not re-resolve a seat it already has", async () => {
    const spy = seatedGateway(SESSION_ID, { ok: true, seatId: SEAT_ID });
    setRoomsGateway(spy);

    await useRoomsStore.getState().refresh(ROOM_ID);
    await useRoomsStore.getState().refresh(ROOM_ID);

    // One lookup, not one per three-second poll for as long as the table runs.
    expect(spy.findSeatCalls).toEqual([SESSION_ID]);
  });
});
