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
});

export interface QueuePlace {
  readonly status: QueueStatus;
  readonly tier: TierId;
  readonly roomId: string | null;
  /** How many were already seated when this player was placed. */
  readonly seatedBefore: number;
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
 */
export const OFFER_ALTERNATIVES_AFTER_MS = 20_000;

export function shouldOfferAlternatives(waitingSince: Date, now: Date): boolean {
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
