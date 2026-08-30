/**
 * Queueing for a public seat.
 *
 * The important difference from a private table: a public seat is funded by a
 * REAL buy-in from the global wallet. So this store queues and polls, and the
 * buy-in itself is a separate, deliberate step through the session function —
 * never something that happens as a side effect of finding a seat.
 *
 * A player who is matched has NOT yet paid. They are seated in a lobby; the
 * chips move when the table is opened.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import { readRejection } from "../../lib/supabase/rejection.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import { toQueuePlace, type QueuePlace, type TierId } from "./matchmaking.js";
import { useWalletStore } from "../wallet/wallet-store.js";

export type MatchmakingStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "queued"; readonly place: QueuePlace }
  | { readonly kind: "matched"; readonly place: QueuePlace }
  | { readonly kind: "unavailable"; readonly message: string };

export interface MatchmakingStoreState {
  readonly status: MatchmakingStatus;
  readonly notice: string | null;

  queue: (tier: TierId) => Promise<void>;
  /**
   * Take the matched seat, which is when the buy-in is actually charged.
   * Returns the ids the table screen needs, or null if the seat was refused.
   */
  takeSeat: () => Promise<{ gameId: string; seatId: string } | null>;
  poll: () => Promise<void>;
  cancel: () => Promise<void>;
}

const UNREACHABLE = "Could not reach matchmaking. Nothing has been charged.";
const SIGNED_OUT = "Public tables need an account. Practice stays available without one.";
/*
 * "Leave that table first" was advice the player could not act on: the game id
 * reached the client once, in the reply to the join being refused here, and
 * nothing persisted it or asked for it back. `Play` now offers the way back —
 * `my_active_session()` names the table — so this says where to find it.
 */
const SEATED_ELSEWHERE =
  "You are already seated at a table, and your chips are there. Return to it from Play — nothing has been charged for this one.";

async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
  const result = await withTimeout(Promise.resolve(work), undefined);
  return isTimedOut(result) ? null : result;
}

export const useMatchmakingStore = create<MatchmakingStoreState>((set, get) => ({
  status: { kind: "idle" },
  notice: null,

  queue: async (tier) => {
    const availability = getSupabase();
    if (availability.status !== "ready") {
      set({ status: { kind: "unavailable", message: availability.message } });
      return;
    }

    const session = await bounded(availability.client.auth.getSession());
    if (session === null) {
      set({ status: { kind: "unavailable", message: UNREACHABLE } });
      return;
    }
    if (!session.data.session) {
      set({ status: { kind: "unavailable", message: SIGNED_OUT } });
      return;
    }

    const result = await bounded(availability.client.rpc("join_matchmaking", { p_tier: tier }));
    if (result === null) {
      set({ status: { kind: "unavailable", message: UNREACHABLE } });
      return;
    }
    if (result.error) {
      // The server's own wording — "the high table unlocks at level 10" — is
      // more useful than anything this layer could infer.
      set({ notice: result.error.message });
      return;
    }

    await get().poll();
  },

  poll: async () => {
    const availability = getSupabase();
    if (availability.status !== "ready") return;

    const result = await bounded(availability.client.rpc("poll_matchmaking"));
    if (result === null || result.error) return;

    const place = toQueuePlace(result.data);
    if (!place) {
      // No row means no live search. Not an error — the player may have
      // cancelled on another device.
      set({ status: { kind: "idle" } });
      return;
    }

    if (place.status === "matched") {
      set({ status: { kind: "matched", place }, notice: null });
      return;
    }
    if (place.status === "waiting") {
      set({ status: { kind: "queued", place }, notice: null });
      return;
    }
    set({ status: { kind: "idle" }, notice: null });
  },

  takeSeat: async () => {
    const current = get().status;
    if (current.kind !== "matched" || !current.place.roomId) return null;

    const availability = getSupabase();
    if (availability.status !== "ready") return null;

    /*
     * The moment chips move. Everything up to here — queueing, matching, being
     * seated in the lobby — costs nothing, which is why this is a separate,
     * deliberate step rather than a side effect of finding a table.
     */
    const result = await bounded(
      availability.client.functions.invoke("create-session", {
        body: {
          action: "JOIN_PUBLIC_TABLE",
          clientRequestId: globalThis.crypto.randomUUID(),
          roomId: current.place.roomId,
          clientSentAt: new Date().toISOString(),
        },
      }),
    );
    if (result === null) {
      set({ notice: UNREACHABLE });
      return null;
    }
    if (result.error) {
      /*
       * Which refusal it is matters. "Nothing has been charged" is true of
       * every one of them, but it is USEFUL advice only when the seat is
       * genuinely still available — and the refusal this most often is says the
       * opposite: the player's chips are already in escrow at another table, so
       * telling them to try again sends them somewhere that will refuse them
       * for ever. That state was reachable, and paid twice, until the server
       * grew the guard that produces this code.
       */
      const rejection = await readRejection(result.error);
      if (rejection?.code === "SESSION_ALREADY_ACTIVE") {
        set({ status: { kind: "idle" }, notice: SEATED_ELSEWHERE });
        return null;
      }
      set({ notice: rejection?.message ?? "That seat could not be taken. Nothing has been charged." });
      return null;
    }

    const data = result.data as { gameId?: unknown; seatId?: unknown } | null;
    if (typeof data?.gameId !== "string" || typeof data.seatId !== "string") {
      // The seat may well have been taken; only the echo is unreadable. Say so
      // rather than reporting a failure that would invite a second attempt.
      set({ notice: "Your seat was taken, but the reply could not be read. Reopen Public Table." });
      return null;
    }

    /*
     * The header caches the balance for the life of the session — it is fetched
     * once, keyed on sign-in, so that switching tabs does not re-read the
     * wallet. That is right until chips actually move, and this is the line
     * where they do: without it the header kept showing the pre-buy-in number,
     * so a player who bought in for 2,000 saw their old balance until the next
     * launch.
     */
    void useWalletStore.getState().refresh();

    set({ status: { kind: "idle" }, notice: null });
    return { gameId: data.gameId, seatId: data.seatId };
  },

  cancel: async () => {
    const availability = getSupabase();
    if (availability.status === "ready") {
      await bounded(availability.client.rpc("leave_matchmaking"));
    }
    // Left locally whatever the server said: the player asked to stop, and no
    // chips are at stake while merely queued.
    set({ status: { kind: "idle" }, notice: null });
  },
}));
