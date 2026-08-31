/**
 * What the private lobby OFFERS, as opposed to what its actions do.
 *
 * "Test the CONTROL, not only the function behind it" is in CLAUDE.md because
 * three defects in this project survived a test of the function a dead control
 * would have called — `lockBet` was written, unit-tested and correct, and wired
 * to a button no online table could ever enable.
 *
 * `remove_room_member` arrived in exactly that state: shipped with six pgTAP
 * assertions and no client caller at all. These are the predicates the lobby
 * renders from, and the one that matters most is the one that must stay FALSE:
 * a host must not be offered a Remove button against a table that has started,
 * because the seats hold chips by then and the server owns the game.
 */

import { describe, expect, it } from "vitest";

import {
  canRemoveMember,
  canSetReady,
  canStartTable,
  describeInviteUnavailable,
  describeReadiness,
  inviteAffordance,
  isHost,
  isReady,
  mayOpenDealtTable,
  shareMessage,
  type RoomState,
} from "../../src/features/rooms/index.js";

const HOST = "11111111-1111-4111-8111-111111111111";
const GUEST = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";
const STRANGER = "44444444-4444-4444-8444-444444444444";
const SESSION = "55555555-5555-4555-8555-555555555555";

function room(
  overrides: Partial<RoomState["room"]> = {},
  members: Array<{ userId: string; ready?: boolean }> = [
    { userId: HOST, ready: true },
    { userId: GUEST },
  ],
): RoomState {
  return {
    room: {
      id: "99999999-9999-4999-8999-999999999999",
      code: "ABCDEF",
      hostUserId: HOST,
      maxSeats: 5,
      status: "lobby",
      gameSessionId: null,
      ...overrides,
    },
    members: members.map((member, index) => ({
      userId: member.userId,
      username: `p${index}`,
      displayName: `Player ${index}`,
      seatIndex: index,
      isReady: member.ready ?? false,
      isHost: member.userId === (overrides.hostUserId ?? HOST),
    })),
  };
}

describe("who may deal", () => {
  it("offers the deal to the host once a second player is there", () => {
    expect(canStartTable(room(), HOST)).toBe(true);
  });

  it("never offers it to a guest", () => {
    expect(canStartTable(room(), GUEST)).toBe(false);
  });

  it("does not offer it to a host sitting alone", () => {
    expect(canStartTable(room({}, [{ userId: HOST }]), HOST)).toBe(false);
  });

  it("does not offer it once the table is already playing", () => {
    expect(canStartTable(room({ status: "active", gameSessionId: SESSION }), HOST)).toBe(false);
  });

  it("is NOT gated on readiness — the start rule is two human players", () => {
    // Nobody ready, including the host. The specification's minimum start is
    // "2 human players"; ready states inform the host, they do not block them.
    const nobodyReady = room({}, [{ userId: HOST }, { userId: GUEST }]);
    expect(nobodyReady.members.every((member) => !member.isReady)).toBe(true);
    expect(canStartTable(nobodyReady, HOST)).toBe(true);
  });
});

describe("who may remove whom", () => {
  it("offers the host a Remove against another member", () => {
    expect(canRemoveMember(room(), HOST, GUEST)).toBe(true);
  });

  it("never against themselves — leaving is `leave_room`, which migrates the host", () => {
    expect(canRemoveMember(room(), HOST, HOST)).toBe(false);
  });

  it("never to a guest, against anybody", () => {
    const three = room({}, [{ userId: HOST }, { userId: GUEST }, { userId: THIRD }]);
    expect(canRemoveMember(three, GUEST, THIRD)).toBe(false);
    expect(canRemoveMember(three, GUEST, HOST)).toBe(false);
  });

  it("NOT once the table has started — the seats hold chips and the server owns the game", () => {
    expect(canRemoveMember(room({ status: "active" }), HOST, GUEST)).toBe(false);
    expect(canRemoveMember(room({ gameSessionId: SESSION }), HOST, GUEST)).toBe(false);
  });

  it("not against somebody who is not at the table", () => {
    expect(canRemoveMember(room(), HOST, STRANGER)).toBe(false);
  });

  it("not to a signed-out viewer", () => {
    expect(canRemoveMember(room(), null, GUEST)).toBe(false);
    expect(isHost(room(), null)).toBe(false);
  });
});

describe("readiness", () => {
  it("reports this player's own flag", () => {
    const state = room({}, [{ userId: HOST, ready: true }, { userId: GUEST }]);
    expect(isReady(state, HOST)).toBe(true);
    expect(isReady(state, GUEST)).toBe(false);
    expect(isReady(state, STRANGER)).toBe(false);
    expect(isReady(state, null)).toBe(false);
  });

  it("offers the toggle to a member of a lobby and to nobody else", () => {
    expect(canSetReady(room(), GUEST)).toBe(true);
    expect(canSetReady(room(), STRANGER)).toBe(false);
    // Once the table is playing, "ready" describes a waiting room that is gone.
    expect(canSetReady(room({ status: "active" }), GUEST)).toBe(false);
  });

  it("counts rather than complains", () => {
    expect(describeReadiness(room({}, [{ userId: HOST, ready: true }, { userId: GUEST }]))).toBe(
      "1 of 2 ready",
    );
    expect(
      describeReadiness(
        room({}, [
          { userId: HOST, ready: true },
          { userId: GUEST, ready: true },
        ]),
      ),
    ).toBe("2 of 2 ready");
  });
});

describe("the shared invite", () => {
  it("carries the code itself, because a link that dead-ends is worse", () => {
    const message = shareMessage("ABCDEF");
    expect(message).toContain("ABCDEF");
    // The deep link is a convenience for people who have the app; the six
    // characters are what anybody can type into the Join field.
    expect(message).toContain("arc21://room/ABCDEF");
  });
});

/**
 * Invite to Table, from the FRIEND PROFILE.
 *
 * The specification lists it among the nine things a friend's profile shows,
 * and it sat in the closing paragraph as "when private tables are built" long
 * after they were. Every branch below mirrors a check inside
 * `public.invite_friend_to_room`, except the two that do not — and those two
 * are the point: the server would happily accept both, and a player could use
 * neither.
 */
describe("inviting a friend from their profile", () => {
  it("offers the invite against a real room id", () => {
    const affordance = inviteAffordance(room(), HOST, STRANGER);
    expect(affordance).toEqual({ kind: "invite", roomId: "99999999-9999-4999-8999-999999999999" });
    expect(describeInviteUnavailable(affordance, "Anyone")).toBeNull();
  });

  it("offers it at a table that has already started, exactly as the server does", () => {
    // `invite_friend_to_room` accepts 'lobby' and 'active'. A five-seat table
    // mid-game with a free seat is a table somebody can still be asked to.
    expect(inviteAffordance(room({ status: "active" }), HOST, STRANGER).kind).toBe("invite");
  });

  it("has nothing to offer when the viewer is at no table", () => {
    expect(inviteAffordance(null, HOST, STRANGER)).toEqual({ kind: "no-table" });
    // Holding a room the viewer is not a member of is the same answer.
    expect(inviteAffordance(room(), STRANGER, THIRD)).toEqual({ kind: "no-table" });
    expect(inviteAffordance(room(), null, THIRD)).toEqual({ kind: "no-table" });
    expect(describeInviteUnavailable({ kind: "no-table" }, "Ada")).toContain(
      "need a private table open",
    );
  });

  /**
   * The server would send this one. It would be a notification telling somebody
   * about the table they are sitting at.
   */
  it("does not offer to invite someone who is already here", () => {
    expect(inviteAffordance(room(), HOST, GUEST)).toEqual({ kind: "already-here" });
    expect(inviteAffordance(room(), HOST, HOST)).toEqual({ kind: "already-here" });
    expect(describeInviteUnavailable({ kind: "already-here" }, "Ada")).toBe(
      "Ada is already at your table.",
    );
  });

  /**
   * And this one. `invite_friend_to_room` does not check capacity — the refusal
   * comes later, from `join_private_room`, by which point the invite has been
   * sent and cannot be honoured.
   */
  it("does not offer an invite into a table with no free seat", () => {
    const full = room({ maxSeats: 2 }, [{ userId: HOST }, { userId: GUEST }]);
    expect(inviteAffordance(full, HOST, STRANGER)).toEqual({ kind: "full" });
    expect(describeInviteUnavailable({ kind: "full" }, "Ada")).toContain("no free seat");
  });

  it("stops offering it once the table is closing", () => {
    for (const status of ["finishing", "closed", "expired"] as const) {
      expect(inviteAffordance(room({ status }), HOST, STRANGER)).toEqual({ kind: "closed" });
    }
    expect(describeInviteUnavailable({ kind: "closed" }, "Ada")).toContain("no longer taking");
  });
});

/**
 * THE BOUNCE, and the reason the fix had to be about ORDER rather than about
 * the value.
 *
 * `dealt` is module-level, so it survives the screen that set it. A player who
 * cashed out at the table came back to a lobby holding a pointer at the seat
 * the server had just settled, and the navigation effect — which fires on the
 * first render — replaced them onto a table answering `SESSION_CLOSED`, whose
 * only control returns to the lobby. Photographed on two devices.
 *
 * `restore()` clears the pointer, and cannot win: it is asynchronous and the
 * effect is not.
 */
describe("navigating the lobby to a dealt table", () => {
  const DEALT = { gameId: "33333333-3333-4333-8333-333333333333", seatId: "seat-1" };

  it("waits for the server's answer before acting on a pointer", () => {
    // The exact device state: a stale pointer, no answer yet.
    expect(mayOpenDealtTable({ checked: false, dealt: DEALT })).toBe(false);
  });

  it("opens the table once the answer confirms the pointer", () => {
    expect(mayOpenDealtTable({ checked: true, dealt: DEALT })).toBe(true);
  });

  it("stays on the create/join screen when the answer cleared the pointer", () => {
    expect(mayOpenDealtTable({ checked: true, dealt: null })).toBe(false);
  });

  it("never navigates on nothing, answered or not", () => {
    expect(mayOpenDealtTable({ checked: false, dealt: null })).toBe(false);
  });
});
