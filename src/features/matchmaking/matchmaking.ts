/**
 * Reading the matchmaking queue.
 *
 * Rows are parsed, never trusted. A half-understood row here would send a
 * player to a table that does not exist, or leave them watching a spinner while
 * the server believes they are already seated.
 */

import { z } from "zod";

export type QueueStatus = "waiting" | "matched" | "cancelled" | "expired";
export type TierId = "casual" | "standard" | "high";

export const queueRowSchema = z.object({
  status: z.enum(["waiting", "matched", "cancelled", "expired"]),
  tier: z.enum(["casual", "standard", "high"]),
  room_id: z.string().uuid().nullable(),
  room_code: z.string().nullable(),
  waiting_since: z.string(),
  queued_at_tier: z.number().int().nonnegative(),
  /**
   * How many OTHER players are queueing for these stakes.
   *
   * Optional because it is newer than the rest of the row, and a client that
   * refused to parse a queue without it would strand a player mid-search on the
   * one deploy where the two halves disagree. Absent reads as zero, which is
   * what the screen said unconditionally before the server was asked.
   */
  others_waiting: z.number().int().nonnegative().optional(),
});

export interface QueuePlace {
  readonly status: QueueStatus;
  readonly tier: TierId;
  readonly roomId: string | null;
  /** How many were already seated when this player was placed. */
  readonly seatedBefore: number;
  /** Other players queueing at these stakes right now. */
  readonly othersWaiting: number;
  readonly waitingSince: Date;
}

export function toQueuePlace(value: unknown): QueuePlace | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = queueRowSchema.safeParse(candidate);
  if (!parsed.success) return null;

  const since = Date.parse(parsed.data.waiting_since);
  return {
    status: parsed.data.status,
    tier: parsed.data.tier,
    roomId: parsed.data.room_id,
    seatedBefore: parsed.data.queued_at_tier,
    othersWaiting: parsed.data.others_waiting ?? 0,
    // An unparseable timestamp becomes epoch, which reads as "waiting a long
    // time" and offers the player a way out — the safe direction to be wrong in.
    waitingSince: Number.isFinite(since) ? new Date(since) : new Date(0),
  };
}

/**
 * When to offer a way out.
 *
 * The specification asks for Keep Waiting / Play Solo / Cancel after about
 * twenty seconds — not because anything failed, but because a player who has
 * waited that long deserves to be told so and offered something else.
 *
 * THIS WAS UNREACHABLE UNTIL PHASE 7. `poll_matchmaking` opened a table for a
 * lone player on their very first poll and answered `matched`, so `waiting` was
 * observable for a few milliseconds at most and nobody ever saw the offer this
 * predicate gates. A room is now opened only when there is somebody to share it
 * with, which is what makes waiting — and therefore this — real.
 */
export const OFFER_ALTERNATIVES_AFTER_MS = 20_000;

/**
 * `snoozedUntil` is what "Keep waiting" does.
 *
 * The wait itself is the server's `enqueued_at` and never resets, so without a
 * local acknowledgement the three controls would reappear on the very next tick
 * and the button would look broken. Passed in rather than read from a module,
 * like every other input here, so the rule stays testable.
 */
export function shouldOfferAlternatives(
  waitingSince: Date,
  now: Date,
  snoozedUntil: Date | null = null,
): boolean {
  if (snoozedUntil !== null && now.getTime() < snoozedUntil.getTime()) return false;
  return now.getTime() - waitingSince.getTime() >= OFFER_ALTERNATIVES_AFTER_MS;
}

/**
 * Plain wording for how the wait is going.
 *
 * Deliberately never "3rd in queue". The server reports no position, and a
 * number invented here would be one the player could watch fail to move.
 */
export function describeWait(place: QueuePlace, now: Date): string {
  if (place.status === "matched") return "Seat found.";
  if (place.status === "expired") return "The search timed out. Nothing was charged.";
  if (place.status === "cancelled") return "Search cancelled.";

  const seconds = Math.max(0, Math.floor((now.getTime() - place.waitingSince.getTime()) / 1000));
  if (seconds < 10) return "Looking for a table…";
  return `Still looking — ${seconds}s.`;
}

/**
 * Who else is out there, from the server rather than from an assumption.
 *
 * The waiting card used to state "Nobody else is queueing for these stakes
 * right now" whenever it offered a way out — which was a guess, and the wrong
 * one exactly when it mattered: two players both waiting is the case where
 * holding on for another few seconds is worth doing. `poll_matchmaking` now
 * counts them.
 */
export function describeOthersWaiting(place: QueuePlace): string {
  if (place.othersWaiting <= 0) {
    return "Nobody else is queueing for these stakes right now.";
  }
  return place.othersWaiting === 1
    ? "One other player is queueing for these stakes."
    : `${place.othersWaiting} other players are queueing for these stakes.`;
}
