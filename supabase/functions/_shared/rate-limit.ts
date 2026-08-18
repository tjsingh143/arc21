/**
 * Arc 21 — the server half of the rate limiter.
 *
 * There is no second set of numbers here. Every limit lives in
 * `public.rate_limit_policies` and is read through the same two functions the
 * SQL enforcement points use, so "game commands outside an active game" is
 * configured beside "friend requests per hour" rather than as a constant in a
 * TypeScript file nothing typechecks.
 *
 * WHY THIS IS NOT ONE CALL
 *
 * A rate limit consumed inside a transaction is rolled back with that
 * transaction, and the command handler's whole design is that a rejection throws
 * and unwinds everything. So the two halves are deliberately split:
 *
 *   `checkRateLimit`   read-only, called on the rejection path INSIDE the
 *                      command transaction. Safe to roll back, because it wrote
 *                      nothing. This is what refuses a caller who is already
 *                      over the limit, and it costs a legitimate player nothing
 *                      at all — an accepted command never reaches it.
 *
 *   `consumeRateLimit` a write, called in ITS OWN transaction after the command
 *                      transaction has already rolled back. This is what makes
 *                      the attempt count.
 *
 * Doing it the obvious way round — consume inside the command transaction —
 * produces a limiter that records nothing, because the only commands it would
 * charge are the ones that throw.
 */

import { db, type Tx } from "./postgres-client.ts";

/**
 * Commands aimed at a table the caller holds no live seat at.
 *
 * The specification's sixth limited action. Ordinary play never charges it: a
 * hand is several commands, and every one of them lands on a seat.
 */
export const OUTSIDE_GAME_ACTION = "game_command_outside_game";

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until one slot frees. Zero when allowed. */
  retryAfterSeconds: number;
}

interface VerdictRow {
  allowed: boolean | null;
  retry_after_seconds: unknown;
}

function toVerdict(row: VerdictRow | undefined): RateLimitVerdict {
  // Fail OPEN on a missing row rather than locking every player out of the game
  // if the policy row is ever removed. The database fails CLOSED on an unknown
  // action — it raises — so this branch means the query itself returned nothing,
  // which is a bug in this file, not an attack.
  if (!row || row.allowed === null) return { allowed: true, retryAfterSeconds: 0 };
  const seconds = Number(row.retry_after_seconds ?? 0);
  return {
    allowed: row.allowed,
    retryAfterSeconds: Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0,
  };
}

/**
 * Asks whether this player is over the limit, without charging them.
 *
 * Read-only, so calling it inside a transaction that is about to be rolled back
 * is correct rather than merely tolerable.
 */
export async function checkRateLimit(
  tx: Tx,
  userId: string,
  action: string,
): Promise<RateLimitVerdict> {
  const rows = await tx<VerdictRow[]>`
    select (v).allowed,
           extract(epoch from (v).retry_after) as retry_after_seconds
    from public.rate_limit_check(${userId}::uuid, ${action}::text) as v
  `;
  return toVerdict(rows[0]);
}

/**
 * Charges one attempt, in a transaction of its own.
 *
 * Called AFTER the command transaction has unwound, which is the only way the
 * record survives. Never called on the accepted path.
 */
export async function consumeRateLimit(userId: string, action: string): Promise<RateLimitVerdict> {
  const rows = await db()<VerdictRow[]>`
    select (v).allowed,
           extract(epoch from (v).retry_after) as retry_after_seconds
    from public.consume_rate_limit(${userId}::uuid, ${action}::text) as v
  `;
  return toVerdict(rows[0]);
}
