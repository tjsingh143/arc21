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

  load: () => Promise<void>;
  register: () => Promise<void>;
  /** The table to open, once the field has filled. */
  seatToOpen: () => { gameId: string } | null;
}

const UNREACHABLE = "Could not reach the tournament. Nothing has been charged.";
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

    set({ status: { kind: "ready", format, entry, standings, signedOut: false }, notice: null });
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
    if (typeof data?.entryFee === "number" && data.entryFee === 0) {
      // A retry landing on an entry already paid for. Said plainly, because
      // "entered" with no visible charge otherwise reads as a bug.
      set({ notice: "You were already entered. No second fee was taken." });
    }

    await get().load();
  },

  seatToOpen: () => {
    const current = get().status;
    if (current.kind !== "ready" || !current.entry?.game_session_id) return null;
    return { gameId: current.entry.game_session_id };
  },
}));
