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
  type RoomState,
  type RoomsGateway,
} from "../../src/features/rooms/index.js";

const UNUSED = { ok: false, reason: "unreachable", message: "not used in this test" } as const;

/**
 * Every method refuses unless the test says otherwise.
 *
 * One base rather than a fresh literal per suite: a gateway is a contract with
 * eight methods now, and a fake spelled out by hand goes stale the moment a
 * ninth arrives — which is how a store test ends up proving something about an
 * interface the app no longer has.
 */
function fakeGateway(overrides: Partial<RoomsGateway> = {}): RoomsGateway {
  return {
    kind: "fake",
    create: async () => UNUSED,
    join: async () => UNUSED,
    read: async () => UNUSED,
    findOpenRoom: async () => UNUSED,
    setReady: async () => UNUSED,
    removeMember: async () => UNUSED,
    start: async () => UNUSED,
    findSeat: async () => UNUSED,
    leave: async () => UNUSED,
    ...overrides,
  };
}

function gateway(response: RoomOutcome): RoomsGateway & { joinCalls: string[] } {
  const joinCalls: string[] = [];
  return {
    ...fakeGateway({
      create: async () => response,
      join: async (code) => {
        joinCalls.push(code);
        return response;
      },
    }),
    joinCalls,
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
      ...fakeGateway({
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
        findSeat: async (id) => {
          findSeatCalls.push(id);
          return seat.ok ? { ok: true, seatId: seat.seatId } : UNUSED;
        },
      }),
      findSeatCalls,
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

/**
 * Reconnecting to a table you are already at.
 *
 * "Loading/reconnect must preserve room code" is the specification's line for
 * this screen, and it was not true: the store started idle every time the lobby
 * mounted. For a HOST that was not merely a lost code, it was a dead end —
 * `create_private_room` refuses a second live room, so the screen offered
 * "Open a table", the server answered "you already have a table open", and the
 * player's only way out was to wait thirty minutes for the room to expire.
 */
describe("restoring the table this player is already at", () => {
  const ROOM_ID = "55555555-5555-4555-8555-555555555555";

  function roomState(): RoomState {
    return {
      room: {
        id: ROOM_ID,
        code: "QRSTUV",
        hostUserId: "22222222-2222-4222-8222-222222222222",
        maxSeats: 4,
        status: "lobby",
        gameSessionId: null,
      },
      members: [],
    };
  }

  it("puts the player back in their open room, code and all", async () => {
    setRoomsGateway(
      fakeGateway({
        findOpenRoom: async () => ({ ok: true, room: roomState().room }),
        read: async () => ({ ok: true, state: roomState() }),
      }),
    );

    await useRoomsStore.getState().restore();

    const status = useRoomsStore.getState().status;
    expect(status.kind).toBe("seated");
    expect(status.kind === "seated" ? status.state.room.code : null).toBe("QRSTUV");
  });

  it("leaves the create/join screen alone when there is no room to restore", async () => {
    const reads: string[] = [];
    setRoomsGateway(
      fakeGateway({
        findOpenRoom: async () => ({ ok: true, room: null }),
        read: async (id) => {
          reads.push(id);
          return UNUSED;
        },
      }),
    );

    await useRoomsStore.getState().restore();

    expect(useRoomsStore.getState().status.kind).toBe("idle");
    expect(reads).toHaveLength(0);
  });

  it("says nothing when the lookup fails — it runs unasked, on mount", async () => {
    setRoomsGateway(
      fakeGateway({
        findOpenRoom: async () => ({ ok: false, reason: "unreachable", message: "offline" }),
      }),
    );

    await useRoomsStore.getState().restore();

    expect(useRoomsStore.getState().status.kind).toBe("idle");
    // An error about a lookup the player never made is worse than no answer.
    expect(useRoomsStore.getState().notice).toBeNull();
  });

  it("does not overwrite a room already in hand", async () => {
    const lookups: number[] = [];
    useRoomsStore.setState({ status: { kind: "seated", state: roomState() } });
    setRoomsGateway(
      fakeGateway({
        findOpenRoom: async () => {
          lookups.push(1);
          return { ok: true, room: null };
        },
      }),
    );

    await useRoomsStore.getState().restore();

    expect(lookups).toHaveLength(0);
  });
});

/**
 * Ready states, and the host's power to remove somebody.
 *
 * Both round-trip through the server rather than being patched locally: every
 * other client renders the row the database holds, and a local flag that
 * disagreed with it would be the one thing on this screen that was not the
 * server's answer.
 */
describe("the lobby's two remaining controls", () => {
  const ROOM_ID = "66666666-6666-4666-8666-666666666666";
  const HOST = "22222222-2222-4222-8222-222222222222";
  const GUEST = "77777777-7777-4777-8777-777777777777";

  function state(guestReady: boolean): RoomState {
    return {
      room: {
        id: ROOM_ID,
        code: "WXYZ23",
        hostUserId: HOST,
        maxSeats: 4,
        status: "lobby",
        gameSessionId: null,
      },
      members: [
        {
          userId: HOST,
          username: "host",
          displayName: "Host",
          seatIndex: 0,
          isReady: true,
          isHost: true,
        },
        {
          userId: GUEST,
          username: "guest",
          displayName: "Guest",
          seatIndex: 1,
          isReady: guestReady,
          isHost: false,
        },
      ],
    };
  }

  beforeEach(() => {
    useRoomsStore.setState({ status: { kind: "seated", state: state(false) } });
  });

  it("sends the ready flag and renders the server's answer, not the request", async () => {
    const sent: boolean[] = [];
    setRoomsGateway(
      fakeGateway({
        setReady: async (_room, ready) => {
          sent.push(ready);
          return { ok: true };
        },
        read: async () => ({ ok: true, state: state(true) }),
      }),
    );

    await useRoomsStore.getState().setReady(true);

    expect(sent).toEqual([true]);
    const status = useRoomsStore.getState().status;
    const guest =
      status.kind === "seated"
        ? status.state.members.find((member) => member.userId === GUEST)
        : undefined;
    expect(guest?.isReady).toBe(true);
  });

  it("drops to the entry screen when readiness is refused — that is the removal arriving", async () => {
    setRoomsGateway(
      fakeGateway({
        setReady: async () => ({
          ok: false,
          reason: "refused",
          message: "You are no longer at that table.",
        }),
      }),
    );

    await useRoomsStore.getState().setReady(true);

    expect(useRoomsStore.getState().status.kind).toBe("idle");
    expect(useRoomsStore.getState().notice).toMatch(/no longer at that table/i);
  });

  it("removes a member and re-reads the room", async () => {
    const removed: string[] = [];
    setRoomsGateway(
      fakeGateway({
        removeMember: async (_room, userId) => {
          removed.push(userId);
          return { ok: true, removed: true };
        },
        read: async () => ({
          ok: true,
          state: { ...state(false), members: [state(false).members[0]!] },
        }),
      }),
    );

    await useRoomsStore.getState().removeMember(GUEST);

    expect(removed).toEqual([GUEST]);
    const status = useRoomsStore.getState().status;
    expect(status.kind === "seated" ? status.state.members.map((m) => m.userId) : []).toEqual([
      HOST,
    ]);
    expect(useRoomsStore.getState().notice).toBeNull();
  });

  it("explains a refusal the server will not explain", async () => {
    setRoomsGateway(
      fakeGateway({
        // `remove_room_member` returns false for every refusal it declines to
        // distinguish: not the host, the table has started, no such room.
        removeMember: async () => ({ ok: true, removed: false }),
        read: async () => ({ ok: true, state: state(false) }),
      }),
    );

    await useRoomsStore.getState().removeMember(GUEST);

    expect(useRoomsStore.getState().notice).toMatch(/could not be removed/i);
    // Still seated, and still showing both players: nothing happened.
    const status = useRoomsStore.getState().status;
    expect(status.kind === "seated" ? status.state.members.length : 0).toBe(2);
  });
});
