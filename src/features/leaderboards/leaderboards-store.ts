/**
 * Leaderboards, as client state.
 *
 * One board at a time, because that is how the screen shows them and fetching
 * four to display one would be four times the work for no benefit. Switching
 * category refetches; nothing is cached across a switch, so a board is never a
 * stale copy of a different week.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import {
  toEntries,
  toPosition,
  type LeaderboardCategory,
  type LeaderboardEntry,
  type LeaderboardPosition,
} from "./leaderboards.js";

export type LeaderboardStatus =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly category: LeaderboardCategory;
      readonly entries: readonly LeaderboardEntry[];
      /** Null when the player is not ranked on this board at all. */
      readonly position: LeaderboardPosition | null;
    }
  | { readonly kind: "unavailable"; readonly message: string };

export interface StrategyProgress {
  readonly decisionsTotal: number;
  readonly minimumRequired: number;
  readonly qualified: boolean;
}

export interface LeaderboardStoreState {
  readonly status: LeaderboardStatus;
  readonly category: LeaderboardCategory;
  /** Only meaningful on the accuracy board; null elsewhere. */
  readonly strategyProgress: StrategyProgress | null;

  select: (category: LeaderboardCategory) => Promise<void>;
}

const UNREACHABLE = "Could not reach the leaderboards.";
const SIGNED_OUT =
  "Leaderboards need an account, because every figure on them is server-recorded. Practice stays available without one.";

/** The specification's "Top 100". */
const TOP = 100;

async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
  const result = await withTimeout(Promise.resolve(work), undefined);
  return isTimedOut(result) ? null : result;
}

const RPC_FOR: Record<LeaderboardCategory, "leaderboard_weekly_xp" | "leaderboard_tournament_wins" | "leaderboard_strategy_accuracy" | "leaderboard_daily_challenge"> = {
  weekly_xp: "leaderboard_weekly_xp",
  tournament_wins: "leaderboard_tournament_wins",
  strategy_accuracy: "leaderboard_strategy_accuracy",
  daily_challenge: "leaderboard_daily_challenge",
};

export const useLeaderboardStore = create<LeaderboardStoreState>((set) => ({
  status: { kind: "loading" },
  category: "weekly_xp",
  strategyProgress: null,

  select: async (category) => {
    set({ category, status: { kind: "loading" }, strategyProgress: null });

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

    const board = await bounded(
      availability.client.rpc(RPC_FOR[category], { p_limit: TOP }),
    );
    if (board === null || board.error) {
      set({ status: { kind: "unavailable", message: UNREACHABLE } });
      return;
    }
    const entries = toEntries(board.data);

    // The player's own place, which the top 100 cannot show them if they are not
    // in it. A failure here is not a failure of the board.
    const own = await bounded(
      availability.client.rpc("my_leaderboard_position", { p_category: category }),
    );
    const position = own && !own.error ? toPosition(own.data) : null;

    // On the accuracy board, someone who has not played 100 decisions is absent
    // from it by design. Telling them how many they still need is more use than
    // an empty list.
    let strategyProgress: StrategyProgress | null = null;
    if (category === "strategy_accuracy") {
      const progress = await bounded(
        availability.client.rpc("my_strategy_accuracy_progress"),
      );
      if (progress && !progress.error) {
        const row = Array.isArray(progress.data) ? progress.data[0] : progress.data;
        const parsed = row as
          | { decisions_total?: unknown; minimum_required?: unknown; qualified?: unknown }
          | null;
        if (
          typeof parsed?.decisions_total === "number" &&
          typeof parsed.minimum_required === "number"
        ) {
          strategyProgress = {
            decisionsTotal: parsed.decisions_total,
            minimumRequired: parsed.minimum_required,
            qualified: parsed.qualified === true,
          };
        }
      }
    }

    set({ status: { kind: "ready", category, entries, position }, strategyProgress });
  },
}));
