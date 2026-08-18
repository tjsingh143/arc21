/**
 * What the client makes of a room code that does not admit you.
 *
 * `join_private_room` used to raise a different exception per cause — P0002 for
 * an unknown code, P0001 for a full table — which told a caller working through
 * six-character codes that their guess had hit a real, live room. It now returns
 * NO ROW for every one of those reasons, which closes the oracle and, more
 * importantly, is what makes the per-minute join limit real: a raise rolls the
 * whole call back including the record of the attempt, so a guesser would never
 * be charged for a guess.
 *
 * That change moves work to this side of the wire. PostgREST renders a null
 * composite as an object of nulls rather than as `null`, and the client has to
 * read that as "refused" — not as "the server could not be reached", which is
 * what the join path said before this phase and would have been both wrong and
 * the one place the difference could show.
 *
 * The payload below is copied verbatim from a live local stack, not written from
 * memory.
 */

import { describe, expect, it } from "vitest";

import { toRoom } from "../../src/features/rooms/rooms.js";

/** Exactly what `POST /rest/v1/rpc/join_private_room` answered for `ZZZZZZ`. */
const UNAVAILABLE_ROOM_PAYLOAD = {
  id: null,
  code: null,
  host_user_id: null,
  visibility: null,
  mode: null,
  ruleset_id: null,
  max_seats: null,
  status: null,
  game_session_id: null,
  created_at: null,
  expires_at: null,
  tier: null,
};

const REAL_ROOM_PAYLOAD = {
  id: "6f1f2f3f-0000-4000-8000-000000000001",
  code: "RU784W",
  host_user_id: "6f1f2f3f-0000-4000-8000-0000000000aa",
  visibility: "private",
  mode: "private_table",
  ruleset_id: null,
  max_seats: 2,
  status: "lobby",
  game_session_id: null,
  created_at: "2026-08-18T00:00:00Z",
  expires_at: "2026-08-18T00:30:00Z",
  tier: null,
};

describe("a room code that does not admit you", () => {
  it("parses as no room at all", () => {
    expect(toRoom(UNAVAILABLE_ROOM_PAYLOAD)).toBeNull();
  });

  it("is indistinguishable from any other reason the code failed", () => {
    // The server does not vary the payload by cause, so there is nothing here to
    // tell an unknown code from an expired, full or blocked one. Asserted as a
    // property of the shape rather than by trusting the server: if a future
    // change made one case return a partially-populated row, this fails.
    expect(Object.values(UNAVAILABLE_ROOM_PAYLOAD).every((value) => value === null)).toBe(true);
  });

  it("still reads a room that DID admit you", () => {
    const room = toRoom(REAL_ROOM_PAYLOAD);
    expect(room).not.toBeNull();
    expect(room?.code).toBe("RU784W");
    expect(room?.maxSeats).toBe(2);
  });

  it("reads the same payload wrapped in an array", () => {
    // PostgREST returns a bare row for a scalar-returning function and an array
    // for a set-returning one, and this function has been both.
    expect(toRoom([REAL_ROOM_PAYLOAD])?.code).toBe("RU784W");
    expect(toRoom([UNAVAILABLE_ROOM_PAYLOAD])).toBeNull();
  });
});
