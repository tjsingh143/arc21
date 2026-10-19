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
  "ai_table",
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
    case "ai_table":
      return "AI Table";
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
 * The modes whose table chips came OUT of the wallet and go back INTO it when
 * the seat closes: Quick Play and a public table. Every other mode is a closed
 * economy — a private table, a tournament, the daily challenge, a career node
 * and an AI table — whose chips are created at the table and end with it.
 *
 * Mirrors `WALLET_BACKED_MODES` in
 * `supabase/functions/_shared/session-economics.ts`, which is the answer that is
 * ENFORCED; `tests/table/active-session.test.ts` holds the two equal. This copy
 * decides only what the app SAYS — and saying chips come back from a table
 * whose chips cannot leave it would be a promise the server will not keep.
 */
export const WALLET_BACKED_SESSION_MODES = ["solo", "public_table"] as const;

export function chipsReturnToWallet(mode: ActiveSessionMode): boolean {
  return (WALLET_BACKED_SESSION_MODES as readonly string[]).includes(mode);
}

/**
 * The modes whose tables carry NO clock: Quick Play, the daily challenge, a
 * career node and an AI table — the tables `create-session` opens with
 * `SOLO_TIMING` or `AI_TABLE_TIMING`, both `null`. Nothing there waits on
 * anybody but the person, so no deadline exists to stand a hand for them: once
 * a hand is dealt, only the person's own commands can finish it (at an AI
 * table, the computer players act inside those commands and never start or end
 * a turn of theirs). Every other mode is timed and its clock applies the stated
 * default — stand, decline insurance — to an absent player.
 *
 * Refresh C (audit C-4) added it: a leave held mid-hand at an AI table told the
 * person "You do not need to do anything else", and the hand then sat at their
 * turn for ever. `tests/server/ai-table.integration.test.ts` measures the
 * server half (`deadlineAt` null, RESOLVE_TIMEOUT refused).
 */
export const UNTIMED_SESSION_MODES = ["solo", "daily_challenge", "career", "ai_table"] as const;

/** What ends a hand the player has asked to leave: their own play, or the table's clock. */
export type HandCompletion = "player" | "clock" | "unknown";

export function handCompletionForMode(mode: ActiveSessionMode): Exclude<HandCompletion, "unknown"> {
  return (UNTIMED_SESSION_MODES as readonly string[]).includes(mode) ? "player" : "clock";
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
  // Said in full rather than through the template below, which would produce
  // "a AI Table table". The facts are the closed-economy ones: nothing of the
  // player's is at an AI table to come back, so nothing is promised.
  if (session.mode === "ai_table") {
    return "You are still seated at your AI table. Return to it to play on or to leave.";
  }
  const name = describeActiveSessionMode(session.mode);
  const chipsAreEscrowed = chipsReturnToWallet(session.mode);
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

/**
 * Which seat this screen is opening, when the route did not say.
 *
 * THE DEAD END THIS CLOSES. `/table/[gameId]` needs BOTH a game id and a seat
 * id, and every in-app route supplies both — but one route does not, and it is
 * the one whose whole purpose is bringing an absent player back.
 * `notifyTurnPlayedByTimeout` writes a `your_turn` notification carrying
 * `game_id` and nothing else (a notification's `data` may hold only a fixed set
 * of short scalars, by CHECK constraint), `destinationFor` maps it to
 * `/table/<gameId>`, and the screen answered *"This screen needs a table to
 * open. Start or join one from Social."* — telling a player who is still
 * seated, in reply to a message saying they are still seated, that they are
 * not.
 *
 * The seat is not guessed. `my_active_session()` derives the caller's own live
 * seat server-side from the verified JWT, and the answer is only used when it
 * names THIS game.
 *
 * `checked` exists for the reason `mayOpenDealtTable`'s does: the lookup's
 * store is a module-level cache shared with the Play screen, so a `ready`
 * reading can arrive already filled from a previous screen. Until this mount's
 * own ask has answered, the honest state is "checking" — and rendering the
 * dead-end note during it would be the same defect one beat earlier.
 */
export type TableSeatResolution =
  | { readonly kind: "known"; readonly seatId: string }
  /** The lookup has not answered yet. Show a loading state, not a refusal. */
  | { readonly kind: "checking" }
  | { readonly kind: "unknown" };

export function resolveTableSeat(input: {
  readonly gameId: string | null;
  /** The route parameter, when there was one. */
  readonly paramSeatId: string | null;
  /** Whether `my_active_session()` has answered for THIS mount. */
  readonly checked: boolean;
  readonly session: ActiveSession | null;
}): TableSeatResolution {
  if (input.paramSeatId !== null) return { kind: "known", seatId: input.paramSeatId };
  if (input.gameId === null) return { kind: "unknown" };
  if (input.session && input.session.gameId === input.gameId) {
    return { kind: "known", seatId: input.session.seatId };
  }
  return input.checked ? { kind: "unknown" } : { kind: "checking" };
}
