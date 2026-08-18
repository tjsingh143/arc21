/**
 * Reading a Sprint Tournament.
 *
 * The format is read from the server rather than restated here. That is not
 * ceremony: the specification requires a player to see the structure BEFORE
 * paying a 500-chip entry, and a copy of "12 hands, 2,000 max" typed into the
 * client is a copy that can be wrong on the one screen where being wrong costs
 * someone chips.
 */

import { z } from "zod";

export const formatRowSchema = z.object({
  seats: z.number().int().positive(),
  scheduled_hands: z.number().int().positive(),
  starting_chips: z.number().int().positive(),
  entry_fee_chips: z.number().int().nonnegative(),
  min_bet: z.number().int().positive(),
  early_max_bet: z.number().int().positive(),
  late_max_bet: z.number().int().positive(),
  late_bets_from: z.number().int().positive(),
  elimination_hand: z.number().int().positive(),
  prize_structure: z.array(
    z.object({
      placement: z.number().int().positive(),
      chips: z.number().int().nonnegative(),
      xp: z.number().int().nonnegative(),
    }),
  ),
});

export const entryRowSchema = z.object({
  tournament_id: z.string().uuid(),
  entry_id: z.string().uuid(),
  tournament_status: z.enum(["scheduled", "registering", "running", "completed", "cancelled"]),
  entry_status: z.enum(["registered", "active", "eliminated", "withdrawn"]),
  game_session_id: z.string().uuid().nullable(),
  /**
   * The player's SEAT, not their entry.
   *
   * The table screen resolves the player's own hand and controls by seat id. An
   * entry id there matches no seat, so the table renders with no betting bar and
   * no action dock — which is exactly what happened before this column existed.
   */
  game_session_seat_id: z.string().uuid().nullable(),
  entries_filled: z.number().int().nonnegative(),
  seats_required: z.number().int().positive(),
  chips: z.number().int().nonnegative(),
  placement: z.number().int().positive().nullable(),
  tie_break_boundary: z.number().int().nullable(),
  tie_break_hands_used: z.number().int().nonnegative(),
});

export const standingRowSchema = z.object({
  entry_id: z.string().uuid(),
  display_name: z.string(),
  chips: z.number().int().nonnegative(),
  status: z.enum(["registered", "active", "eliminated", "withdrawn"]),
  placement: z.number().int().positive().nullable(),
  eliminated_after_hand: z.number().int().nonnegative().nullable(),
  in_tie_break: z.boolean(),
  prize_chips: z.number().int().nonnegative(),
  prize_xp: z.number().int().nonnegative(),
  is_you: z.boolean(),
});

export type SprintFormat = z.infer<typeof formatRowSchema>;
export type SprintEntry = z.infer<typeof entryRowSchema>;
export type SprintStanding = z.infer<typeof standingRowSchema>;

function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

export function toFormat(value: unknown): SprintFormat | null {
  const parsed = formatRowSchema.safeParse(firstOf(value));
  return parsed.success ? parsed.data : null;
}

export function toEntry(value: unknown): SprintEntry | null {
  const parsed = entryRowSchema.safeParse(firstOf(value));
  return parsed.success ? parsed.data : null;
}

export function toStandings(value: unknown): SprintStanding[] {
  if (!Array.isArray(value)) return [];
  const rows: SprintStanding[] = [];
  for (const candidate of value) {
    const parsed = standingRowSchema.safeParse(candidate);
    // A row that cannot be read is dropped rather than half-rendered. Standings
    // with a gap are recoverable; standings with an invented stack are not.
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}

/** Plain wording for where a tournament has got to. */
export function describeProgress(entry: SprintEntry): string {
  if (entry.tournament_status === "registering") {
    const waiting = entry.seats_required - entry.entries_filled;
    return waiting <= 0
      ? "The field is full. Dealing shortly."
      : `Waiting for ${waiting} more ${waiting === 1 ? "player" : "players"}.`;
  }
  if (entry.tournament_status === "completed") {
    return entry.placement ? `Finished ${ordinal(entry.placement)}.` : "Finished.";
  }
  if (entry.tie_break_boundary !== null) {
    return `Sudden death at hand ${entry.tie_break_boundary}.`;
  }
  if (entry.entry_status === "eliminated") return "You are out. The tournament continues.";
  return "In play.";
}

export function ordinal(placement: number): string {
  const tens = placement % 100;
  if (tens >= 11 && tens <= 13) return `${placement}th`;
  switch (placement % 10) {
    case 1:
      return `${placement}st`;
    case 2:
      return `${placement}nd`;
    case 3:
      return `${placement}rd`;
    default:
      return `${placement}th`;
  }
}

/**
 * Whether two or more players share a placement.
 *
 * Worth surfacing rather than hiding: a shared placement means the prize was
 * pooled and divided, so a player seeing 750 where the schedule says 1,000 has
 * an explanation instead of a suspicion.
 */
export function sharedPlacements(standings: readonly SprintStanding[]): Set<number> {
  const counts = new Map<number, number>();
  for (const row of standings) {
    if (row.placement === null) continue;
    counts.set(row.placement, (counts.get(row.placement) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([place]) => place));
}
