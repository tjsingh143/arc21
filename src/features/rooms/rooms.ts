/**
 * Validating what came back from the room RPCs.
 *
 * Rows are parsed rather than trusted. These arrive over the network from a
 * database whose shape can change under a deployed client, and a room rendered
 * from a half-understood row is worse than one that refuses to render: a lobby
 * that silently drops a seat looks exactly like a friend who has not joined.
 */

import { z } from "zod";

/** Six characters, no O/0 or I/1 — a code gets read aloud and typed by hand. */
export const ROOM_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

export const ROOM_CODE_LENGTH = 6;

export const roomSchema = z.object({
  id: z.string().uuid(),
  code: z.string().regex(ROOM_CODE_PATTERN),
  host_user_id: z.string().uuid(),
  max_seats: z.number().int().min(2).max(5),
  status: z.enum(["lobby", "active", "finishing", "closed", "expired"]),
  game_session_id: z.string().uuid().nullable(),
});

export interface Room {
  readonly id: string;
  readonly code: string;
  readonly hostUserId: string;
  readonly maxSeats: number;
  readonly status: "lobby" | "active" | "finishing" | "closed" | "expired";
  readonly gameSessionId: string | null;
}

export interface RoomMember {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly seatIndex: number;
  readonly isReady: boolean;
  readonly isHost: boolean;
}

export interface RoomState {
  readonly room: Room;
  readonly members: readonly RoomMember[];
}

/** `get_room_state` returns one flat row per member; the room repeats. */
const roomStateRowSchema = z.object({
  room_id: z.string().uuid(),
  code: z.string(),
  status: z.enum(["lobby", "active", "finishing", "closed", "expired"]),
  host_user_id: z.string().uuid(),
  max_seats: z.number().int(),
  game_session_id: z.string().uuid().nullable(),
  member_user_id: z.string().uuid(),
  member_username: z.string(),
  member_display_name: z.string(),
  member_seat_index: z.number().int(),
  member_is_ready: z.boolean(),
  member_is_host: z.boolean(),
});

/** A single room row, as `create_private_room` and `join_private_room` return. */
export function toRoom(value: unknown): Room | null {
  // PostgREST returns a bare row for a scalar-returning function and an array
  // for a set-returning one; accept either rather than depending on which.
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = roomSchema.safeParse(candidate);
  if (!parsed.success) return null;

  return {
    id: parsed.data.id,
    code: parsed.data.code,
    hostUserId: parsed.data.host_user_id,
    maxSeats: parsed.data.max_seats,
    status: parsed.data.status,
    gameSessionId: parsed.data.game_session_id,
  };
}

export function toRoomState(value: unknown): RoomState | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const rows = value
    .map((row) => roomStateRowSchema.safeParse(row))
    .filter((result): result is { success: true; data: z.infer<typeof roomStateRowSchema> } =>
      result.success,
    )
    .map((result) => result.data);

  const first = rows[0];
  if (!first) return null;

  return {
    room: {
      id: first.room_id,
      code: first.code,
      hostUserId: first.host_user_id,
      maxSeats: first.max_seats,
      status: first.status,
      gameSessionId: first.game_session_id,
    },
    members: rows
      .map((row) => ({
        userId: row.member_user_id,
        username: row.member_username,
        displayName: row.member_display_name,
        seatIndex: row.member_seat_index,
        isReady: row.member_is_ready,
        isHost: row.member_is_host,
      }))
      .sort((left, right) => left.seatIndex - right.seatIndex),
  };
}

/**
 * Is this worth sending to the server?
 *
 * Purely a courtesy check. The server validates independently, and a code that
 * passes here can still be refused — the table may be full, expired, or never
 * have existed.
 */
export function looksLikeRoomCode(raw: string): boolean {
  return ROOM_CODE_PATTERN.test(raw.replace(/\s/g, "").toUpperCase());
}

/** Uppercases and strips spacing, so "abc def" reads as "ABCDEF". */
export function normaliseRoomCode(raw: string): string {
  return raw.replace(/\s/g, "").toUpperCase().slice(0, ROOM_CODE_LENGTH);
}
