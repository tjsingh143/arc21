import { playerScopedSetter } from "../player/player-scope.js";
/**
 * The Competition section of Statistics, read from the server.
 *
 * `competition.ts` decides what the section MAY show; this fetches the record
 * it decides about. Until now there was nothing to fetch: the screen passed
 * `competitionState({ hasAccount: false, online: false })` with both values
 * written as literals, so every signed-in player was told their tournament and
 * daily-challenge records "require an account" — which they have.
 *
 * The same defect the Profile screen had, and its header documents the shape:
 * `hasAccount` was written when there genuinely was no sign-in and was never
 * revisited once accounts shipped.
 *
 * Nothing is computed here. `my_competition_record()` derives all five numbers
 * from `auth.uid()` server-side, using the daily board's own ranking for "best
 * rank" so the two cannot disagree.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import { confirmedSession } from "../../lib/supabase/player-binding.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import type { CompetitionRecord } from "./competition.js";

export interface CompetitionStoreState {
  /**
   * Null until a signed-in player's record has been read.
   *
   * Null is what makes the section say "not available" rather than draw five
   * zeros — a zero is a value, and a value nobody earned is a fabrication
   * however small. The same rule `level-store.ts` follows.
   */
  readonly record: CompetitionRecord | null;
  readonly loading: boolean;
  readonly loaded: boolean;
  /** False when the last attempt could not reach the server. */
  readonly online: boolean;

  load: () => Promise<void>;
  clear: () => void;
}

function toRecord(value: unknown): CompetitionRecord | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (typeof row !== "object" || row === null) return null;
  const candidate = row as Record<string, unknown>;
  const int = (key: string): number =>
    typeof candidate[key] === "number" ? (candidate[key] as number) : 0;
  const maybe = (key: string): number | null =>
    typeof candidate[key] === "number" ? (candidate[key] as number) : null;

  return {
    tournamentsEntered: int("tournaments_entered"),
    tournamentWins: int("tournament_wins"),
    bestFinish: maybe("best_finish"),
    dailyChallengesPlayed: int("daily_challenges_played"),
    dailyChallengeBestRank: maybe("daily_challenge_best_rank"),
  };
}

export const useCompetitionStore = create<CompetitionStoreState>((set) => ({
  record: null,
  loading: false,
  loaded: false,
  online: false,

  load: async () => {
    const setForPlayer = playerScopedSetter(set);
    const availability = getSupabase();
    if (availability.status !== "ready") {
      setForPlayer({ record: null, loading: false, loaded: true, online: false });
      return;
    }

    setForPlayer({ loading: true });
    const session = await withTimeout(
      Promise.resolve(confirmedSession(availability.client)),
      undefined,
    );
    if (isTimedOut(session)) {
      setForPlayer({ loading: false, loaded: true, online: false });
      return;
    }
    if (!session.data.session) {
      // Not an error and not offline: a guest has no server record, and the
      // section says so through `NO_ACCOUNT`.
      setForPlayer({ record: null, loading: false, loaded: true, online: true });
      return;
    }

    const result = await withTimeout(
      Promise.resolve(availability.client.rpc("my_competition_record")),
      undefined,
    );
    if (isTimedOut(result)) {
      setForPlayer({ loading: false, loaded: true, online: false });
      return;
    }
    if (result.error) {
      // Reached the server and it refused. Reporting that as offline would put
      // a "you are offline" message in front of a player who is not.
      setForPlayer({ loading: false, loaded: true, online: true });
      return;
    }

    setForPlayer({ record: toRecord(result.data), loading: false, loaded: true, online: true });
  },

  clear: () => set({ record: null, loading: false, loaded: false, online: false }),
}));
