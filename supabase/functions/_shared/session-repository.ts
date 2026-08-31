/**
 * Arc 21 — persistence for the command transaction.
 *
 * Every function here takes the transaction handle explicitly. Nothing in this
 * module opens its own connection, so there is no way to accidentally split a
 * command across two transactions and settle half of it.
 *
 * Read order matters and is not incidental:
 *   1. lock the private engine state FOR UPDATE — this is the serialisation
 *      point for a game, and it is taken BEFORE the idempotency lookup for the
 *      same reason `apply_wallet_delta` locks the wallet before checking its
 *      key: two concurrent replays under READ COMMITTED both miss the other's
 *      uncommitted row, so a guard placed ahead of the lock lets the loser
 *      reach the INSERT and raise a unique violation instead of returning the
 *      first committed result.
 *   2. then membership, then idempotency, then version.
 */

import type {
  EngineEvent,
  EngineState,
  SeatState,
} from "../../../shared/blackjack/index.js";
import type {
  AcceptedResponse,
  GameCommandType,
  PublicGameEvent,
} from "../../../shared/contracts/index.js";
import type { StatsDelta } from "./settlement-accounting.ts";
import { asJsonb, toInteger, type Tx } from "./postgres-client.ts";
import { parseEngineState } from "./engine-bridge.ts";
import { CommandError } from "./command-errors.ts";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  mode: string;
  status: "lobby" | "active" | "completed" | "abandoned";
  version: number;
  escrowChips: number;
  rulesetId: string;
  tier: string | null;
  /**
   * How much help this table shows. Chosen once at OPEN and never revisable by
   * a client, because it decides whether the session's decisions count towards
   * the strategy leaderboard AND whether advice is sent with the snapshot.
   * Everything except Quick Play is `play`.
   */
  assistance: string;
}

export interface SeatRow {
  id: string;
  seatIndex: number;
  userId: string;
  displayName: string;
  stack: number;
  buyIn: number;
  status: "active" | "disconnected" | "left";
}

export interface LockedEngineState {
  state: EngineState;
  version: number;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Takes the game's write lock and returns the authoritative state.
 *
 * `FOR UPDATE` on this one row is what makes "one command at a time per game"
 * true, including across two devices signed into the same account.
 */
export async function lockEngineState(tx: Tx, gameId: string): Promise<LockedEngineState | null> {
  const rows = await tx<{ engine_state: unknown; version: unknown }[]>`
    select engine_state, version
    from private.game_state_private
    where game_session_id = ${gameId}::uuid
    for update
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    state: parseEngineState(row.engine_state),
    version: toInteger(row.version, "game_state_private.version"),
  };
}

export async function loadSession(tx: Tx, gameId: string): Promise<SessionRow | null> {
  const rows = await tx<
    {
      id: string;
      mode: string;
      status: SessionRow["status"];
      version: unknown;
      escrow_chips: unknown;
      ruleset_id: string;
      tier: string | null;
      assistance: string;
    }[]
  >`
    select id, mode, status, version, escrow_chips, ruleset_id, tier, assistance
    from public.game_sessions
    where id = ${gameId}::uuid
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    version: toInteger(row.version, "game_sessions.version"),
    escrowChips: toInteger(row.escrow_chips, "game_sessions.escrow_chips"),
    rulesetId: row.ruleset_id,
    tier: row.tier,
    assistance: row.assistance,
  };
}

/**
 * The seat the caller holds, whatever its status.
 *
 * This is the whole of "verify session membership": no row means the caller was
 * never seated here and every command is refused.
 *
 * A seat that has already LEFT is returned rather than hidden, and the caller
 * gates on `status` itself. That distinction is load-bearing — the command that
 * closes a table also ends the seat, so hiding left seats would make the very
 * command that cashed a player out unable to find its own idempotency record on
 * a retry, and the player's client would see a hard rejection instead of the
 * committed result.
 */
export async function findSeat(
  tx: Tx,
  gameId: string,
  userId: string,
): Promise<SeatRow | null> {
  const rows = await tx<
    {
      id: string;
      seat_index: number;
      user_id: string;
      display_name: string;
      stack: unknown;
      buy_in: unknown;
      status: SeatRow["status"];
    }[]
  >`
    select id, seat_index, user_id, display_name, stack, buy_in, status
    from public.game_session_seats
    where game_session_id = ${gameId}::uuid
      and user_id = ${userId}::uuid
    order by joined_at desc
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    seatIndex: row.seat_index,
    userId: row.user_id,
    displayName: row.display_name,
    stack: toInteger(row.stack, "game_session_seats.stack"),
    buyIn: toInteger(row.buy_in, "game_session_seats.buy_in"),
    status: row.status,
  };
}

export interface AppliedCommandRow {
  userId: string;
  response: AcceptedResponse;
  appliedVersion: number;
}

/**
 * The replay guard for non-economic commands.
 *
 * Returns the FIRST committed response verbatim rather than recomputing one, so
 * a retry cannot observe a different snapshot than the original caller did.
 */
export async function findAppliedCommand(
  tx: Tx,
  gameId: string,
  clientActionId: string,
): Promise<AppliedCommandRow | null> {
  const rows = await tx<{ user_id: string; response: unknown; applied_version: unknown }[]>`
    select user_id, response, applied_version
    from private.game_commands
    where game_session_id = ${gameId}::uuid
      and client_action_id = ${clientActionId}::uuid
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    response: row.response as AcceptedResponse,
    appliedVersion: toInteger(row.applied_version, "game_commands.applied_version"),
  };
}

export async function walletBalance(tx: Tx, userId: string): Promise<number> {
  const rows = await tx<{ balance: unknown }[]>`
    select balance from public.wallets where user_id = ${userId}::uuid
  `;
  const row = rows[0];
  if (!row) throw new CommandError("INTERNAL", `no wallet for user ${userId}`);
  return toInteger(row.balance, "wallets.balance");
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function insertEngineState(tx: Tx, gameId: string, state: EngineState): Promise<void> {
  await tx`
    insert into private.game_state_private (game_session_id, engine_state, version)
    values (${gameId}::uuid, ${asJsonb(state)}::text::jsonb, ${state.version})
  `;
}

export async function persistEngineState(tx: Tx, gameId: string, state: EngineState): Promise<void> {
  const result = await tx`
    update private.game_state_private
    set engine_state = ${asJsonb(state)}::text::jsonb,
        version      = ${state.version}
    where game_session_id = ${gameId}::uuid
  `;
  if (result.count !== 1) {
    throw new CommandError("INTERNAL", `engine state row missing for game ${gameId}`);
  }
}

/**
 * Chips a seat currently holds at the table.
 *
 * A hand that carries an `outcome` has already been settled — its credit is back
 * in `stack` — so counting its wager again would double the escrow. `originalBet`
 * only holds chips while no hand exists yet; once the deal creates a hand, the
 * committed chips live on `hand.wager`.
 */
export function seatChipsAtTable(seat: SeatState): number {
  const settled = seat.hands.some((hand) => hand.outcome !== undefined);
  const unresolvedWagers = seat.hands
    .filter((hand) => hand.outcome === undefined)
    .reduce((total, hand) => total + hand.wager, 0);
  const stagedBet = seat.hands.length === 0 ? seat.originalBet : 0;
  const unresolvedInsurance = settled ? 0 : seat.insuranceBet;
  return seat.stack + stagedBet + unresolvedWagers + unresolvedInsurance;
}

export function totalChipsAtTable(state: EngineState): number {
  return state.seats.reduce((total, seat) => total + seatChipsAtTable(seat), 0);
}

export interface SessionPatch {
  status?: SessionRow["status"];
  endedAt?: string | null;
  escrowChips: number;
}

/** Mirrors the engine's public facts onto the client-readable session row. */
export async function syncSessionRow(
  tx: Tx,
  gameId: string,
  state: EngineState,
  patch: SessionPatch,
): Promise<void> {
  await tx`
    update public.game_sessions
    set version        = ${state.version},
        hand_number    = ${state.handNumber},
        shuffle_number = ${state.shoe.shuffleNumber},
        deadline_at    = ${state.actionDeadlineAt}::timestamptz,
        status         = coalesce(${patch.status ?? null}::public.game_session_status, status),
        ended_at       = coalesce(${patch.endedAt ?? null}::timestamptz, ended_at),
        escrow_chips   = ${patch.escrowChips}
    where id = ${gameId}::uuid
  `;
}

/**
 * Retires the room a finished session was played in.
 *
 * A ROOM WAS NEVER CLOSED WHEN ITS GAME ENDED, and `leave_room` — reachable
 * only from the lobby — is the sole other thing in the schema that ever writes
 * `status = 'closed'`. Once the host deals, every client is on
 * `/table/[gameId]` and leaving there sends `CASH_OUT`, which settles the seat
 * and ends the session without touching the room. So a played-out private table
 * sat at `active` for ever, holding its six-character code, and its host was
 * refused every subsequent `create_private_room` with "you already have a table
 * open" — permanently. Measured against the running stack before this existed.
 *
 * Called in the SAME transaction as the settlement that ended the session, so a
 * rolled-back closure cannot retire a room that is still being played in. The
 * `expire_stale_rooms()` sweep is the backstop for the sessions that end by some
 * other route; this is the prompt answer that releases the code immediately.
 *
 * Deliberately keyed on `game_session_id` rather than taking a room id: a
 * tournament and a daily challenge have no room at all, so this updates nothing
 * for them and needs no caller to know which modes do.
 */
export async function closeRoomForSession(tx: Tx, gameId: string): Promise<void> {
  await tx`
    update public.rooms
    set status = 'closed'
    where game_session_id = ${gameId}::uuid
      and status <> 'closed'
  `;
}

/**
 * Ends this player's membership of the room the table is being played in.
 *
 * LEAVING A TABLE THAT HAS DEALT DOES NOT GO THROUGH THE LOBBY. "Leave table"
 * sends `CASH_OUT`, which settled the seat and returned the stack and never
 * touched `room_members` — so a departed player stayed a `joined` member and,
 * if they were the host, stayed the host. Measured: after a host cashed out of
 * a three-seat table the other two kept playing, the app's own restore query
 * still returned that room to the departed host, and `create_private_room`
 * answered them "you already have a table open" for as long as strangers kept
 * playing.
 *
 * `public.release_room_seat` is `leave_room`'s body with the identity as a
 * parameter, so host migration has ONE implementation rather than a copy here.
 * It is server-only for the obvious reason: an argument naming whose seat to
 * release must never be client-callable.
 *
 * Keyed on `game_session_id`, so it does nothing at all for a mode with no room
 * — solo, career, the daily challenge and a tournament all reach this path.
 */
export async function releaseRoomSeat(tx: Tx, gameId: string, userId: string): Promise<void> {
  await tx`
    select public.release_room_seat(r.id, ${userId}::uuid)
    from public.rooms r
    where r.game_session_id = ${gameId}::uuid
  `;
}

export interface SeatPatch {
  status?: SeatRow["status"];
  leftAt?: string | null;
}

export async function syncSeatRow(
  tx: Tx,
  seatId: string,
  seat: SeatState,
  patch: SeatPatch = {},
): Promise<void> {
  await tx`
    update public.game_session_seats
    set stack           = ${seatChipsAtTable(seat)},
        connected       = ${seat.connected},
        status          = coalesce(${patch.status ?? null}::public.seat_status, status),
        disconnected_at = case when ${seat.connected} then null else coalesce(disconnected_at, now()) end,
        left_at         = coalesce(${patch.leftAt ?? null}::timestamptz, left_at)
    where id = ${seatId}::uuid
  `;
}

/**
 * Appends the command's events to the sanitised public log.
 *
 * `seq` is allocated inside the transaction while the game's write lock is
 * held, which is what makes it monotonic without a sequence object that could
 * drift between sessions or leave gaps on rollback.
 */
export async function appendEvents(
  tx: Tx,
  gameId: string,
  events: EngineEvent[],
  state: EngineState,
): Promise<PublicGameEvent[]> {
  if (events.length === 0) return [];

  const rows = await tx<{ next_seq: unknown }[]>`
    select coalesce(max(seq), 0) + 1 as next_seq
    from public.game_events
    where game_session_id = ${gameId}::uuid
  `;
  const firstSeq = toInteger(rows[0]?.next_seq ?? 1, "game_events.seq");

  const published: PublicGameEvent[] = events.map((event, index) => ({
    seq: firstSeq + index,
    stateVersion: state.version,
    handNumber: state.handNumber,
    event,
  }));

  await tx`
    insert into public.game_events
      (game_session_id, seq, type, payload, state_version, hand_number, visibility)
    select
      ${gameId}::uuid, source.seq, source.type, source.payload::jsonb,
      ${state.version}, ${state.handNumber}, 'public'
    from unnest(
      ${published.map((entry) => entry.seq)}::bigint[],
      ${published.map((entry) => entry.event.type)}::text[],
      ${published.map((entry) => asJsonb(entry.event))}::text[]
    ) as source(seq, type, payload)
  `;

  return published;
}

export async function recordAppliedCommand(
  tx: Tx,
  params: {
    gameId: string;
    userId: string;
    clientActionId: string;
    commandType: GameCommandType;
    appliedVersion: number;
    response: AcceptedResponse;
  },
): Promise<void> {
  await tx`
    insert into private.game_commands
      (game_session_id, user_id, client_action_id, command_type, applied_version, response)
    values (
      ${params.gameId}::uuid,
      ${params.userId}::uuid,
      ${params.clientActionId}::uuid,
      ${params.commandType},
      ${params.appliedVersion},
      ${asJsonb(params.response)}::text::jsonb
    )
  `;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Every label of the database's `public.ledger_reason` enum.
 *
 * Exhaustive rather than "the ones this file happens to use". The narrower list
 * omitted `tournament_entry` and `daily_challenge_reward` — both of which are
 * passed by real call sites — so the type said those calls were wrong while the
 * database accepted them happily. Nobody saw it, because
 * `supabase/functions` is excluded from `tsconfig.json` and `deno check` had
 * never been run on this directory.
 *
 * The three at the bottom are written by database functions rather than from
 * here; they are listed because this type describes the COLUMN, and a type that
 * describes only half a column is the thing that hid the defect.
 */
export type LedgerReason =
  | "table_buy_in"
  | "table_cash_out"
  | "career_reward"
  | "tournament_entry"
  | "tournament_prize"
  | "daily_challenge_reward"
  | "daily_top_up"
  | "correction"
  // Server-side only: written by `apply_wallet_delta`'s callers in SQL.
  | "initial_grant"
  | "level_up_reward"
  | "recovery_grant";

export interface LedgerEntry {
  id: string;
  delta: number;
  balanceAfter: number;
  referenceId: string | null;
}

/**
 * The ONLY way chips move.
 *
 * `apply_wallet_delta` locks the wallet row first, honours the idempotency key,
 * and lets the `balance >= 0` CHECK constraint — not a comparison in
 * application code — reject an overdraft. Nothing in this codebase writes
 * `wallets` or `wallet_ledger` directly, and no client role could if it tried.
 */
export async function applyWalletDelta(
  tx: Tx,
  params: {
    userId: string;
    delta: number;
    reason: LedgerReason;
    idempotencyKey: string;
    referenceId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<LedgerEntry> {
  if (!Number.isSafeInteger(params.delta) || params.delta === 0) {
    // `wallet_ledger` has a `delta <> 0` CHECK; callers must not reach here.
    throw new CommandError("INTERNAL", `refusing a wallet delta of ${params.delta}`);
  }

  const rows = await tx<
    { id: string; delta: unknown; balance_after: unknown; reference_id: string | null }[]
  >`
    select id, delta, balance_after, reference_id
    from public.apply_wallet_delta(
      ${params.userId}::uuid,
      ${params.delta}::bigint,
      ${params.reason}::public.ledger_reason,
      ${params.idempotencyKey}::text,
      'game_session'::text,
      ${params.referenceId}::uuid,
      ${asJsonb(params.metadata ?? {})}::text::jsonb
    )
  `;
  const row = rows[0];
  if (!row) throw new CommandError("INTERNAL", "apply_wallet_delta returned no row");

  return {
    id: row.id,
    delta: toInteger(row.delta, "wallet_ledger.delta"),
    balanceAfter: toInteger(row.balance_after, "wallet_ledger.balance_after"),
    referenceId: row.reference_id,
  };
}

export async function findLedgerEntry(
  tx: Tx,
  idempotencyKey: string,
): Promise<(LedgerEntry & { userId: string }) | null> {
  const rows = await tx<
    {
      id: string;
      user_id: string;
      delta: unknown;
      balance_after: unknown;
      reference_id: string | null;
    }[]
  >`
    select id, user_id, delta, balance_after, reference_id
    from public.wallet_ledger
    where idempotency_key = ${idempotencyKey}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    delta: toInteger(row.delta, "wallet_ledger.delta"),
    balanceAfter: toInteger(row.balance_after, "wallet_ledger.balance_after"),
    referenceId: row.reference_id,
  };
}

/** Deterministic keys, so a retry from any path lands on the same ledger row. */
export function buyInKey(userId: string, clientRequestId: string): string {
  return `table_buy_in:${userId}:${clientRequestId}`;
}

export function cashOutKey(gameId: string, seatId: string): string {
  return `table_cash_out:${gameId}:${seatId}`;
}

/**
 * Record a settled batch against the player's statistics and XP.
 *
 * Runs inside the settlement transaction, so a hand that settles either
 * updates the record or does not settle at all. There is no reconciliation
 * pass to fall behind.
 *
 * The parameters are counts and chip totals only. No wager is passed, because
 * XP must never scale with the size of a bet — the specification's invariant,
 * kept by giving the call nowhere to express one.
 */
export async function recordHandSettlement(
  tx: Tx,
  params: {
    userId: string;
    stats: StatsDelta;
    xp: number;
    utcDay: string;
    dailyCap: number;
  },
): Promise<{ xpGranted: number; totalXp: number; dailyXpAfter: number }> {
  const s = params.stats;
  const rows = await tx`
    select * from public.record_hand_settlement(
      ${params.userId}::uuid,
      ${s.handsPlayed}::integer,
      ${s.handsWon}::integer,
      ${s.handsLost}::integer,
      ${s.handsPushed}::integer,
      ${s.handsSurrendered}::integer,
      ${s.blackjacks}::integer,
      ${s.busts}::integer,
      ${s.chipsWagered}::bigint,
      ${s.chipsNet}::bigint,
      ${s.biggestWin}::bigint,
      ${s.trailingWinStreak}::integer,
      ${s.streakBroken}::boolean,
      ${params.xp}::integer,
      ${params.utcDay}::date,
      ${params.dailyCap}::integer
    )
  `;
  const row = rows[0] as
    | { xp_granted: number; total_xp: string | number; daily_xp_after: number }
    | undefined;
  if (!row) throw new Error("record_hand_settlement returned no row");
  return {
    xpGranted: toInteger(row.xp_granted, "xp_granted"),
    totalXp: toInteger(row.total_xp, "total_xp"),
    dailyXpAfter: toInteger(row.daily_xp_after, "daily_xp_after"),
  };
}

/**
 * Applies a batch of SERVER-GRADED decisions.
 *
 * Counts only, exactly like `recordHandSettlement`: there is no parameter here
 * through which a client could assert its own accuracy, because the grading
 * happened on authoritative state before this was called.
 */
export async function recordDecisions(
  tx: Tx,
  params: { userId: string; total: number; optimal: number; at: string },
): Promise<void> {
  if (params.total <= 0) return;
  await tx`
    select public.record_decisions(
      ${params.userId}::uuid,
      ${params.total}::integer,
      ${params.optimal}::integer,
      ${params.at}::timestamptz
    )
  `;
}

/**
 * Applies a graded decision to the DAILY ATTEMPT that owns this session.
 *
 * Separate from `recordDecisions`, and not a replacement for it: that one buckets
 * by ISO week for the strategy leaderboard, mixing every ranked mode together,
 * which is exactly why it cannot answer the daily board's tie-break. This one
 * belongs to a single attempt.
 *
 * Keyed by the session, so an unranked replay — which has no entry row at all —
 * writes nothing without anything here having to know that it was a replay.
 */
/**
 * The running decision counters for a live career attempt.
 *
 * The same reasoning as the daily attempt's counters, one mode along: an
 * attempt's accuracy is a fact about that attempt, and `player_decision_periods`
 * mixes in every ranked decision of the week. `evaluateStars` needs the
 * attempt's own numbers, so the attempt carries them.
 *
 * `unaided` is derived from the NODE, not from anything a client said — a
 * "learn" node shows the recommended play before the choice, so its decisions
 * measure recall of nothing. See `career-session-store.ts`, which draws the
 * same line for the offline runner.
 *
 * Written straight to the row rather than through a function because there is
 * no client role that could ever call either: `career_attempts` carries
 * `deny_client_write` and no INSERT/UPDATE grant at all.
 */
export async function recordCareerAttemptDecisions(
  tx: Tx,
  params: {
    gameId: string;
    total: number;
    optimal: number;
    unaided: boolean;
    evLostMicros: number;
  },
): Promise<void> {
  if (params.total <= 0) return;
  await tx`
    update public.career_attempts
    set decisions_total   = decisions_total + ${params.total}::int,
        decisions_optimal = decisions_optimal + ${params.optimal}::int,
        unaided_total     = unaided_total + ${params.unaided ? params.total : 0}::int,
        unaided_optimal   = unaided_optimal + ${params.unaided ? params.optimal : 0}::int,
        ev_lost_micros    = ev_lost_micros + ${params.evLostMicros}::bigint
    where game_session_id = ${params.gameId}::uuid and status = 'in_progress'
  `;
}

export async function recordDailyAttemptDecisions(
  tx: Tx,
  params: { gameId: string; total: number; optimal: number; evLostMicros: number },
): Promise<void> {
  if (params.total <= 0) return;
  await tx`
    select public.record_daily_attempt_decisions(
      ${params.gameId}::uuid,
      ${params.total}::integer,
      ${params.optimal}::integer,
      ${params.evLostMicros}::bigint
    )
  `;
}
