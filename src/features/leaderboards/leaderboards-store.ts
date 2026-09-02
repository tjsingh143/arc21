/**
 * Leaderboards, as client state.
 *
 * One board at a time, because that is how the screen shows them and fetching
 * four to display one would be four times the work for no benefit. Switching
 * category refetches; nothing is cached across a switch, so a board is never a
 * stale copy of a different week.
 *
 * PAGED, a page at a time. The server takes an offset as well as a limit and
 * orders on a total key, so a rank shared by two players cannot put one of them
 * on two pages and the other on none. `select` starts at the top; `more`
 * appends the next page and is a no-op once the board has run out.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import {
  nextPageRequest,
  PAGE_SIZE,
  pageWasLast,
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
      /** Whether another page exists. False once a short page came back. */
      readonly hasMore: boolean;
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
  /** True while a further page is being fetched. */
  readonly loadingMore: boolean;

  select: (category: LeaderboardCategory) => Promise<void>;
  /** Appends the next page. Does nothing when there is not one. */
  more: () => Promise<void>;
}

const UNREACHABLE = "Could not reach the leaderboards.";
const SIGNED_OUT =
  "Leaderboards need an account, because every figure on them is server-recorded. Practice stays available without one.";

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

export const useLeaderboardStore = create<LeaderboardStoreState>((set, get) => ({
  status: { kind: "loading" },
  category: "weekly_xp",
  strategyProgress: null,
  loadingMore: false,

  select: async (category) => {
    set({ category, status: { kind: "loading" }, strategyProgress: null, loadingMore: false });

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
      availability.client.rpc(RPC_FOR[category], { p_limit: PAGE_SIZE, p_offset: 0 }),
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

    set({
      status: {
        kind: "ready",
        category,
        entries,
        position,
        hasMore: !pageWasLast(entries.length),
      },
      strategyProgress,
    });
  },

  more: async () => {
    const current = get().status;
    if (current.kind !== "ready") return;

    // The control's own predicate, shared with the screen and tested on its own.
    const request = nextPageRequest({
      loaded: current.entries.length,
      hasMore: current.hasMore,
      busy: get().loadingMore,
    });
    if (!request) return;

    const availability = getSupabase();
    if (availability.status !== "ready") return;

    set({ loadingMore: true });
    const page = await bounded(
      availability.client.rpc(RPC_FOR[current.category], {
        p_limit: request.limit,
        p_offset: request.offset,
      }),
    );
    set({ loadingMore: false });

    // A page that could not be read leaves the board exactly as it was. The
    // rows already on screen are still true, and "Load more" is still there.
    if (page === null || page.error) return;

    const next = toEntries(page.data);
    const latest = get().status;
    // The category may have changed while this was in flight; appending a page
    // of weekly XP to the accuracy board would be worse than dropping it.
    if (latest.kind !== "ready" || latest.category !== current.category) return;

    set({
      status: {
        ...latest,
        entries: [...latest.entries, ...next],
        hasMore: !pageWasLast(next.length),
      },
    });
  },
}));
