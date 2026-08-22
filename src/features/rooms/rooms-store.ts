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
  /** Deal the first hand. Only the host may; the server enforces it. */
  startTable: () => Promise<void>;
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
    set({ status: { kind: "working" }, notice: null });
    const created = await activeRoomsGateway().create(maxSeats);
    if (!created.ok) {
      // A refusal is usually "you already have a table open", which is a state
      // the player can fix — so it is a notice beside an idle screen, not a
      // dead end.
      if (created.reason === "refused") {
        set({ status: { kind: "idle" }, notice: created.message });
        return;
      }
      set({ status: statusForFailure(created) });
      return;
    }
    await get().refresh(created.room.id);
  },

  joinRoom: async () => {
    const code = get().codeInput;
    if (!looksLikeRoomCode(code)) {
      set({ notice: "A table code is six letters and numbers." });
      return;
    }

    set({ status: { kind: "working" }, notice: null });
    const joined = await activeRoomsGateway().join(code);
    if (!joined.ok) {
      if (joined.reason === "refused") {
        set({ status: { kind: "idle" }, notice: joined.message });
        return;
      }
      set({ status: statusForFailure(joined) });
      return;
    }
    await get().refresh(joined.room.id);
  },

  refresh: async (roomId?: string) => {
    const current = get().status;
    const id = roomId ?? (current.kind === "seated" ? current.state.room.id : null);
    if (!id) return;

    const read = await activeRoomsGateway().read(id);
    if (!read.ok) {
      // A refusal here means the room is gone — expired, or everyone left.
      if (read.reason === "refused") {
        set({ status: { kind: "idle" }, notice: read.message });
        return;
      }
      set({ status: statusForFailure(read) });
      return;
    }
    set({ status: { kind: "seated", state: read.state } });

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
    const gameSessionId = read.state.room.gameSessionId;
    if (gameSessionId === null || get().dealt !== null) return;

    const seat = await activeRoomsGateway().findSeat(gameSessionId);
    // A missing seat is not an error worth surfacing: the next poll retries,
    // and the only thing it costs is three seconds.
    if (seat.ok && seat.seatId !== null) {
      set({ dealt: { gameId: gameSessionId, seatId: seat.seatId } });
    }
  },

  startTable: async () => {
    const current = get().status;
    if (current.kind !== "seated") return;

    set({ notice: null });
    const started = await activeRoomsGateway().start(current.state.room.id);
    if (!started.ok) {
      set({ notice: started.message });
      return;
    }
    // The room now points at a game; re-read so the lobby reflects it, and
    // hand the caller the ids it needs to open the table.
    await get().refresh(current.state.room.id);
    set({ dealt: { gameId: started.gameId, seatId: started.seatId } });
  },

  leave: async () => {
    const current = get().status;
    if (current.kind !== "seated") return;

    await activeRoomsGateway().leave(current.state.room.id);
    // Left locally whatever the server said. The player asked to go, and a
    // failed leave that strands them in a lobby is the wrong failure direction.
    set({ status: { kind: "idle" }, dealt: null, codeInput: "", notice: null });
  },
}));

/**
 * Can this table be dealt?
 *
 * Read from a snapshot rather than by calling into the store, because calling a
 * getter during render freezes the value under the React Compiler — a mistake
 * this project has already shipped once.
 */
export function canStartTable(state: RoomState, userId: string | null): boolean {
  if (state.room.status !== "lobby") return false;
  if (state.members.length < 2) return false;
  return state.members.some((member) => member.isHost && member.userId === userId);
}
