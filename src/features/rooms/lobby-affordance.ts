/**
 * What the private lobby may OFFER, given the room the server last described.
 *
 * Pure, and separate from `app/table/lobby.tsx` so every one of these can be
 * asserted without rendering React Native — the same split as
 * `betting-affordance.ts`, and for the same reason it exists: three defects in
 * this project survived a test of the function a dead control would have
 * called. Testing `removeMember` proves `removeMember` works. It proves nothing
 * about whether a host can reach it, or whether it is offered against the one
 * player it must never be offered against.
 *
 * None of this is a control. The server re-checks host, lobby, membership and
 * seat count on every call, and a modified client that renders every button
 * gets the same answers. These decide what an honest client shows.
 */

import type { RoomState } from "./rooms.js";

/**
 * Can this table be dealt?
 *
 * Read from a snapshot rather than by calling into the store, because calling a
 * getter during render freezes the value under the React Compiler — a mistake
 * this project has already shipped once.
 *
 * Deliberately NOT gated on readiness. The specification's start rule is
 * "minimum start: 2 human players", so ready states inform the host and a
 * player who never touches the toggle can still be dealt in.
 */
export function canStartTable(state: RoomState, userId: string | null): boolean {
  if (state.room.status !== "lobby") return false;
  if (state.members.length < 2) return false;
  return state.members.some((member) => member.isHost && member.userId === userId);
}

/** Is the viewer the host of this room? */
export function isHost(state: RoomState, userId: string | null): boolean {
  return userId !== null && state.room.hostUserId === userId;
}

/**
 * May the viewer remove this member?
 *
 * Four conditions, each mirroring one in `public.remove_room_member`:
 * host only, lobby only, before a game session exists, and never the host
 * themselves — leaving is `leave_room`, which migrates the host role.
 */
export function canRemoveMember(
  state: RoomState,
  viewerId: string | null,
  targetUserId: string,
): boolean {
  if (!isHost(state, viewerId)) return false;
  if (state.room.status !== "lobby") return false;
  if (state.room.gameSessionId !== null) return false;
  if (targetUserId === state.room.hostUserId) return false;
  return state.members.some((member) => member.userId === targetUserId);
}

/** This player's own ready flag, as the server last reported it. */
export function isReady(state: RoomState, userId: string | null): boolean {
  if (userId === null) return false;
  return state.members.some((member) => member.userId === userId && member.isReady);
}

/**
 * May the ready toggle be offered at all?
 *
 * Only in a lobby: once the table is playing, "ready" is a statement about a
 * waiting room that no longer exists.
 */
export function canSetReady(state: RoomState, userId: string | null): boolean {
  if (state.room.status !== "lobby") return false;
  return state.members.some((member) => member.userId === userId);
}

/**
 * How the lobby describes readiness in one line.
 *
 * Says what is true rather than what is missing: a table can be dealt with
 * nobody ready, so "1 of 3 ready" must not read as an obstacle.
 */
export function describeReadiness(state: RoomState): string {
  const ready = state.members.filter((member) => member.isReady).length;
  return `${ready} of ${state.members.length} ready`;
}

/**
 * The message the share sheet carries.
 *
 * The CODE is the payload, not a link. Arc 21 has no web fallback to send
 * somebody who does not have the app, and a deep link that dead-ends is worse
 * than six characters anybody can type into the Join field. The scheme is
 * included as a second line for people who do have it — `app/room/[code].tsx`
 * already handles `arc21://room/<code>` and validates the code before spending
 * a request on it.
 */
export function shareMessage(code: string): string {
  return `Join my Arc 21 table with code ${code}\n\narc21://room/${code}`;
}
