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
