import { playerScopedSetter } from "../player/player-scope.js";
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
 *
 * Every queue RPC is BOUND to the player who asked (`player-binding.ts`). None
 * of them names a player — `leave_matchmaking()` takes nothing at all — so the
 * actor is whoever's JWT the request carries, and an unbound request carries
 * whoever is signed in when it leaves. The Refresh-B audit (B-R1) held player
 * A's cancel across a real sign-in to B and B's live search was cancelled while
 * A's stayed waiting. `poll_matchmaking` is bound too: it can allocate a room,
 * so it is a write, not a read.
 */

import { create, type StoreApi } from "zustand";

import { getSupabase, type ArcSupabaseClient } from "../../lib/supabase/client.js";
import { bindCurrentPlayer, sentAs, type BoundPlayer } from "../../lib/supabase/player-binding.js";
import { sendSessionIntent } from "../../lib/supabase/session-intent.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import {
  OFFER_ALTERNATIVES_AFTER_MS,
  toQueuePlace,
  type QueuePlace,
  type TierId,
} from "./matchmaking.js";
import { useWalletStore } from "../wallet/wallet-store.js";
import { useActiveSessionStore } from "../table/active-session-store.js";

export type MatchmakingStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "queued"; readonly place: QueuePlace }
  | { readonly kind: "matched"; readonly place: QueuePlace }
  | { readonly kind: "unavailable"; readonly message: string };

export interface MatchmakingStoreState {
  readonly status: MatchmakingStatus;
  readonly notice: string | null;
  /**
   * Until when the player has said they are happy to keep waiting.
   *
   * "Keep Waiting" is one of the three controls the specification asks for
   * after about twenty seconds, and it needs somewhere to be recorded: the wait
   * itself is the server's `enqueued_at` and never resets, so without this the
   * offer would come straight back on the next two-second tick and the button
   * would read as broken. Null means nothing has been acknowledged.
   */
  readonly keepWaitingUntil: Date | null;

  queue: (tier: TierId) => Promise<void>;
  /**
   * "Keep Waiting" — hold this search open for another window.
   *
   * Re-enrols as well as snoozing, because a queue entry expires after five
   * minutes and a player who has explicitly asked to keep waiting must not be
   * quietly dropped. `join_matchmaking` returns the existing entry when one is
   * live, so the ordinary case costs nothing and is not rate-limited.
   */
  keepWaiting: () => Promise<void>;
  /**
   * Take the matched seat, which is when the buy-in is actually charged.
   * Returns the ids the table screen needs, or null if the seat was refused.
   */
  takeSeat: () => Promise<{ gameId: string; seatId: string } | null>;
  poll: () => Promise<void>;
  cancel: () => Promise<void>;
}

const UNREACHABLE = "Could not reach matchmaking. Check your connection and try again.";
const SEAT_UNCONFIRMED = "Could not confirm your seat. Check your balance and return to any active table from Play before trying again.";
const SIGNED_OUT = "Connect for public tables. Your player identity is created automatically; Practice works offline.";
/*
 * "Leave that table first" was advice the player could not act on: the game id
 * reached the client once, in the reply to the join being refused here, and
 * nothing persisted it or asked for it back. `Play` now offers the way back —
 * `my_active_session()` names the table — so this says where to find it.
 */
const SEATED_ELSEWHERE =
  "You are already seated at a table, and your chips are there. Return to it from Play — nothing has been charged for this one.";

/**
 * PostgREST maps SQLSTATE `PTnnn` to HTTP nnn, so `join_matchmaking` raising
 * `PT409` is the one refusal the queue can tell apart from every other. It used
 * to raise `P0001`, which arrives as a lowercase sentence with no code — so the
 * screen printed the server's own words and offered nothing to do about them,
 * one step before `takeSeat` names the way back for the very same condition.
 */
const ALREADY_SEATED_CODE = "PT409";

async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
  const result = await withTimeout(Promise.resolve(work), undefined);
  return isTimedOut(result) ? null : result;
}

/**
 * One poll, sent as the player the caller bound — shared by `poll` and by
 * `queue`'s follow-up, so a search is read back as the player who started it.
 */
async function pollAs(
  client: ArcSupabaseClient,
  player: BoundPlayer,
  setForPlayer: StoreApi<MatchmakingStoreState>["setState"],
): Promise<void> {
  if (!player.isCurrent()) return;
  const result = await bounded(sentAs(client.rpc("poll_matchmaking"), player));
  if (result === null || result.error) return;

  const place = toQueuePlace(result.data);
  if (!place) {
    // No row means no live search. Not an error — the player may have
    // cancelled on another device.
    setForPlayer({ status: { kind: "idle" } });
    return;
  }

  if (place.status === "matched") {
    setForPlayer({ status: { kind: "matched", place }, notice: null });
    return;
  }
  if (place.status === "waiting") {
    setForPlayer({ status: { kind: "queued", place }, notice: null });
    return;
  }
  setForPlayer({ status: { kind: "idle" }, notice: null });
}

export const useMatchmakingStore = create<MatchmakingStoreState>((set, get) => ({
  status: { kind: "idle" },
  notice: null,
  keepWaitingUntil: null,

  queue: async (tier) => {
    const setForPlayer = playerScopedSetter(set);
    const availability = getSupabase();
    if (availability.status !== "ready") {
      setForPlayer({ status: { kind: "unavailable", message: availability.message } });
      return;
    }

    const bound = await bindCurrentPlayer(availability.client);
    if (!bound.ok) {
      // A changed player has already had this screen cleared: nothing to say.
      if (bound.reason !== "identity-changed") {
        setForPlayer({
          status: { kind: "unavailable", message: bound.reason === "signed-out" ? SIGNED_OUT : UNREACHABLE },
        });
      }
      return;
    }

    if (!bound.player.isCurrent()) return;
    const result = await bounded(
      sentAs(availability.client.rpc("join_matchmaking", { p_tier: tier }), bound.player),
    );
    if (result === null) {
      setForPlayer({ status: { kind: "unavailable", message: UNREACHABLE } });
      return;
    }
    if (result.error) {
      if (result.error.code === ALREADY_SEATED_CODE) {
        setForPlayer({ status: { kind: "idle" }, notice: SEATED_ELSEWHERE });
        return;
      }
      // Otherwise the server's own wording — "the high table unlocks at level
      // 10" — is more useful than anything this layer could infer.
      setForPlayer({ notice: result.error.message });
      return;
    }

    // Read back as the same player, with the same credential.
    await pollAs(availability.client, bound.player, setForPlayer);
  },

  keepWaiting: async () => {
    const setForPlayer = playerScopedSetter(set);
    const current = get().status;
    setForPlayer({ keepWaitingUntil: new Date(Date.now() + OFFER_ALTERNATIVES_AFTER_MS) });
    if (current.kind !== "queued") return;
    await get().queue(current.place.tier);
  },

  poll: async () => {
    const setForPlayer = playerScopedSetter(set);
    const availability = getSupabase();
    if (availability.status !== "ready") return;

    // Bound like the writes: a poll can allocate a room.
    const bound = await bindCurrentPlayer(availability.client);
    if (!bound.ok) return;
    await pollAs(availability.client, bound.player, setForPlayer);
  },

  takeSeat: async () => {
    const setForPlayer = playerScopedSetter(set);
    const current = get().status;
    if (current.kind !== "matched" || !current.place.roomId) return null;

    const availability = getSupabase();
    if (availability.status !== "ready") return null;

    /*
     * The moment chips move. Everything up to here — queueing, matching, being
     * seated in the lobby — costs nothing, which is why this is a separate,
     * deliberate step rather than a side effect of finding a table.
     */
    const result = await sendSessionIntent(availability.client, {
      action: "JOIN_PUBLIC_TABLE",
      roomId: current.place.roomId,
    });
    if (!setForPlayer.isCurrent()) return null;
    if (result.kind === "unknown") {
      setForPlayer({ notice: SEAT_UNCONFIRMED });
      await Promise.all([useWalletStore.getState().refresh(), useActiveSessionStore.getState().refresh()]);
      return null;
    }
    if (result.kind === "rejected") {
      /*
       * Which refusal it is matters. "Nothing has been charged" is true of
       * every one of them, but it is USEFUL advice only when the seat is
       * genuinely still available — and the refusal this most often is says the
       * opposite: the player's chips are already in escrow at another table, so
       * telling them to try again sends them somewhere that will refuse them
       * for ever. That state was reachable, and paid twice, until the server
       * grew the guard that produces this code.
       */
      const rejection = result.rejection;
      if (rejection?.code === "SESSION_ALREADY_ACTIVE") {
        setForPlayer({ status: { kind: "idle" }, notice: SEATED_ELSEWHERE });
        return null;
      }
      /*
       * The table filled, or closed, between being matched and this tap. That
       * is now REACHABLE rather than theoretical: a public table keeps taking
       * players while it has room, so a seat can genuinely go to somebody who
       * tapped first. Dropping back to `idle` is the useful answer — it puts
       * the stakes back on screen so the next tap starts a fresh search,
       * instead of leaving a "Take the seat" button aimed at a table that has
       * none.
       */
      if (rejection?.code === "TABLE_FULL" || rejection?.code === "SESSION_CLOSED") {
        setForPlayer({ status: { kind: "idle" }, notice: rejection.message });
        return null;
      }
      setForPlayer({ notice: rejection?.message ?? "That seat could not be taken. Nothing has been charged." });
      return null;
    }

    const data = result.data as { gameId?: unknown; seatId?: unknown } | null;
    if (typeof data?.gameId !== "string" || typeof data.seatId !== "string") {
      // The seat may well have been taken; only the echo is unreadable. Say so
      // rather than reporting a failure that would invite a second attempt.
      setForPlayer({ notice: "Your seat was taken, but the reply could not be read. Reopen Public Table." });
      await Promise.all([useWalletStore.getState().refresh(), useActiveSessionStore.getState().refresh()]);
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

    setForPlayer({ status: { kind: "idle" }, notice: null, keepWaitingUntil: null });
    return { gameId: data.gameId, seatId: data.seatId };
  },

  cancel: async () => {
    const setForPlayer = playerScopedSetter(set);
    const availability = getSupabase();
    if (availability.status === "ready") {
      // `leave_matchmaking()` names nobody. It is sent only as the player who
      // asked to stop, and not at all once that player has been replaced.
      const bound = await bindCurrentPlayer(availability.client);
      if (bound.ok && bound.player.isCurrent()) {
        await bounded(sentAs(availability.client.rpc("leave_matchmaking"), bound.player));
      }
    }
    // Left locally whatever the server said: the player asked to stop, and no
    // chips are at stake while merely queued.
    setForPlayer({ status: { kind: "idle" }, notice: null, keepWaitingUntil: null });
  },
}));
