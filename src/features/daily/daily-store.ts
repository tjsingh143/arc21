/**
 * Today's Daily Challenge, as client state.
 *
 * The one thing this store must never do is imply a score it does not have.
 * Whether an attempt is ranked is the server's answer, carried back from
 * `START_DAILY_CHALLENGE`, not something inferred here from the presence of a
 * row — a client that guessed wrong would tell a player their run counted when
 * it did not.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import { sendSessionIntent } from "../../lib/supabase/session-intent.js";
import { useActiveSessionStore } from "../table/active-session-store.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import {
  toAttempt,
  toChallenge,
  toVerification,
  type Attempt,
  type Challenge,
  type Verification,
} from "./daily.js";

export type DailyStatus =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly challenge: Challenge;
      readonly attempt: Attempt | null;
      /**
       * The most recent challenge whose seed has been PUBLISHED, so the
       * commitment can actually be checked. Null until one has closed.
       */
      readonly verification: Verification | null;
    }
  | { readonly kind: "unavailable"; readonly message: string };

export interface DailyStoreState {
  readonly status: DailyStatus;
  readonly notice: string | null;
  readonly starting: boolean;

  load: () => Promise<void>;
  /** Opens the attempt and returns what the table screen needs, or null. */
  start: () => Promise<{ gameId: string; seatId: string; ranked: boolean } | null>;
}

const UNREACHABLE = "Could not confirm the challenge. Reconnect to check today's attempt and return to any active table from Play.";
const SIGNED_OUT =
  "The daily challenge needs an account, because everyone plays the same server-held shoe. Practice stays available without one.";

async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
  const result = await withTimeout(Promise.resolve(work), undefined);
  return isTimedOut(result) ? null : result;
}

export const useDailyStore = create<DailyStoreState>((set, get) => ({
  status: { kind: "loading" },
  notice: null,
  starting: false,

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
    if (!session.data.session) {
      set({ status: { kind: "unavailable", message: SIGNED_OUT } });
      return;
    }

    // Creates today's row if this is the first look at it, so the screen is never
    // empty waiting for a scheduler that has not run.
    const challengeResult = await bounded(
      availability.client.rpc("ensure_todays_daily_challenge"),
    );
    if (challengeResult === null || challengeResult.error) {
      set({ status: { kind: "unavailable", message: UNREACHABLE } });
      return;
    }

    const challenge = toChallenge(challengeResult.data);
    if (!challenge) {
      set({
        status: {
          kind: "unavailable",
          message: "The daily challenge sent something this app could not read.",
        },
      });
      return;
    }

    const attemptResult = await bounded(availability.client.rpc("my_daily_entry"));
    if (attemptResult === null || attemptResult.error) {
      set({ status: { kind: "unavailable", message: UNREACHABLE } });
      return;
    }
    const attempt = toAttempt(attemptResult.data);
    // Only an explicitly empty result proves there is no ranked entry. A
    // malformed row (or one from a different day) is an unreadable history.
    const empty = Array.isArray(attemptResult.data) && attemptResult.data.length === 0;
    if ((!attempt && !empty) || (attempt && attempt.challengeId !== challenge.id)) {
      set({ status: { kind: "unavailable", message: UNREACHABLE } });
      return;
    }

    /*
     * The audit half of the commitment scheme.
     *
     * TODAY's seed is secret by design, so a fairness view that only ever looked
     * at today could never show anything — which is precisely what happened for
     * the whole life of the feature: the column, the trigger, the projection,
     * the parser and the render branch all existed and nothing ever published a
     * seed. `ensure_todays_daily_challenge` publishes every closed one as its
     * first act, so this is the row the player can actually check.
     *
     * A failure here does not fail the screen. Today's challenge is still
     * playable when yesterday's seed cannot be read.
     */
    const verificationResult = await bounded(
      availability.client.rpc("latest_verifiable_daily_challenge"),
    );
    const verification =
      verificationResult && !verificationResult.error
        ? toVerification(verificationResult.data)
        : null;

    set({ status: { kind: "ready", challenge, attempt, verification }, notice: null });
  },

  start: async () => {
    if (get().starting) return null;
    const availability = getSupabase();
    if (availability.status !== "ready") return null;

    set({ starting: true, notice: null });
    const result = await sendSessionIntent(availability.client, { action: "START_DAILY_CHALLENGE" });
    set({ starting: false });

    if (result.kind === "unknown") {
      await Promise.all([get().load(), useActiveSessionStore.getState().refresh()]);
      set({ notice: UNREACHABLE });
      return null;
    }
    if (result.kind === "rejected") {
      set({ notice: result.rejection.message });
      return null;
    }

    const data = result.data as
      | { gameId?: unknown; seatId?: unknown; ranked?: unknown }
      | null;
    if (typeof data?.gameId !== "string" || typeof data.seatId !== "string" || typeof data.ranked !== "boolean") {
      await Promise.all([get().load(), useActiveSessionStore.getState().refresh()]);
      set({ notice: UNREACHABLE });
      return null;
    }

    return {
      gameId: data.gameId,
      seatId: data.seatId,
      // The server's answer, never this layer's guess.
      ranked: data.ranked === true,
    };
  },
}));
