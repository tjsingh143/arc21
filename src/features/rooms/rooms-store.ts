import { playerScopedSetter } from "../player/player-scope.js";
/**
 * The private-table lobby, as state.
 *
 * A lobby is mostly a waiting room, and waiting rooms go wrong in one specific
 * way: they show a stale picture and let someone act on it. So every action
 * re-reads the authoritative room afterwards rather than patching a local copy,
 * and the screen renders whatever the server last said.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import {
  createSupabaseRoomsGateway,
  createUnconfiguredRoomsGateway,
  type RoomsFailure,
  type RoomsGateway,
} from "./rooms-gateway.js";
import { looksLikeRoomCode, normaliseRoomCode, type RoomState } from "./rooms.js";

export type RoomsStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  /** In a room. `state` is the last authoritative reading. */
  | { readonly kind: "seated"; readonly state: RoomState }
  | { readonly kind: "not-configured"; readonly message: string }
  | { readonly kind: "signed-out"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

export interface RoomsStoreState {
  readonly status: RoomsStatus;
  /** Set once the host deals, so the lobby can navigate to the table. */
  readonly dealt: { gameId: string; seatId: string } | null;
  /** What the player is typing into the join field. */
  readonly codeInput: string;
  /** Set when the last action was refused, cleared when a new one starts. */
  readonly notice: string | null;

  setCodeInput: (raw: string) => void;
  createRoom: (maxSeats: number) => Promise<void>;
  joinRoom: () => Promise<void>;
  /** `roomId` is passed only when entering a room the store does not yet hold. */
  refresh: (roomId?: string) => Promise<void>;
  /**
   * Put the player back at the table they are already at, if any.
   *
   * Called when the lobby mounts. "Loading/reconnect must preserve room code"
   * is the specification's line for this screen, and until this existed a host
   * who force-quit the app was stuck: the lobby came back empty and
   * `create_private_room` refused with "you already have a table open".
   */
  restore: () => Promise<void>;
  /** Deal the first hand. Only the host may; the server enforces it. */
  startTable: () => Promise<void>;
  /** This player's own ready flag. Informs the host; never gates the deal. */
  setReady: (ready: boolean) => Promise<void>;
  /** Host only, lobby only. The server checks both again. */
  removeMember: (userId: string) => Promise<void>;
  leave: () => Promise<void>;
}

let gatewayOverride: RoomsGateway | null = null;

export function setRoomsGateway(next: RoomsGateway | null): void {
  gatewayOverride = next;
}

export function activeRoomsGateway(): RoomsGateway {
  if (gatewayOverride !== null) return gatewayOverride;

  const availability = getSupabase();
  if (availability.status !== "ready") {
    return createUnconfiguredRoomsGateway(availability.message);
  }
  return createSupabaseRoomsGateway(availability.client);
}

function statusForFailure(failure: RoomsFailure): RoomsStatus {
  switch (failure.reason) {
    case "not-configured":
      return { kind: "not-configured", message: failure.message };
    case "signed-out":
      return { kind: "signed-out", message: failure.message };
    default:
      return { kind: "unavailable", message: failure.message };
  }
}

export const useRoomsStore = create<RoomsStoreState>((set, get) => ({
  status: { kind: "idle" },
  dealt: null,
  codeInput: "",
  notice: null,

  setCodeInput: (raw) => set({ codeInput: normaliseRoomCode(raw), notice: null }),

  createRoom: async (maxSeats) => {
    const setForPlayer = playerScopedSetter(set);
    setForPlayer({ status: { kind: "working" }, notice: null });
    const created = await activeRoomsGateway().create(maxSeats);
    if (!created.ok) {
      // A refusal is usually "you already have a table open", which is a state
      // the player can fix — so it is a notice beside an idle screen, not a
      // dead end.
      if (created.reason === "refused") {
        setForPlayer({ status: { kind: "idle" }, notice: created.message });
        return;
      }
      setForPlayer({ status: statusForFailure(created) });
      return;
    }
    if (!setForPlayer.isCurrent()) return;
    await get().refresh(created.room.id);
  },

  joinRoom: async () => {
    const setForPlayer = playerScopedSetter(set);
    const code = get().codeInput;
    if (!looksLikeRoomCode(code)) {
      setForPlayer({ notice: "A table code is six letters and numbers." });
      return;
    }

    setForPlayer({ status: { kind: "working" }, notice: null });
    const joined = await activeRoomsGateway().join(code);
    if (!joined.ok) {
      if (joined.reason === "refused") {
        setForPlayer({ status: { kind: "idle" }, notice: joined.message });
        return;
      }
      setForPlayer({ status: statusForFailure(joined) });
      return;
    }
    if (!setForPlayer.isCurrent()) return;
    await get().refresh(joined.room.id);
  },

  refresh: async (roomId?: string) => {
    const setForPlayer = playerScopedSetter(set);
    const current = get().status;
    const id = roomId ?? (current.kind === "seated" ? current.state.room.id : null);
    if (!id) return;

    const read = await activeRoomsGateway().read(id);
    if (!read.ok) {
      // A refusal here means the room is gone — expired, everyone left, or this
      // player is no longer a member of it.
      if (read.reason === "refused") {
        /*
         * `dealt` IS CLEARED HERE, and it has to be. The lobby's navigation
         * effect is keyed on it and fires whenever it is set — so a player who
         * left through the TABLE screen (which sends CASH_OUT and never touches
         * this store) came back to the lobby, found `dealt` still holding the
         * game they had just left, and was replaced straight onto it. Seen on a
         * device: an endless bounce between the lobby and a table answering
         * `SESSION_CLOSED`.
         */
        setForPlayer({ status: { kind: "idle" }, dealt: null, notice: read.message });
        return;
      }
      setForPlayer({ status: statusForFailure(read) });
      return;
    }
    setForPlayer({ status: { kind: "seated", state: read.state } });

    /*
     * The host is not the only person who has to reach the table.
     *
     * `startTable` sets `dealt` for whoever pressed Deal, and the lobby's
     * navigation effect is keyed on it — so before this, a guest polled every
     * three seconds, watched `gameSessionId` appear, and sat in the lobby
     * while the host played. Proved across two simulators in phase 14 s4: the
     * host reached the table, the second player never did, and a private table
     * is exactly the feature that needs two.
     *
     * Resolved here rather than in the lobby so every seated client converges
     * on the same state whatever route it took in.
     */
    if (!setForPlayer.isCurrent()) return;
    const gameSessionId = read.state.room.gameSessionId;

    /*
     * `dealt` MUST NAME THE TABLE THIS ROOM IS ACTUALLY RUNNING.
     *
     * It is a module-level value that survives navigation, and the lobby's
     * navigation effect acts on it the moment it is set — so a pointer left
     * over from a previous room is a pointer that sends the player to the wrong
     * table. Reachable without leaving the lobby at all: leave a table, join a
     * new room by code, and `joinRoom` calls straight into this function. The
     * new room has not dealt, the old `dealt` was kept because it was merely
     * non-null, and the effect replaced the player onto the table they had just
     * left. Agreeing on the id costs nothing and makes the value self-checking.
     */
    const held = get().dealt;
    if (held !== null) {
      if (held.gameId === gameSessionId) return;
      setForPlayer({ dealt: null });
    }
    if (gameSessionId === null) return;

    const seat = await activeRoomsGateway().findSeat(gameSessionId);
    // A missing seat is not an error worth surfacing: the next poll retries,
    // and the only thing it costs is three seconds.
    if (seat.ok && seat.seatId !== null) {
      setForPlayer({ dealt: { gameId: gameSessionId, seatId: seat.seatId } });
    }
  },

  restore: async () => {
    const setForPlayer = playerScopedSetter(set);
    /*
     * THE SERVER IS ASKED EVERY TIME, and the guard that used to stand here is
     * the defect this closes.
     *
     * It read `if (get().status.kind === "seated") return;` — "never over a room
     * already in hand: the poll is more current than this". But this runs on
     * MOUNT, and on mount a `seated` reading is by definition one carried over
     * from a previous mount, because `dealt` navigating away is what unmounted
     * the lobby in the first place. There is no poll yet for it to be older
     * than. The single case the guard skipped is the only case that matters.
     *
     * What that cost, photographed on a device: a player who left through the
     * TABLE screen — `CASH_OUT`, which never touches this store — came back to
     * a store still holding `seated` and still holding `dealt`. The lookup below
     * never ran, so the `room === null` branch that clears `dealt` was
     * unreachable, and the lobby's navigation effect replaced them straight onto
     * the table they had just left, where every command answers
     * `SESSION_CLOSED`. The only control there is "Leave table", which cashes
     * out an already-settled seat and returns to the lobby, which bounces them
     * back: a loop with no way out but killing the app. `arc21://table/lobby`
     * reported COMPLETED and changed nothing.
     *
     * Both halves of the fix were ALREADY HERE and both were dead behind that
     * return — this function's `room === null` branch, and `findSeat`'s
     * `status <> 'left'` filter. A guard that protects a resource has to ask
     * whether the resource is still there; this one asked only whether it once
     * had been.
     */
    const found = await activeRoomsGateway().findOpenRoom();
    // Silent on failure, in both directions. This runs on mount, unasked, and a
    // player who has no table open must see the ordinary create/join screen —
    // not an error about a lookup they did not make.
    if (!found.ok) return;
    if (found.room === null) {
      /*
       * NO OPEN ROOM MEANS NO DEALT TABLE AND NO SEATED LOBBY EITHER.
       *
       * `rooms_select_member` admits only rooms the caller is a `joined` member
       * of, so an empty answer is the server saying this player is in none.
       * Clearing `dealt` alone would leave the previous room's lobby on screen —
       * its code, its members, its Deal button — for a room whose membership
       * ended when the seat settled.
       */
      setForPlayer({ dealt: null });
      if (get().status.kind === "seated") setForPlayer({ status: { kind: "idle" } });
      return;
    }
    if (!setForPlayer.isCurrent()) return;
    await get().refresh(found.room.id);
  },

  startTable: async () => {
    const setForPlayer = playerScopedSetter(set);
    const current = get().status;
    if (current.kind !== "seated") return;

    setForPlayer({ notice: null });
    const started = await activeRoomsGateway().start(current.state.room.id);
    if (!started.ok) {
      setForPlayer({ notice: started.message });
      return;
    }
    // The room now points at a game; re-read so the lobby reflects it, and
    // hand the caller the ids it needs to open the table.
    if (!setForPlayer.isCurrent()) return;
    await get().refresh(current.state.room.id);
    setForPlayer({ dealt: { gameId: started.gameId, seatId: started.seatId } });
  },

  setReady: async (ready) => {
    const setForPlayer = playerScopedSetter(set);
    const current = get().status;
    if (current.kind !== "seated") return;

    const result = await activeRoomsGateway().setReady(current.state.room.id, ready);
    if (!result.ok) {
      // Being told you are not at the table is the removal arriving; drop to
      // the entry screen rather than leaving a lobby on screen that is not
      // yours any more.
      if (result.reason === "refused") {
        setForPlayer({ status: { kind: "idle" }, dealt: null, notice: result.message });
        return;
      }
      setForPlayer({ notice: result.message });
      return;
    }
    // Re-read rather than patch: every other client sees the server's row, and
    // a local flag that disagreed with it would be the one thing on this screen
    // that was not the server's answer.
    if (!setForPlayer.isCurrent()) return;
    await get().refresh(current.state.room.id);
  },

  removeMember: async (userId) => {
    const setForPlayer = playerScopedSetter(set);
    const current = get().status;
    if (current.kind !== "seated") return;

    setForPlayer({ notice: null });
    const result = await activeRoomsGateway().removeMember(current.state.room.id, userId);
    if (!result.ok) {
      setForPlayer({ notice: result.message });
      return;
    }
    if (!result.removed) {
      // The server refuses without explaining, so the client says the one thing
      // that is true of every refusal it can reach from this screen.
      setForPlayer({ notice: "That player could not be removed. A table that has started belongs to the server." });
    }
    if (!setForPlayer.isCurrent()) return;
    await get().refresh(current.state.room.id);
  },

  leave: async () => {
    const setForPlayer = playerScopedSetter(set);
    const current = get().status;
    if (current.kind !== "seated") return;

    await activeRoomsGateway().leave(current.state.room.id);
    // Left locally whatever the server said. The player asked to go, and a
    // failed leave that strands them in a lobby is the wrong failure direction.
    setForPlayer({ status: { kind: "idle" }, dealt: null, codeInput: "", notice: null });
  },
}));
