/**
 * Reading a leaderboard.
 *
 * Every board comes back in the same shape and none of them carries an account
 * identifier — the server's projection has no user id and no email in it, so
 * there is nothing here to leak by rendering the wrong field.
 *
 * The value means something different per board, so it is formatted per board
 * rather than printed raw: accuracy arrives in basis points and 8734 is 87.34%,
 * not eight thousand of anything.
 */

import { z } from "zod";

export const LEADERBOARD_CATEGORIES = [
  "weekly_xp",
  "tournament_wins",
  "strategy_accuracy",
  "daily_challenge",
] as const;

export type LeaderboardCategory = (typeof LEADERBOARD_CATEGORIES)[number];

export const rowSchema = z.object({
  rank: z.number().int().positive(),
  display_name: z.string(),
  avatar_asset_key: z.string().nullable(),
  value: z.number().int(),
  detail: z.string().nullable(),
  is_you: z.boolean(),
});

export const positionSchema = z.object({
  rank: z.number().int().positive(),
  value: z.number().int(),
  detail: z.string().nullable(),
  total_ranked: z.number().int().nonnegative(),
});

export type LeaderboardEntry = z.infer<typeof rowSchema>;
export type LeaderboardPosition = z.infer<typeof positionSchema>;

export function toEntries(value: unknown): LeaderboardEntry[] {
  if (!Array.isArray(value)) return [];
  const rows: LeaderboardEntry[] = [];
  for (const candidate of value) {
    const parsed = rowSchema.safeParse(candidate);
    // A row that cannot be read is dropped rather than half-rendered. A board with
    // a gap is recoverable; a board with an invented rank is not.
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}

export function toPosition(value: unknown): LeaderboardPosition | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = positionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export interface CategoryCopy {
  readonly title: string;
  readonly purpose: string;
  /** What an empty board means, which is never "something went wrong". */
  readonly emptyReason: string;
}

export const CATEGORY_COPY: Record<LeaderboardCategory, CategoryCopy> = {
  weekly_xp: {
    title: "Weekly XP",
    purpose: "XP earned since Monday. Resets every Monday at 00:00 UTC.",
    emptyReason: "Nobody has earned XP yet this week.",
  },
  tournament_wins: {
    title: "Tournament Wins",
    purpose: "Sprint Tournaments won. Ties break on second places, then entries.",
    emptyReason: "No Sprint Tournament has been won yet.",
  },
  strategy_accuracy: {
    title: "Strategy Accuracy",
    purpose:
      "How often your play matched basic strategy, graded by the server. Practice, private tables and tournaments are excluded.",
    emptyReason: "Nobody has played the 100 decisions needed to qualify this week.",
  },
  daily_challenge: {
    title: "Daily Challenge",
    purpose: "Today's ending bankroll, on the shoe everyone shared.",
    emptyReason: "Nobody has finished today's challenge yet.",
  },
};

/**
 * The value, in the units it is actually in.
 *
 * Accuracy is stored in basis points because no float touches a compared figure
 * anywhere in this project. Rendering 8,734 as-is would be nonsense to a player,
 * so the conversion happens once, here.
 */
export function formatValue(category: LeaderboardCategory, value: number): string {
  switch (category) {
    case "strategy_accuracy": {
      const whole = Math.floor(value / 100);
      const fraction = Math.abs(value % 100);
      return `${whole}.${String(fraction).padStart(2, "0")}%`;
    }
    case "tournament_wins":
      return value === 1 ? "1 win" : `${value} wins`;
    case "weekly_xp":
      return `${value.toLocaleString("en-GB")} XP`;
    case "daily_challenge":
      return value.toLocaleString("en-GB");
  }
}

/**
 * How a player outside the top 100 is told where they stand.
 *
 * "Not on this board" is a worse answer than a rank, and inventing a rank is
 * worse than either — so this returns null when the server reported no position,
 * and the screen says why the board is empty for them instead.
 */
export function describePosition(
  category: LeaderboardCategory,
  position: LeaderboardPosition | null,
): string | null {
  if (!position) return null;
  return `You are ${position.rank} of ${position.total_ranked} with ${formatValue(category, position.value)}.`;
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/**
 * One page.
 *
 * The specification's board is a top 100, and 25 at a time is what a phone shows
 * without a scroll that never ends. Four pages reach the hundred; past it,
 * "Load more" keeps going rather than pretending the board stops there.
 */
export const PAGE_SIZE = 25;

/**
 * Whether the page just received was the last one.
 *
 * A page SHORTER than it asked for is the end of the board. Asking again to
 * discover that would be a wasted round trip for every player who reaches the
 * bottom, which is most of them on a board this size.
 */
export function pageWasLast(received: number, pageSize: number = PAGE_SIZE): boolean {
  return received < pageSize;
}

/**
 * What to ask the server for next, or nothing.
 *
 * Extracted rather than left inline because it is the ENABLEMENT of a control,
 * and this project has been bitten by testing the function behind a button
 * instead of whether the button could be pressed — `betting-affordance.ts` is
 * the shape being copied. A "Load more" that fires while a page is already in
 * flight asks for the same offset twice and appends it twice.
 */
export function nextPageRequest(params: {
  /** How many rows are on screen. The next offset, by definition. */
  readonly loaded: number;
  readonly hasMore: boolean;
  readonly busy: boolean;
  readonly pageSize?: number;
}): { readonly limit: number; readonly offset: number } | null {
  if (!params.hasMore || params.busy) return null;
  return { limit: params.pageSize ?? PAGE_SIZE, offset: params.loaded };
}
