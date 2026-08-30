/**
 * Arc 21 — where the player's chips are, when the app has forgotten.
 *
 * ── The defect this module exists for ───────────────────────────────────────
 *
 * A buy-in debits the wallet into a server-owned table stack, and the server
 * refuses a second one while the player still holds a live seat. Both halves
 * are right. What was missing is that the game id and the seat id reached the
 * client exactly ONCE — in the reply to `OPEN` — and lived afterwards only in an
 * `expo-router` parameter. Kill the app mid-hand, reboot the phone, or sign in
 * on a second device, and every server-authoritative mode answers
 * `SESSION_ALREADY_ACTIVE` for ever, with the buy-in stranded, because `LEAVE`
 * and `CASH_OUT` both name the id that has been lost.
 *
 * All three stores that produce that refusal told the player to "leave that
 * table first". This module is what makes that possible: it asks
 * `public.my_active_session()`, which derives the answer from `auth.uid()` and
 * uses the SAME predicate as the server's one-live-seat control.
 *
 * ── What is pure and what is not ────────────────────────────────────────────
 *
 * Everything here is pure and free of React Native, so the parsing and the
 * wording are testable under Node — `src/design/typography` would drag
 * `Platform.select` in, so the chip figures are formatted by the caller, not
 * here. The gateway and the store live in `active-session-store.ts`.
 *
 * Nothing in this file decides anything about money. It reads an address.
 */

/**
 * Session modes a live seat can be held in.
 *
 * Mirrors `ALL_SESSION_MODES` in `supabase/functions/_shared/session-economics.ts`
 * and the `public.game_mode` enum. `practice` is listed because the enum holds
 * it, not because a practice seat can exist — Practice is local and never opens
 * a session row at all.
 */
export const ACTIVE_SESSION_MODES = [
  "practice",
  "solo",
  "private_table",
  "public_table",
  "tournament",
  "daily_challenge",
  "career",
] as const;

export type ActiveSessionMode = (typeof ACTIVE_SESSION_MODES)[number];

export interface ActiveSession {
  readonly gameId: string;
  readonly seatId: string;
  readonly mode: ActiveSessionMode;
  /** The stakes, for a table that has them. Null for every closed economy. */
  readonly tier: string | null;
  readonly startedAt: Date | null;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Reads one row of `my_active_session()`, or null.
 *
 * A row that is not a live seat is DROPPED rather than repaired. This value
 * routes a player to a table holding their chips; guessing at a malformed id
 * would send them to a screen that cannot load, which reads as a broken app
 * rather than as the bad row it is.
 */
export function parseActiveSession(row: unknown): ActiveSession | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const candidate = row as Record<string, unknown>;

  const gameId = candidate.game_session_id;
  const seatId = candidate.seat_id;
  const mode = candidate.mode;
  if (typeof gameId !== "string" || !UUID.test(gameId)) return null;
  if (typeof seatId !== "string" || !UUID.test(seatId)) return null;
  if (!ACTIVE_SESSION_MODES.includes(mode as ActiveSessionMode)) return null;

  const tier = typeof candidate.tier === "string" && candidate.tier.length > 0
    ? candidate.tier
    : null;

  // An unreadable timestamp is not a reason to strand somebody. It is used only
  // to say "started 10 minutes ago", and the address is the part that matters.
  const startedMs =
    typeof candidate.started_at === "string" ? Date.parse(candidate.started_at) : Number.NaN;

  return {
    gameId,
    seatId,
    mode: mode as ActiveSessionMode,
    tier,
    startedAt: Number.isFinite(startedMs) ? new Date(startedMs) : null,
  };
}

/** The first live seat in a `my_active_session()` result set, or null. */
export function parseActiveSessionRows(rows: unknown): ActiveSession | null {
  if (!Array.isArray(rows)) return parseActiveSession(rows);
  for (const row of rows) {
    const parsed = parseActiveSession(row);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** What the player calls the table they are sitting at. */
export function describeActiveSessionMode(mode: ActiveSessionMode): string {
  switch (mode) {
    case "solo":
      return "Quick Play";
    case "public_table":
      return "Public table";
    case "private_table":
      return "Private table";
    case "tournament":
      return "Sprint Tournament";
    case "daily_challenge":
      return "Daily Challenge";
    case "career":
      return "Career";
    case "practice":
      return "Practice";
  }
}

/**
 * Every mode enters play through the same screen.
 *
 * Checked rather than assumed: `app/table/quick.tsx`, `app/table/public.tsx`,
 * `app/table/lobby.tsx`, `app/daily/index.tsx`, `app/tournament/index.tsx` and
 * `app/career/[slug].tsx` all push `/table/[gameId]` with these two parameters,
 * so one route resumes all of them.
 */
export const ACTIVE_SESSION_ROUTE = "/table/[gameId]" as const;

export interface ResumeTarget {
  readonly pathname: typeof ACTIVE_SESSION_ROUTE;
  readonly params: { readonly gameId: string; readonly seatId: string };
}

export function resumeTargetFor(session: ActiveSession): ResumeTarget {
  return {
    pathname: ACTIVE_SESSION_ROUTE,
    params: { gameId: session.gameId, seatId: session.seatId },
  };
}

/**
 * The line shown beside the resume control.
 *
 * It names no chip figure. The stack at a table is the server's number and this
 * layer has not read it; a client that printed one would be inventing it — the
 * same rule `describeRecoveryGrant` follows. What it CAN say truthfully is that
 * the buy-in is at the table rather than in the wallet, which is the fact a
 * player staring at a smaller balance actually needs.
 */
export function describeActiveSession(session: ActiveSession): string {
  const name = describeActiveSessionMode(session.mode);
  const chipsAreEscrowed = session.mode === "solo" || session.mode === "public_table";
  return chipsAreEscrowed
    ? `You are still seated at a ${name} table, and your buy-in is there. Return to it to play on or to leave and take your chips back.`
    : `You are still seated at a ${name} table. Return to it to play on or to leave.`;
}

/**
 * Whether a refusal to open a NEW table should offer this one instead.
 *
 * Extracted so the enablement can be tested, not only the function behind the
 * button — three defects in this repository survived because what was tested
 * was the function a dead control would have called.
 */
export function canResume(session: ActiveSession | null): session is ActiveSession {
  return session !== null;
}
