/**
 * The Sprint Tournament, as client state.
 *
 * Registering costs 500 chips, so this store keeps two things straight that are
 * easy to blur: the format a player is shown before they commit, and what they
 * are actually entered in afterwards. It never claims a fee was taken — the
 * server reports what it debited, including zero on a retry — and it never
 * invents a standing.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import {
  toEntry,
  toFormat,
  toStandings,
  type SprintEntry,
  type SprintFormat,
  type SprintStanding,
} from "./tournament.js";

export type TournamentStatus =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly format: SprintFormat;
      readonly entry: SprintEntry | null;
      readonly standings: readonly SprintStanding[];
      /**
       * True when nobody is signed in.
       *
       * The format is still shown — the specification requires a player to know
       * it before spending an entry fee, and someone deciding whether to make an
       * account is exactly who needs to read it — but entering is not offered,
       * and the screen says why rather than presenting a button that cannot work.
       */
      readonly signedOut: boolean;
    }
  | { readonly kind: "unavailable"; readonly message: string };

export interface TournamentStoreState {
  readonly status: TournamentStatus;
  readonly notice: string | null;
  readonly registering: boolean;
  readonly withdrawing: boolean;

  load: () => Promise<void>;
  register: () => Promise<void>;
  /**
   * Give up an entry that has not been dealt, and take the 500 chips back.
   *
   * The other half of `register`. Without it a player whose three companions
   * never arrived was locked to that tournament permanently — the fee spent and
   * every other online mode refusing them — because registration returns the
   * SAME entry to anybody already in one.
   */
  withdraw: () => Promise<void>;
  /** The table to open, once the field has filled. */
  seatToOpen: () => { gameId: string } | null;
}

const UNREACHABLE = "Could not reach the tournament. Nothing has been charged.";
/**
 * The server refused the withdrawal, and the only reason it does is that the
 * cards are already out — a player cannot buy out of a tournament they are
 * losing. Stated as the reason rather than as a failure.
 */
const WITHDRAW_REFUSED =
  "The tournament has already been dealt, so the entry stands. It finishes after twelve hands.";
/**
 * The other refusal, and it is a different sentence.
 *
 * `WITHDRAW_SPRINT` refuses for exactly two reasons: the cards are already out,
 * or there is no entry to give up. Which one it was is decided by RELOADING and
 * looking, rather than by parsing an error body — the reload has to happen
 * anyway, and its answer is the authoritative one. Telling a player whose entry
 * had already expired that "the tournament has been dealt" would send them
 * looking for a table that does not exist.
 */
const WITHDRAW_NOTHING_TO_LEAVE = "You were not in a tournament, so nothing was refunded.";
const SIGNED_OUT =
  "Tournaments need an account, because the entry fee and the prizes are real chips. Practice stays available without one.";

async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
  const result = await withTimeout(Promise.resolve(work), undefined);
  return isTimedOut(result) ? null : result;
}

export const useTournamentStore = create<TournamentStoreState>((set, get) => ({
  status: { kind: "loading" },
  notice: null,
  registering: false,
  withdrawing: false,

  load: async () => {
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
    const signedOut = !session.data.session;

    // Read FIRST, and before the sign-in question: `sprint_format` is granted to
    // `anon` too, because the format is published configuration and a guest
    // deciding whether to make an account is the person who most needs to see it.
    const formatResult = await bounded(availability.client.rpc("sprint_format"));
    if (formatResult === null || formatResult.error) {
      set({ status: { kind: "unavailable", message: UNREACHABLE } });
      return;
    }
    const format = toFormat(formatResult.data);
    if (!format) {
      set({
        status: {
          kind: "unavailable",
          message: "The tournament sent a format this app could not read.",
        },
      });
      return;
    }

    if (signedOut) {
      // The format, and an honest reason entering is not offered. No entry and
      // no standings exist to read without an account.
      set({
        status: { kind: "ready", format, entry: null, standings: [], signedOut: true },
        notice: SIGNED_OUT,
      });
      return;
    }

    const entryResult = await bounded(availability.client.rpc("my_sprint_entry"));
    const entry = entryResult && !entryResult.error ? toEntry(entryResult.data) : null;

    let standings: SprintStanding[] = [];
    if (entry) {
      const standingsResult = await bounded(
        availability.client.rpc("sprint_standings", { p_tournament_id: entry.tournament_id }),
      );
      if (standingsResult && !standingsResult.error) {
        standings = toStandings(standingsResult.data);
      }
    }

    /*
     * THE NOTICE IS NOT CLEARED HERE, and that is the whole of a defect this
     * screen carried until a device run found it.
     *
     * `register` and `withdraw` both finish by reloading — they have to, because
     * what the player now holds is the server's answer, not theirs — and this
     * line used to set `notice: null`. So every message either of them produced
     * was destroyed a few milliseconds after it was written: the refund
     * sentence, and "You were already entered. No second fee was taken." Both
     * were correct, both were unreachable, and nothing failed. Found by
     * asserting the RESULT on a screen rather than the tap.
     *
     * A stale notice cannot accumulate: both actions clear it when they START,
     * and the only notice `load` owns is the signed-out one, which is cleared
     * below the moment an account appears.
     */
    set((current) => ({
      status: { kind: "ready", format, entry, standings, signedOut: false },
      notice: current.notice === SIGNED_OUT ? null : current.notice,
    }));
  },

  register: async () => {
    const availability = getSupabase();
    if (availability.status !== "ready") return;

    set({ registering: true, notice: null });
    const result = await bounded(
      availability.client.functions.invoke("create-session", {
        body: {
          action: "REGISTER_SPRINT",
          clientRequestId: globalThis.crypto.randomUUID(),
          clientSentAt: new Date().toISOString(),
        },
      }),
    );
    set({ registering: false });

    if (result === null) {
      set({ notice: UNREACHABLE });
      return;
    }
    if (result.error) {
      // The server's own refusal is the useful one — "the entry fee would
      // overdraw the wallet" says more than any wording invented here.
      set({ notice: "You were not entered. Nothing has been charged." });
      return;
    }

    const data = result.data as { entryFee?: unknown } | null;
    await get().load();
    if (typeof data?.entryFee === "number" && data.entryFee === 0) {
      // A retry landing on an entry already paid for. Said plainly, because
      // "entered" with no visible charge otherwise reads as a bug — and AFTER
      // the reload, so the reload cannot be the thing that hides it.
      set({ notice: "You were already entered. No second fee was taken." });
    }
  },

  withdraw: async () => {
    const availability = getSupabase();
    if (availability.status !== "ready") return;

    set({ withdrawing: true, notice: null });
    const result = await bounded(
      availability.client.functions.invoke("create-session", {
        body: {
          action: "WITHDRAW_SPRINT",
          clientRequestId: globalThis.crypto.randomUUID(),
          clientSentAt: new Date().toISOString(),
        },
      }),
    );
    set({ withdrawing: false });

    if (result === null) {
      // Unreachable, not refused: the entry may or may not still stand, and the
      // reload below is what finds out. Saying "nothing has been charged" here
      // would be a claim about a request whose fate is unknown.
      set({ notice: "Could not reach the tournament. Your entry has not changed." });
      await get().load();
      return;
    }
    if (result.error) {
      // Reload FIRST: which refusal this was is a question about what the player
      // still holds, and the reload is the only thing that knows.
      await get().load();
      const current = get().status;
      const stillEntered = current.kind === "ready" && current.entry !== null;
      set({ notice: stillEntered ? WITHDRAW_REFUSED : WITHDRAW_NOTHING_TO_LEAVE });
      return;
    }

    const data = result.data as { refundChips?: unknown } | null;
    await get().load();
    set({
      notice:
        typeof data?.refundChips === "number" && data.refundChips > 0
          ? `Your entry fee of ${data.refundChips} chips is back in your balance.`
          : // A replay of a withdrawal already made. Said plainly, because a
            // silent second "refunded" would read as two refunds.
            "You had already left. No second refund was made.",
    });
  },

  seatToOpen: () => {
    const current = get().status;
    if (current.kind !== "ready" || !current.entry?.game_session_id) return null;
    return { gameId: current.entry.game_session_id };
  },
}));
