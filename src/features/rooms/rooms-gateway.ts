/**
 * Arc 21 — private tables.
 *
 * Four asks, and none of them names a chip amount, a seat or a stack. The
 * server decides all three: a client that could name a starting stack at an
 * unranked table could name one anywhere.
 *
 * A private table never touches the global wallet. There is no buy-in method
 * here and no cash-out method, because there is no buy-in and no cash-out —
 * seats start on a fixed session stack and those chips cannot leave the room.
 * That is the anti-collusion rule: if chips could travel, two accounts could
 * transfer a bankroll by agreeing to lose.
 *
 * Nothing throws. Every failure is a value, because "you are signed out",
 * "that code is wrong" and "the server did not answer" are three different
 * sentences a player needs to read differently.
 */

import type { ArcSupabaseClient } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import { toRoom, toRoomState, type Room, type RoomState } from "./rooms.js";

export type RoomsFailureReason =
  /** No Supabase configuration in this build. Practice is unaffected. */
  | "not-configured"
  /** A guest. Private tables need an account so seats survive a reconnect. */
  | "signed-out"
  /** The server answered, and said no. `message` is its own wording. */
  | "refused"
  /** The server did not answer at all. */
  | "unreachable";

export interface RoomsFailure {
  readonly ok: false;
  readonly reason: RoomsFailureReason;
  readonly message: string;
}

export type RoomOutcome = { readonly ok: true; readonly room: Room } | RoomsFailure;
export type RoomStartOutcome =
  | { readonly ok: true; readonly gameId: string; readonly seatId: string }
  | RoomsFailure;
export type RoomStateOutcome = { readonly ok: true; readonly state: RoomState } | RoomsFailure;
export type RoomVoidOutcome = { readonly ok: true } | RoomsFailure;

export type RoomSeatOutcome =
  | { readonly ok: true; readonly seatId: string | null }
  | RoomsFailure;

/** `room: null` is a real answer — this player has no table open. */
export type RoomLookupOutcome = { readonly ok: true; readonly room: Room | null } | RoomsFailure;

/**
 * `removed: false` is the server's answer to every refusal it will not explain:
 * not the host, the room is playing, no such room, no such member. It is not an
 * error, and the lobby renders it as "that did not happen" rather than as a
 * failure of the request.
 */
export type RoomRemovalOutcome = { readonly ok: true; readonly removed: boolean } | RoomsFailure;

export interface RoomsGateway {
  readonly kind: "supabase" | "unconfigured" | "fake";
  create(maxSeats: number): Promise<RoomOutcome>;
  join(code: string): Promise<RoomOutcome>;
  read(roomId: string): Promise<RoomStateOutcome>;
  /**
   * The table this player is already at, if there is one.
   *
   * "Loading/reconnect must preserve room code" is the specification's line for
   * this screen, and before this existed a host who force-quit was STUCK: the
   * lobby came back empty, `create_private_room` refused with "you already have
   * a table open", and the only way out was waiting thirty minutes for the room
   * to expire.
   *
   * A plain select, not an RPC: `rooms_select_member` already restricts the
   * table to rooms the caller is a joined member of, so the policy is the
   * lookup. The expiry half of the filter is evaluated by POSTGRES — `now()`
   * reaches the database as a value — because a device clock is not something
   * to decide a live table on.
   */
  findOpenRoom(): Promise<RoomLookupOutcome>;
  /** Set or clear this player's ready flag in the lobby. */
  setReady(roomId: string, ready: boolean): Promise<RoomVoidOutcome>;
  /** Host only, lobby only. The server checks both again. */
  removeMember(roomId: string, userId: string): Promise<RoomRemovalOutcome>;
  /** Deal the first hand. The server rejects anyone but the host. */
  start(roomId: string): Promise<RoomStartOutcome>;
  /**
   * This player's seat in a session the room has already started.
   *
   * ONLY THE HOST LEARNS ITS SEAT FROM `start`. Everyone else joined a lobby
   * and then watched the host deal, and before this existed there was no way
   * for them to address their own seat: `get_room_state` reports the room's
   * `game_session_id` but not the caller's seat row, so a guest could see that
   * a game had begun and had nothing to open it with. They sat in the lobby
   * while the host played — verified across two simulators in phase 14 s4.
   *
   * No migration was needed: `game_session_seats` already grants SELECT to
   * `authenticated` under an `is_session_participant` policy, so a seated
   * player may read the seats of their own session and nobody else's.
   *
   * `seatId: null` is a real answer, not a failure — it means the session has
   * no seat for this player yet, which is what a race between the poll and the
   * host's deal looks like.
   */
  findSeat(gameSessionId: string): Promise<RoomSeatOutcome>;
  leave(roomId: string): Promise<RoomVoidOutcome>;
}

const UNREACHABLE = "Could not reach the server, so the table could not be opened.";
/**
 * The single answer for every reason a code does not admit you.
 *
 * `join_private_room` returns no row — rather than raising a different message
 * per cause — so that a caller working through six-character codes learns
 * nothing from the difference between "no such table", "it expired", "it is
 * full" and "the host has blocked you". This sentence is the client half of
 * that: one refusal, whatever happened.
 */
const NO_SUCH_TABLE = "That table is not available.";
const SIGNED_OUT =
  "Private tables need an account, so your seat survives a reconnect. Practice stays available without one.";
/**
 * What being removed reads as.
 *
 * `get_room_state` raises PT404 for a player who is not a joined member, which
 * is the same answer for "the host removed you", "you left on another device"
 * and "the room closed". The player is off the table either way, and this is
 * the sentence that says so — the server's own lower-case wording is a
 * developer message, not a player one.
 */
const NO_LONGER_SEATED = "You are no longer at that table.";
/**
 * The SQLSTATE the room functions raise when the caller is not a member.
 *
 * `PT404`, because PostgREST maps `PTnnn` to HTTP nnn and has no mapping for
 * anything else — this used to be `P0002` under a comment claiming PostgREST
 * rendered it as 404, and it rendered as **500**. Measured, not reasoned about.
 * The status is what monitoring reads; this constant is what the client reads,
 * and both should agree that being removed from a lobby is not a server fault.
 */
const NOT_A_MEMBER = "PT404";

/**
 * The restore filter, as one exported string.
 *
 * Exported so `tests/server/private-rooms.integration.test.ts` can send THIS
 * expression to the real PostgREST rather than a paraphrase of it. The `now()`
 * is not a client value: PostgREST passes it through and Postgres evaluates it,
 * so the expiry comparison is made on the database's clock. A test that
 * rewrote the string by hand would prove a query the app does not make.
 */
export const OPEN_ROOM_FILTER =
  "status.in.(active,finishing),and(status.eq.lobby,expires_at.gt.now())";

export function createUnconfiguredRoomsGateway(message: string): RoomsGateway {
  const refuse = async () => ({ ok: false as const, reason: "not-configured" as const, message });
  return {
    kind: "unconfigured",
    create: refuse,
    join: refuse,
    read: refuse,
    findOpenRoom: refuse,
    setReady: refuse,
    removeMember: refuse,
    start: refuse,
    findSeat: refuse,
    leave: refuse,
  };
}

export function createSupabaseRoomsGateway(
  client: ArcSupabaseClient,
  options: { readonly timeoutMs?: number } = {},
): RoomsGateway {
  const { timeoutMs } = options;

  async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
    const result = await withTimeout(Promise.resolve(work), timeoutMs);
    return isTimedOut(result) ? null : result;
  }

  async function requireSession(): Promise<RoomsFailure | null> {
    const session = await bounded(client.auth.getSession());
    if (session === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };
    if (!session.data.session) return { ok: false, reason: "signed-out", message: SIGNED_OUT };
    return null;
  }

  return {
    kind: "supabase",

    async create(maxSeats: number): Promise<RoomOutcome> {
      const denied = await requireSession();
      if (denied) return denied;

      const result = await bounded(client.rpc("create_private_room", { p_max_seats: maxSeats }));
      if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };
      if (result.error) {
        // The server's own wording — "you already have a table open" — is more
        // useful than anything this layer could infer.
        return { ok: false, reason: "refused", message: result.error.message };
      }

      const room = toRoom(result.data);
      if (!room) return { ok: false, reason: "unreachable", message: UNREACHABLE };
      return { ok: true, room };
    },

    async join(code: string): Promise<RoomOutcome> {
      const denied = await requireSession();
      if (denied) return denied;

      // Case and spacing are normalised server-side too; doing it here as well
      // means an obviously-malformed code never becomes a request.
      const result = await bounded(
        client.rpc("join_private_room", { p_code: code.replace(/\s/g, "").toUpperCase() }),
      );
      if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };
      // The server's own wording for a refusal it DID raise — today that is the
      // rate limit, which says when to try again.
      if (result.error) return { ok: false, reason: "refused", message: result.error.message };

      const room = toRoom(result.data);
      // No row is a refusal, not a transport failure. The server answers this
      // way for an unknown code, an expired table, a full one and a block
      // alike, so telling the player the server was unreachable would be both
      // wrong and the only place the difference could leak.
      if (!room) return { ok: false, reason: "refused", message: NO_SUCH_TABLE };
      return { ok: true, room };
    },

    async read(roomId: string): Promise<RoomStateOutcome> {
      const denied = await requireSession();
      if (denied) return denied;

      const result = await bounded(client.rpc("get_room_state", { p_room_id: roomId }));
      if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };
      if (result.error) {
        // The one refusal a player actually experiences: they are not a member
        // any more. Being removed by the host arrives here, on the next poll.
        const message =
          result.error.code === NOT_A_MEMBER ? NO_LONGER_SEATED : result.error.message;
        return { ok: false, reason: "refused", message };
      }

      const state = toRoomState(result.data);
      if (!state) return { ok: false, reason: "refused", message: "That table is no longer open." };
      return { ok: true, state };
    },

    async findOpenRoom(): Promise<RoomLookupOutcome> {
      const denied = await requireSession();
      if (denied) return denied;

      /*
       * `rooms_select_member` is the whole filter for WHOSE room this is: it
       * admits exactly the rooms the caller is a joined member of, so no user
       * id appears here and none is trusted.
       *
       * The status half deserves its own sentence. A LOBBY has a 30-minute TTL
       * and an unswept expired one must not be restored, or a player is put
       * back into a dead waiting room. A room that is PLAYING carries the same
       * `expires_at` it was created with — that column is the lobby timeout,
       * not the table's — so filtering an active table on it would strand
       * anybody whose game outlived its lobby, which is every real game.
       */
      const result = await bounded(
        client
          .from("rooms")
          .select("id,code,host_user_id,max_seats,status,game_session_id")
          .or(OPEN_ROOM_FILTER)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      );
      if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };
      if (result.error) return { ok: false, reason: "refused", message: result.error.message };
      if (result.data === null) return { ok: true, room: null };

      const room = toRoom(result.data);
      // A row that will not parse is not a room to put somebody back into.
      return { ok: true, room };
    },

    async setReady(roomId: string, ready: boolean): Promise<RoomVoidOutcome> {
      const denied = await requireSession();
      if (denied) return denied;

      const result = await bounded(
        client.rpc("set_room_ready", { p_room_id: roomId, p_ready: ready }),
      );
      if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };
      if (result.error) {
        const message =
          result.error.code === NOT_A_MEMBER ? NO_LONGER_SEATED : result.error.message;
        return { ok: false, reason: "refused", message };
      }
      return { ok: true };
    },

    async removeMember(roomId: string, userId: string): Promise<RoomRemovalOutcome> {
      const denied = await requireSession();
      if (denied) return denied;

      const result = await bounded(
        client.rpc("remove_room_member", { p_room_id: roomId, p_user_id: userId }),
      );
      if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };
      if (result.error) return { ok: false, reason: "refused", message: result.error.message };
      // The function returns a boolean and refuses by returning `false` rather
      // than by raising, so that a non-host learns nothing about the room.
      return { ok: true, removed: result.data === true };
    },

    /**
     * Deal the first hand.
     *
     * This one is an Edge Function rather than an RPC, because dealing runs the
     * shared blackjack engine — the same code the client and the tests use —
     * and that lives in TypeScript, not in Postgres. The client sends a room id
     * and nothing else: seats, stacks, stakes and the shoe are all the
     * server's.
     */
    async start(roomId: string): Promise<RoomStartOutcome> {
      const denied = await requireSession();
      if (denied) return denied;

      const result = await bounded(
        client.functions.invoke("create-session", {
          body: {
            action: "START_PRIVATE_TABLE",
            clientRequestId: globalThis.crypto.randomUUID(),
            roomId,
            clientSentAt: new Date().toISOString(),
          },
        }),
      );
      if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };
      if (result.error) {
        return {
          ok: false,
          reason: "refused",
          message: "That table could not be dealt. Only the host deals, and everyone must be seated.",
        };
      }

      const data = result.data as { gameId?: unknown; seatId?: unknown } | null;
      if (typeof data?.gameId !== "string" || typeof data.seatId !== "string") {
        return { ok: false, reason: "unreachable", message: UNREACHABLE };
      }
      return { ok: true, gameId: data.gameId, seatId: data.seatId };
    },

    async findSeat(gameSessionId: string): Promise<RoomSeatOutcome> {
      const session = await bounded(client.auth.getSession());
      if (session === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };
      const userId = session.data.session?.user.id;
      if (!userId) return { ok: false, reason: "signed-out", message: SIGNED_OUT };

      /*
       * Filtered by user id as well as session, even though the RLS policy
       * already restricts the rows to sessions this player is in: the policy
       * admits every seat at the table, and this asks for exactly one — mine.
       * Without the second filter a two-player table returns two rows and
       * `maybeSingle` fails on the ambiguity rather than on anything real.
       */
      const result = await bounded(
        client
          .from("game_session_seats")
          .select("id")
          .eq("game_session_id", gameSessionId)
          .eq("user_id", userId)
          /*
           * A SETTLED SEAT IS NOT A SEAT TO OPEN A TABLE WITH.
           *
           * Without this the lobby walks a player straight back into a table
           * they have just cashed out of: `status = 'left'` is written by
           * `settleTableClosure`, the row stays for the history, and this
           * lookup returned it happily. Seen on a device — leaving from the
           * table screen, deep-linking to the lobby, and being replaced onto
           * `/table/[gameId]` again, where every command answers
           * `SESSION_CLOSED`. The seat this asks for is a LIVE one.
           */
          .neq("status", "left")
          .maybeSingle(),
      );
      if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };
      if (result.error) {
        return { ok: false, reason: "refused", message: "That table could not be opened." };
      }

      const seatId = (result.data as { id?: unknown } | null)?.id;
      return { ok: true, seatId: typeof seatId === "string" ? seatId : null };
    },

    async leave(roomId: string): Promise<RoomVoidOutcome> {
      const denied = await requireSession();
      if (denied) return denied;

      const result = await bounded(client.rpc("leave_room", { p_room_id: roomId }));
      if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };
      if (result.error) return { ok: false, reason: "refused", message: result.error.message };
      return { ok: true };
    },
  };
}
