/**
 * Arc 21 — Recovery Grant eligibility.
 *
 * A player whose balance has fallen below the lowest table's buy-in cannot play
 * at all, and a simulated card game that strands someone with no way back to the
 * table is simply broken. The Recovery Grant is the way back: below 2,000 chips,
 * once every twelve hours.
 *
 * ── This module DISPLAYS eligibility. It does not grant anything. ────────────
 *
 * Nothing here moves a chip, and nothing here is trusted. The client's answer is
 * a courtesy — it decides whether to show a button and what to say next to it.
 * The server evaluates the identical rule against authoritative state inside the
 * same transaction that writes the ledger entry, so a modified client that
 * forces this function to return `eligible: true` gains exactly nothing: the
 * grant is refused server-side, and the unique idempotency key on the ledger row
 * makes a replayed claim credit at most once regardless.
 *
 * That is why the rule is duplicated rather than fetched. A client that has to
 * ask the server whether a button should be enabled is a client that shows a
 * spinner where a button should be.
 *
 * Pure and clock-free: `now` is a parameter. Every boundary is therefore
 * testable exactly, which matters because both boundaries here are the kind that
 * get implemented with the wrong comparison operator.
 */

/** Strictly below. A player holding exactly 2,000 can still buy in at Casual. */
export const RECOVERY_GRANT_THRESHOLD = 2_000;

/** Twelve hours, in milliseconds. */
export const RECOVERY_GRANT_COOLDOWN_MS = 12 * 60 * 60 * 1_000;

/**
 * The ledger reason the server records a grant under.
 *
 * `recovery_grant` is the member of `public.ledger_reason` that carries this
 * meaning. It stood in as `daily_top_up` while the enum had no better value;
 * the enum now names it properly and this follows. Named once here so that the
 * query which finds the last grant and the label the player reads cannot
 * disagree about which rows count.
 */
export const RECOVERY_GRANT_REASON = "recovery_grant" as const;

export type RecoveryGrantBlocker =
  /** The balance is at or above the threshold. */
  | "BALANCE"
  /** The last grant was less than the cooldown ago. */
  | "COOLDOWN"
  /** The balance could not be read, so no claim is made either way. */
  | "UNKNOWN";

export interface RecoveryGrantInput {
  /** Integer chips from the server wallet. */
  readonly balance: number;
  /** When the last grant landed, or null if there has never been one. */
  readonly lastGrantAt: Date | null;
  readonly now: Date;
}

export interface RecoveryGrantEligibility {
  readonly eligible: boolean;
  /** Empty when eligible. Both reasons are reported when both apply. */
  readonly blockedBy: readonly RecoveryGrantBlocker[];
  /** When the cooldown expires. Null when the cooldown is not a blocker. */
  readonly availableAt: Date | null;
  /** Zero when the cooldown is not a blocker. Never negative. */
  readonly msUntilAvailable: number;
  readonly threshold: number;
  readonly cooldownMs: number;
}

/**
 * Both conditions must hold: **below** the threshold, and **at least** the
 * cooldown since the last grant.
 *
 * The two comparisons are deliberately asymmetric, and each is the boundary a
 * test pins:
 *
 *   * `balance < 2000` — 1,999 qualifies, 2,000 does not.
 *   * `elapsed >= 12h` — 11h59m does not qualify, exactly 12h00m does.
 *
 * Getting either backwards produces an off-by-one that nobody notices until a
 * player is stuck at 2,000 chips with an inactive button, or is handed a second
 * grant one millisecond early.
 */
export function evaluateRecoveryGrant(input: RecoveryGrantInput): RecoveryGrantEligibility {
  const { balance, lastGrantAt, now } = input;

  // An unusable balance is never treated as "broke and therefore eligible".
  // Guessing in the player's favour here would be a client asserting something
  // about money it could not read.
  if (!Number.isFinite(balance) || !Number.isInteger(balance)) {
    return {
      eligible: false,
      blockedBy: ["UNKNOWN"],
      availableAt: null,
      msUntilAvailable: 0,
      threshold: RECOVERY_GRANT_THRESHOLD,
      cooldownMs: RECOVERY_GRANT_COOLDOWN_MS,
    };
  }

  const blockedBy: RecoveryGrantBlocker[] = [];

  if (balance >= RECOVERY_GRANT_THRESHOLD) blockedBy.push("BALANCE");

  let availableAt: Date | null = null;
  let msUntilAvailable = 0;

  if (lastGrantAt !== null) {
    const lastGrantMs = lastGrantAt.getTime();
    if (Number.isFinite(lastGrantMs)) {
      const readyAtMs = lastGrantMs + RECOVERY_GRANT_COOLDOWN_MS;
      const remaining = readyAtMs - now.getTime();
      if (remaining > 0) {
        blockedBy.push("COOLDOWN");
        availableAt = new Date(readyAtMs);
        msUntilAvailable = remaining;
      }
    }
    // An unparseable timestamp is ignored rather than blocking: the server has
    // the authoritative history, and refusing to show the control because a
    // date string was odd would be the client overreaching.
  }

  return {
    eligible: blockedBy.length === 0,
    blockedBy,
    availableAt,
    msUntilAvailable,
    threshold: RECOVERY_GRANT_THRESHOLD,
    cooldownMs: RECOVERY_GRANT_COOLDOWN_MS,
  };
}

/**
 * Finds the most recent grant among a set of ledger timestamps.
 *
 * Takes the timestamps rather than the rows so it stays independent of the row
 * shape, and returns null for an empty or entirely unparseable set.
 */
export function latestGrantAt(isoTimestamps: readonly string[]): Date | null {
  let latest: number | null = null;
  for (const iso of isoTimestamps) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    if (latest === null || ms > latest) latest = ms;
  }
  return latest === null ? null : new Date(latest);
}

/** Rounded up, so a countdown never shows "0h 0m" while still blocked. */
export function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "now";
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/**
 * One line explaining the current position.
 *
 * Kept beside the rule so the wording and the arithmetic cannot drift, and
 * deliberately free of any chip amount — the size of a grant is the server's
 * decision, and a client that names a figure it did not receive is inventing it.
 */
export function describeRecoveryGrant(eligibility: RecoveryGrantEligibility): string {
  if (eligibility.eligible) {
    return "You can claim a recovery grant. The server decides the amount and credits it.";
  }
  if (eligibility.blockedBy.includes("UNKNOWN")) {
    return "Your balance could not be read, so recovery grant availability is unknown.";
  }

  const parts: string[] = [];
  if (eligibility.blockedBy.includes("BALANCE")) {
    parts.push(
      `Recovery grants are for balances under ${eligibility.threshold.toLocaleString("en-US")} chips.`,
    );
  }
  if (eligibility.blockedBy.includes("COOLDOWN")) {
    parts.push(`Next grant available in ${formatTimeRemaining(eligibility.msUntilAvailable)}.`);
  }
  return parts.join(" ");
}
