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

const UNREACHABLE = "Could not reach the daily challenge. Nothing has been recorded.";
const SIGNED_OUT =
  "The daily challenge needs an account, because everyone plays the same server-held shoe. Practice stays available without one.";

async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
  const result = await withTimeout(Promise.resolve(work), undefined);
  return isTimedOut(result) ? null : result;
}

export const useDailyStore = create<DailyStoreState>((set) => ({
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
    const attempt =
      attemptResult && !attemptResult.error ? toAttempt(attemptResult.data) : null;

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
    const availability = getSupabase();
    if (availability.status !== "ready") return null;

    set({ starting: true, notice: null });
    const result = await bounded(
      availability.client.functions.invoke("create-session", {
        body: {
          action: "START_DAILY_CHALLENGE",
          clientRequestId: globalThis.crypto.randomUUID(),
          clientSentAt: new Date().toISOString(),
        },
      }),
    );
    set({ starting: false });

    if (result === null) {
      set({ notice: UNREACHABLE });
      return null;
    }
    if (result.error) {
      set({ notice: "The challenge could not be opened. Nothing has been recorded." });
      return null;
    }

    const data = result.data as
      | { gameId?: unknown; seatId?: unknown; ranked?: unknown }
      | null;
    if (typeof data?.gameId !== "string" || typeof data.seatId !== "string") {
      set({ notice: "The challenge opened, but the reply could not be read. Reopen this screen." });
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
