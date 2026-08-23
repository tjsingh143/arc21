/**
 * Arc 21 — the solo server-authoritative session lifecycle.
 *
 * OPEN
 *   debit the tier's buy-in through `apply_wallet_delta` into a server-owned
 *   table stack, build the shoe with `crypto.getRandomValues`, persist the
 *   engine state in the `private` schema, and return the sanitised snapshot.
 *
 * CASH_OUT
 *   return the remaining stack to the wallet exactly once, and never while a
 *   wager is committed.
 *
 * Note what the client does NOT supply: no buy-in amount (it is the tier's), no
 * display name (it is the profile's), no seat id, no starting stack, no shoe.
 * "Bypass a table buy-in" is in the threat model, so the amount is never a
 * client-controlled number.
 */

import {
  applyCommand,
  ARC_STANDARD_RULES,
  createGame,
  rulesetKey,
  rulesForTier,
  startSession,
  TABLE_TIERS,
  type TableTier,
  PRIVATE_TABLE_STACK,
  privateTableRules,
  randomIntBelow,
  type GameTiming,
} from "../../../shared/blackjack/index.js";
import { DAILY, hmacCounterStream, isRankedAttempt } from "../_shared/daily-challenge.ts";
import {
  maxBetForHand,
  rotateToButton,
  SPRINT,
} from "../_shared/tournament-format.ts";
import {
  sessionRequestSchema,
  type CashOutRequest,
  type OpenSessionRequest,
  type SessionResponse,
  type StartPrivateTableRequest,
  type ResetPrivateStackRequest,
  type JoinPublicTableRequest,
  type StartDailyChallengeRequest,
  type RegisterSprintRequest,
} from "../../../shared/contracts/index.js";
import { authenticate } from "../_shared/identity.ts";
import { classify, CommandError, toRejectedResponse } from "../_shared/command-errors.ts";
import {
  jsonResponse,
  newRequestId,
  preflightResponse,
  readJsonBody,
} from "../_shared/http-json.ts";
import { logError, logInfo, logWarn, type LogFields } from "../_shared/structured-log.ts";
import { RollbackSignal, withTransaction, toInteger, type Tx } from "../_shared/postgres-client.ts";
import {
  appendEvents,
  applyWalletDelta,
  buyInKey,
  findLedgerEntry,
  findSeat,
  insertEngineState,
  loadSession,
  lockEngineState,
  persistEngineState,
  syncSeatRow,
  syncSessionRow,
  totalChipsAtTable,
  walletBalance,
} from "../_shared/session-repository.ts";
import { previousClosure, settleTableClosure } from "../_shared/close-table.ts";
import { chipsCameFromWallet } from "../_shared/session-economics.ts";
import { notifyTournamentStarting } from "../_shared/notify.ts";
import { canCloseSession, sanitise, serverNow, serverRandom } from "../_shared/engine-bridge.ts";

/**
 * A solo table carries no action deadline.
 *
 * Timers exist so one absent player cannot stall a room; a solo player stalls
 * nobody, and auto-standing their hand would silently change both their chips
 * and their recorded decision accuracy. `RESOLVE_TIMEOUT` therefore rejects with
 * DEADLINE_NOT_REACHED on a solo table, which is the correct answer rather than
 * a missing feature — the command exists for the multiplayer sessions the same
 * contract already covers.
 */
const SOLO_TIMING = null;

/**
 * A shared table runs on clocks; a solo one does not.
 *
 * With other people waiting, an absent player must not hold the table open
 * indefinitely, so betting and actions carry deadlines the server owns. The
 * defaults on expiry are stated and dull — stand, decline insurance — never
 * basic strategy played on someone's behalf.
 */
const PRIVATE_TIMING: GameTiming = {
  betMillis: 15_000,
  insuranceMillis: 15_000,
  actionMillis: 15_000,
  // Long enough to read the result, short enough that one player who closed
  // their app cannot freeze a table full of people.
  settlementMillis: 12_000,
};

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") return preflightResponse();

  const startedAt = Date.now();
  const log: LogFields = { requestId: newRequestId(), fn: "create-session" };

  try {
    const identity = await authenticate(request);
    log.userId = identity.userId;

    const parsed = sessionRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
        .join(", ");
      throw new CommandError("INVALID_REQUEST", detail);
    }

    const command = parsed.data;
    log.commandType = command.action;
    log.commandId = command.clientRequestId;

    let response: SessionResponse;
    if (command.action === "OPEN") {
      response = await openWithReplayRecovery(identity.userId, command, log);
      log.outcome = "opened";
    } else if (command.action === "JOIN_PUBLIC_TABLE") {
      response = await withTransaction((tx) => joinPublicTable(tx, identity.userId, command, log));
      log.outcome = "public_seat_taken";
    } else if (command.action === "RESET_PRIVATE_STACK") {
      log.gameId = command.gameId;
      response = await withTransaction((tx) => resetPrivateStack(tx, identity.userId, command, log));
      log.outcome = "private_stack_reset";
    } else if (command.action === "START_PRIVATE_TABLE") {
      response = await withTransaction((tx) => startPrivateTable(tx, identity.userId, command, log));
      log.outcome = "private_table_started";
    } else if (command.action === "START_DAILY_CHALLENGE") {
      response = await withTransaction((tx) =>
        startDailyChallenge(tx, identity.userId, command, log),
      );
      log.outcome = "daily_challenge_started";
    } else if (command.action === "REGISTER_SPRINT") {
      response = await withTransaction((tx) => registerSprint(tx, identity.userId, command, log));
      log.outcome = "sprint_registered";
    } else {
      log.gameId = command.gameId;
      response = await withTransaction((tx) => cashOut(tx, identity.userId, command, log));
      log.outcome = "cashed_out";
    }

    log.durationMs = Date.now() - startedAt;
    logInfo("session command handled", log);
    return jsonResponse(response, 200);
  } catch (error) {
    const rejection = classify(error);
    log.code = rejection.code;
    log.durationMs = Date.now() - startedAt;

    if (rejection.code === "INTERNAL") {
      logError("session command failed", log, error);
    } else {
      logWarn("session command rejected", log, rejection.internalDetail);
    }

    return jsonResponse(toRejectedResponse(rejection, log.requestId), rejection.httpStatus);
  }
});

// ---------------------------------------------------------------------------
// OPEN
// ---------------------------------------------------------------------------

/**
 * Two concurrent OPENs with the same `clientRequestId` both miss the ledger
 * lookup under READ COMMITTED, and both create a session row. The loser then
 * gets the winner's ledger entry back from `apply_wallet_delta` — the wallet
 * lock inside that function serialises them — and discovers the reference does
 * not point at the session it just built. It unwinds its whole transaction,
 * which erases the orphan session, and answers with the winner's table.
 *
 * The player is debited once and ends up at one table, which is the only
 * outcome that matters.
 */
async function openWithReplayRecovery(
  userId: string,
  command: OpenSessionRequest,
  log: LogFields,
): Promise<SessionResponse> {
  try {
    return await withTransaction((tx) => open(tx, userId, command, log));
  } catch (error) {
    if (error instanceof RollbackSignal) {
      const gameId = error.value as string;
      log.gameId = gameId;
      logWarn("concurrent buy-in resolved to the first committed session", log);
      return await withTransaction((tx) => describeExistingSession(tx, userId, gameId));
    }
    throw error;
  }
}

/**
 * Deal the first hand at a private table.
 *
 * The whole point of this function is what it does NOT do: there is no
 * `apply_wallet_delta` call anywhere in it, no buy-in and no cash-out. Seats
 * start on `PRIVATE_TABLE_STACK` and those chips never leave the room. If that
 * ever changes, two accounts can transfer a bankroll by agreeing to lose.
 */
async function startPrivateTable(
  tx: Tx,
  userId: string,
  command: StartPrivateTableRequest,
  log: LogFields,
): Promise<SessionResponse> {
  // Lock the room so two members tapping "start" together cannot each create a
  // game for it.
  const rooms = await tx`
    select id, code, status, host_user_id, max_seats, game_session_id
    from public.rooms where id = ${command.roomId}::uuid for update
  `;
  const room = rooms[0] as
    | { id: string; status: string; host_user_id: string; game_session_id: string | null }
    | undefined;
  if (!room) throw new CommandError("NOT_FOUND", "no such table");

  const members = await tx`
    select m.user_id, m.seat_index, p.display_name
    from public.room_members m
    join public.profiles p on p.id = m.user_id
    where m.room_id = ${command.roomId}::uuid and m.status = 'joined'
    order by m.seat_index
  `;
  const seated = members as Array<{ user_id: string; seat_index: number; display_name: string }>;

  if (!seated.some((member) => member.user_id === userId)) {
    throw new CommandError("NOT_A_PARTICIPANT", "you are not at that table");
  }

  // Already dealt: return the running game rather than starting a second one.
  // A member who taps "start" a moment after the host must land in the same
  // hand, not a fresh shoe.
  if (room.game_session_id) {
    return await describePrivateTable(tx, room.game_session_id, command.roomId, userId);
  }

  if (room.host_user_id !== userId) {
    throw new CommandError("NOT_A_PARTICIPANT", "only the host can start the table");
  }
  if (seated.length < 2) {
    throw new CommandError("ILLEGAL_ACTION", "a private table needs at least two players");
  }

  const gameId = crypto.randomUUID();
  log.gameId = gameId;

  const inserted = await tx`
    insert into public.game_sessions
      (id, mode, ruleset_id, host_user_id, status, max_seats, escrow_chips, started_at)
    values
      (${gameId}::uuid, 'private_table', ${await resolveRulesetId(tx)}::uuid, ${room.host_user_id}::uuid,
       'active', ${seated.length}::int, 0, now())
    returning id
  `;
  if (!inserted[0]) throw new CommandError("INTERNAL", "session insert returned no row");

  // `escrow_chips` stays 0 for the life of a private table. Escrow means "chips
  // owed back to a wallet", and none are.
  const seats: Array<{ seatId: string; userId: string; displayName: string; stack: number }> = [];
  for (const member of seated) {
    const seatRows = await tx`
      insert into public.game_session_seats
        (game_session_id, seat_index, user_id, display_name, stack, buy_in, status)
      values
        (${gameId}::uuid, ${member.seat_index}::int, ${member.user_id}::uuid,
         ${member.display_name}, ${PRIVATE_TABLE_STACK}::bigint, 0, 'active')
      returning id
    `;
    const seatId = (seatRows[0] as { id?: string } | undefined)?.id;
    if (!seatId) throw new CommandError("INTERNAL", "seat insert returned no id");
    seats.push({
      seatId,
      userId: member.user_id,
      displayName: member.display_name,
      stack: PRIVATE_TABLE_STACK,
    });
  }

  const now = serverNow();
  const created = createGame({
    gameId,
    rules: privateTableRules(),
    seats,
    random: serverRandom(),
    timing: PRIVATE_TIMING,
    now,
  });
  const opened = startSession(created, { now, random: serverRandom() });
  await insertEngineState(tx, gameId, opened.state);

  await tx`
    update public.rooms
    set game_session_id = ${gameId}::uuid, status = 'active'
    where id = ${command.roomId}::uuid
  `;

  return await describePrivateTable(tx, gameId, command.roomId, userId);
}

/**
 * Put a broke seat back on the private table's fixed stack.
 *
 * Three guards, and all three matter:
 *
 *   - **private tables only.** A free reset at a wallet-backed table would mint
 *     chips out of nothing. The mode is read from the session row, never from
 *     the request.
 *   - **between hands only.** Resetting mid-hand would change a stack with a
 *     wager already committed against it.
 *   - **only when actually broke.** Otherwise this is a "refill to full"
 *     button that erases every loss, and the game stops meaning anything.
 *
 * As everywhere else in this file, no wallet is touched: these chips belong to
 * the table.
 */
async function resetPrivateStack(
  tx: Tx,
  userId: string,
  command: ResetPrivateStackRequest,
  log: LogFields,
): Promise<SessionResponse> {
  const session = await loadSession(tx, command.gameId);
  if (!session) throw new CommandError("NOT_FOUND", "no such table");
  if (session.mode !== "private_table") {
    throw new CommandError("ILLEGAL_ACTION", "only a private table can reset a stack");
  }

  const seat = await findSeat(tx, command.gameId, userId);
  if (!seat) throw new CommandError("NOT_A_PARTICIPANT", "you are not at that table");
  log.seatId = seat.id;

  const locked = await lockEngineState(tx, command.gameId);
  if (!locked) throw new CommandError("NOT_FOUND", "that table has no game");

  const state = locked.state;
  if (!canCloseSession(state, seat.id)) {
    throw new CommandError("WRONG_PHASE", "wait for the hand to finish");
  }

  const seatState = state.seats.find((candidate) => candidate.seatId === seat.id);
  if (!seatState) throw new CommandError("INTERNAL", "seat missing from engine state");

  // "Broke" means cannot make the table minimum, not literally zero: a seat
  // holding 10 chips at a 20-chip table is just as stuck.
  if (seatState.stack >= state.rules.minBet) {
    throw new CommandError(
      "ILLEGAL_ACTION",
      "a reset is only available when you cannot cover the minimum bet",
    );
  }

  const next = {
    ...state,
    version: state.version + 1,
    seats: state.seats.map((candidate) =>
      candidate.seatId === seat.id ? { ...candidate, stack: PRIVATE_TABLE_STACK } : candidate,
    ),
  };

  await persistEngineState(tx, command.gameId, next);
  await syncSeatRow(tx, seat.id, next.seats.find((c) => c.seatId === seat.id)!, {});

  return {
    status: "private_stack_reset",
    gameId: command.gameId,
    seatId: seat.id,
    stack: PRIVATE_TABLE_STACK,
    publicState: sanitise(next),
  };
}

/**
 * One live seat per player, enforced beside the money.
 *
 * Escrow that nobody is watching is how a wallet quietly empties into abandoned
 * tables — but the sharper reason is that a SECOND seat means a SECOND buy-in
 * out of the same wallet, and the buy-in idempotency key is derived from the
 * game, so two different games are two different keys and both are honoured.
 *
 * `exceptGameId` is what keeps a reconnect working. The invariant is "no seat at
 * some OTHER live table", not "no seat at all": a player re-joining the table
 * they are already sitting at must land on the existing seat and the existing
 * ledger row, or the guard would lock them out of their own chips.
 *
 * This is the CONTROL. `join_matchmaking` refuses an already-seated player too,
 * but that one is a courtesy that keeps a client out of a queue it cannot use —
 * the same relationship the tier's unlock level already has with this function.
 * Being matched is not being seated, and nothing stops a matched player opening
 * a solo table first, so the queue's refusal cannot be the only one.
 */
async function assertNoOtherLiveSeat(
  tx: Tx,
  userId: string,
  exceptGameId: string | null,
): Promise<void> {
  const seated = await tx<{ game_session_id: string }[]>`
    select s.game_session_id
    from public.game_session_seats s
    join public.game_sessions g on g.id = s.game_session_id
    where s.user_id = ${userId}::uuid
      and s.status <> 'left'
      and g.status in ('lobby', 'active')
      and (${exceptGameId}::uuid is null or s.game_session_id <> ${exceptGameId}::uuid)
    limit 1
  `;
  if (seated.length > 0) {
    throw new CommandError("SESSION_ALREADY_ACTIVE", `already seated in ${seated[0]?.game_session_id}`);
  }
}

/**
 * Take a matched seat at a public table.
 *
 * This is the only shared-table path that moves real chips, so it reuses the
 * solo table's machinery rather than growing a second one: `debitBuyIn` calls
 * `apply_wallet_delta`, which locks the wallet, honours an idempotency key and
 * lets the `balance >= 0` CHECK constraint refuse an overdraft. Nothing about
 * money is reimplemented here.
 *
 * The idempotency key is derived from the game and the player, NOT from the
 * client's request id. A retry with a fresh id must not buy a second seat — the
 * same reasoning that protects cash-out.
 */
async function joinPublicTable(
  tx: Tx,
  userId: string,
  command: JoinPublicTableRequest,
  log: LogFields,
): Promise<SessionResponse> {
  const rooms = await tx`
    select id, host_user_id, tier, game_session_id, status, max_seats
    from public.rooms
    where id = ${command.roomId}::uuid and mode = 'public_table'
    for update
  `;
  const room = rooms[0] as
    | { id: string; tier: string | null; game_session_id: string | null; max_seats: number }
    | undefined;
  if (!room) throw new CommandError("NOT_FOUND", "no such table");
  if (!room.tier) throw new CommandError("INTERNAL", "a public table with no stakes");

  const seated = await tx`
    select 1 from public.room_members
    where room_id = ${command.roomId}::uuid and user_id = ${userId}::uuid and status = 'joined'
  `;
  if (!seated[0]) throw new CommandError("NOT_A_PARTICIPANT", "you are not at that table");

  // Before anything is looked up and long before anything is charged. The
  // exception is this room's own session, so a reconnect is still idempotent.
  await assertNoOtherLiveSeat(tx, userId, room.game_session_id);

  const tier = tierFor(room.tier);
  const profile = await loadProfile(tx, userId);
  if (profile.level < tier.unlockLevel) {
    // Checked again here, beside the money. The queue checks it too, but that
    // one is a courtesy and this one is the control.
    throw new CommandError("TABLE_LOCKED", `level ${profile.level} < ${tier.unlockLevel}`);
  }

  const gameId = room.game_session_id ?? crypto.randomUUID();
  log.gameId = gameId;

  // Derived from the game and the player. A retry with a new request id lands
  // on the same key and returns the first result instead of buying twice.
  const idempotencyKey = `public_buy_in:${gameId}:${userId}`;
  const existing = await findLedgerEntry(tx, idempotencyKey);

  if (!room.game_session_id) {
    await tx`
      insert into public.game_sessions
        (id, mode, ruleset_id, tier, host_user_id, status, max_seats, escrow_chips, started_at)
      values
        (${gameId}::uuid, 'public_table', ${await resolveRulesetId(tx)}::uuid,
         ${tier.id}::public.table_tier, ${userId}::uuid, 'active',
         ${room.max_seats}::int, 0, now())
    `;
  }

  let seat = await findSeat(tx, gameId, userId);
  if (!seat) {
    const seatRows = await tx`
      insert into public.game_session_seats
        (game_session_id, seat_index, user_id, display_name, stack, buy_in, status)
      values
        (${gameId}::uuid,
         (select coalesce(max(seat_index) + 1, 0) from public.game_session_seats
          where game_session_id = ${gameId}::uuid),
         ${userId}::uuid, ${profile.displayName}, ${tier.buyIn}::bigint,
         ${tier.buyIn}::bigint, 'active')
      returning id
    `;
    const seatId = (seatRows[0] as { id?: string } | undefined)?.id;
    if (!seatId) throw new CommandError("INTERNAL", "seat insert returned no id");
    seat = { id: seatId };
  }
  log.seatId = seat.id;

  const now = serverNow();
  const locked = room.game_session_id ? await lockEngineState(tx, gameId) : null;

  if (!locked) {
    // First player through opens the shoe.
    const created = createGame({
      gameId,
      rules: rulesForTier(tier),
      seats: [{ seatId: seat.id, userId, displayName: profile.displayName, stack: tier.buyIn }],
      random: serverRandom(),
      timing: PRIVATE_TIMING,
      now,
    });
    const opened = startSession(created, { now, random: serverRandom() });
    await insertEngineState(tx, gameId, opened.state);
  } else if (!locked.state.seats.some((candidate) => candidate.seatId === seat.id)) {
    /*
     * A later arrival. The seat is appended with its own funded stack and the
     * version bumped, so every client refetches. The specification says a
     * mid-hand joiner plays from the next BETTING_OPEN — which is what happens
     * naturally: the engine deals to seats that have locked a bet, and this one
     * has not.
     */
    await persistEngineState(tx, gameId, {
      ...locked.state,
      version: locked.state.version + 1,
      seats: [
        ...locked.state.seats,
        {
          seatId: seat.id,
          userId,
          displayName: profile.displayName,
          stack: tier.buyIn,
          originalBet: 0,
          insuranceBet: 0,
          hands: [],
          currentHandIndex: 0,
          connected: true,
          sittingOut: false,
          betLocked: false,
        },
      ],
    });
  }

  // The debit is last among the conflicting writes, so the wallet lock is held
  // for the shortest possible time.
  let balance: number;
  if (existing) {
    if (existing.userId !== userId) {
      throw new CommandError("IDEMPOTENCY_CONFLICT", "buy-in key belongs to another account");
    }
    balance = await walletBalance(tx, userId);
  } else {
    const entry = await debitBuyIn(tx, {
      userId,
      buyIn: tier.buyIn,
      idempotencyKey,
      gameId,
      tierId: tier.id,
    });
    balance = entry.balanceAfter;
  }

  await tx`
    update public.rooms
    set game_session_id = ${gameId}::uuid, status = 'active'
    where id = ${command.roomId}::uuid
  `;
  await tx`
    update public.game_sessions
    set escrow_chips = (
      select coalesce(sum(stack), 0) from public.game_session_seats
      where game_session_id = ${gameId}::uuid and status = 'active'
    )
    where id = ${gameId}::uuid
  `;

  const finalState = await lockEngineState(tx, gameId);
  if (!finalState) throw new CommandError("INTERNAL", "engine state vanished");

  return {
    status: "public_seat_taken",
    gameId,
    roomId: command.roomId,
    seatId: seat.id,
    buyIn: tier.buyIn,
    walletBalance: balance,
    publicState: sanitise(finalState.state),
  };
}

async function describePrivateTable(
  tx: Tx,
  gameId: string,
  roomId: string,
  userId: string,
): Promise<SessionResponse> {
  const locked = await lockEngineState(tx, gameId);
  if (!locked) throw new CommandError("NOT_FOUND", "that table has no game");

  const seat = await findSeat(tx, gameId, userId);
  if (!seat) throw new CommandError("NOT_A_PARTICIPANT", "you are not at that table");

  return {
    status: "private_table_started",
    gameId,
    roomId,
    seatId: seat.id,
    sessionStack: PRIVATE_TABLE_STACK,
    publicState: sanitise(locked.state),
  };
}

async function open(
  tx: Tx,
  userId: string,
  command: OpenSessionRequest,
  log: LogFields,
): Promise<SessionResponse> {
  const idempotencyKey = buyInKey(userId, command.clientRequestId);

  // The buy-in ledger row IS the idempotency record for OPEN: it is unique, it
  // is written in the same transaction as the table, and it names the session
  // it paid for. No second bookkeeping table is needed.
  const existing = await findLedgerEntry(tx, idempotencyKey);
  if (existing) {
    if (existing.userId !== userId) {
      throw new CommandError("IDEMPOTENCY_CONFLICT", "buy-in key belongs to another account");
    }
    if (!existing.referenceId) {
      throw new CommandError("INTERNAL", "buy-in ledger row carries no session reference");
    }
    log.gameId = existing.referenceId;
    return await describeExistingSession(tx, userId, existing.referenceId);
  }

  const tier = tierFor(command.tier);
  const profile = await loadProfile(tx, userId);
  if (profile.level < tier.unlockLevel) {
    throw new CommandError("TABLE_LOCKED", `level ${profile.level} < ${tier.unlockLevel}`);
  }

  // One live seat per player. A solo table is never a re-join — the idempotent
  // path for OPEN is the ledger key above — so nothing is excepted here.
  await assertNoOtherLiveSeat(tx, userId, null);

  const rulesetId = await resolveRulesetId(tx);
  const buyIn = tier.buyIn;

  const sessionRows = await tx<{ id: string }[]>`
    insert into public.game_sessions
      (mode, ruleset_id, tier, host_user_id, status, max_seats, escrow_chips, started_at)
    values
      ('solo', ${rulesetId}::uuid, ${tier.id}::public.table_tier, ${userId}::uuid,
       'active', 1, ${buyIn}, now())
    returning id
  `;
  const gameId = sessionRows[0]?.id;
  if (!gameId) throw new CommandError("INTERNAL", "session insert returned no id");
  log.gameId = gameId;

  const seatRows = await tx<{ id: string }[]>`
    insert into public.game_session_seats
      (game_session_id, seat_index, user_id, display_name, stack, buy_in, status)
    values
      (${gameId}::uuid, 0, ${userId}::uuid, ${profile.displayName}, ${buyIn}, ${buyIn}, 'active')
    returning id
  `;
  const seatId = seatRows[0]?.id;
  if (!seatId) throw new CommandError("INTERNAL", "seat insert returned no id");
  log.seatId = seatId;

  // The shoe. `CryptoRandomSource` throws on construction rather than falling
  // back to Math.random(), so a runtime without a CSPRNG deals no cards at all.
  const now = serverNow();
  const created = createGame({
    gameId,
    rules: rulesForTier(tier),
    seats: [{ seatId, userId, displayName: profile.displayName, stack: buyIn }],
    random: serverRandom(),
    timing: SOLO_TIMING,
    now,
  });
  const opened = startSession(created, { now, random: serverRandom() });

  await insertEngineState(tx, gameId, opened.state);

  // The debit is last among the writes that can conflict, so the wallet lock is
  // held for the shortest possible time.
  const entry = await debitBuyIn(tx, {
    userId,
    buyIn,
    idempotencyKey,
    gameId,
    tierId: tier.id,
  });

  if (entry.referenceId !== gameId) {
    // A concurrent request won the key. Unwind everything — including the
    // session and seat rows just inserted — and answer with the winner's table.
    throw new RollbackSignal(entry.referenceId);
  }

  await syncSessionRow(tx, gameId, opened.state, {
    status: "active",
    escrowChips: totalChipsAtTable(opened.state),
  });
  const published = await appendEvents(tx, gameId, opened.events, opened.state);
  log.eventCount = published.length;
  log.stateVersion = opened.state.version;

  return {
    status: "opened",
    gameId,
    seatId,
    buyIn,
    walletBalance: entry.balanceAfter,
    publicState: sanitise(opened.state),
  };
}

/** The answer for an OPEN whose table already exists. */
async function describeExistingSession(
  tx: Tx,
  userId: string,
  gameId: string,
): Promise<SessionResponse> {
  const locked = await lockEngineState(tx, gameId);
  const seat = await findSeat(tx, gameId, userId);
  if (!locked || !seat) {
    throw new CommandError("NOT_A_PARTICIPANT", `no seat for ${userId} in ${gameId}`);
  }
  return {
    status: "opened",
    gameId,
    seatId: seat.id,
    buyIn: seat.buyIn,
    // The current balance and the current snapshot, not the historical ones:
    // the table has been played since, and a stale snapshot would be worse than
    // useless to the client that is retrying.
    walletBalance: await walletBalance(tx, userId),
    publicState: sanitise(locked.state),
  };
}

// ---------------------------------------------------------------------------
// CASH_OUT
// ---------------------------------------------------------------------------

async function cashOut(
  tx: Tx,
  userId: string,
  command: CashOutRequest,
  log: LogFields,
): Promise<SessionResponse> {
  const locked = await lockEngineState(tx, command.gameId);
  const session = locked ? await loadSession(tx, command.gameId) : null;
  const seat = locked && session ? await findSeat(tx, command.gameId, userId) : null;
  if (!locked || !session || !seat) {
    throw new CommandError("NOT_A_PARTICIPANT", `no seat for ${userId} in ${command.gameId}`);
  }
  log.seatId = seat.id;

  // Already cashed out: return the FIRST committed result rather than paying a
  // second time. This also covers a LEAVE command that closed the table.
  const previous = await previousClosure(tx, command.gameId, seat.id, userId);
  if (previous) {
    log.stateVersion = locked.state.version;
    return { status: "cashed_out", gameId: command.gameId, ...previous };
  }

  // Closed with an empty stack writes no ledger row — `wallet_ledger` forbids a
  // zero delta — so "no ledger row" alone is not proof nothing happened.
  if (seat.status === "left" || session.status === "completed" || session.status === "abandoned") {
    return {
      status: "cashed_out",
      gameId: command.gameId,
      returned: 0,
      walletBalance: await walletBalance(tx, userId),
    };
  }

  if (!canCloseSession(locked.state, seat.id)) {
    throw new CommandError("SESSION_BUSY", `phase ${locked.state.phase}`);
  }

  // The engine's LEAVE returns any staged-but-unlocked bet to the stack, so the
  // amount credited below is the seat's whole position.
  const now = serverNow();
  const { state, events } = applyCommand(
    locked.state,
    { type: "LEAVE", seatId: seat.id },
    { random: serverRandom(), now },
  );

  const closure = await settleTableClosure(tx, {
    gameId: command.gameId,
    userId,
    seatId: seat.id,
    state,
  });

  await persistEngineState(tx, command.gameId, state);
  await syncSessionRow(tx, command.gameId, state, {
    // Only when the table actually emptied. One seat cashing out of a public
    // table leaves the others playing.
    status: closure.sessionEnded ? "completed" : undefined,
    endedAt: closure.sessionEnded ? now : null,
    escrowChips: chipsCameFromWallet(session.mode) ? totalChipsAtTable(state) : 0,
  });
  const seatState = state.seats.find((candidate) => candidate.seatId === seat.id);
  if (!seatState) throw new CommandError("INTERNAL", "seat missing from engine state");
  await syncSeatRow(tx, seat.id, seatState, { status: "left", leftAt: now });
  await appendEvents(tx, command.gameId, events, state);

  log.stateVersion = state.version;
  log.chipDelta = closure.returned;

  return { status: "cashed_out", gameId: command.gameId, ...closure };
}

// ---------------------------------------------------------------------------
// START_DAILY_CHALLENGE
// ---------------------------------------------------------------------------

/**
 * Start or resume today's Daily Challenge.
 *
 * No chip moves here in either direction. Challenge chips are a scoring medium:
 * 5,000 of them appear on the table, they are wagered against each other for
 * twenty hands, and they vanish with the session. The only wallet event in the
 * whole mode is the reward, paid once at the end of a ranked attempt.
 *
 * The shoe comes from `hmacCounterStream` over the row's secret seed, so every
 * ranked entrant is dealt the identical sequence — the entire reason the mode
 * exists. `CryptoRandomSource` would be wrong here and `SeededTestRandomSource`
 * would make the shoe recoverable from 32 bits.
 */
async function startDailyChallenge(
  tx: Tx,
  userId: string,
  _command: StartDailyChallengeRequest,
  log: LogFields,
): Promise<SessionResponse> {
  // The UTC date is the SERVER's. A client-supplied one would let a player shop
  // for a shoe whose cards they had already seen.
  const challengeRows = await tx<{ id: string }[]>`
    select public.ensure_daily_challenge_for((now() at time zone 'utc')::date) as id
  `;
  const challengeId = challengeRows[0]?.id;
  if (!challengeId) throw new CommandError("INTERNAL", "no daily challenge for today");

  const rows = await tx<
    {
      seed_secret: string;
      seed_commitment: string;
      hand_count: unknown;
      starting_chips: unknown;
    }[]
  >`
    select seed_secret, seed_commitment, hand_count, starting_chips
    from public.daily_challenges where id = ${challengeId}::uuid for update
  `;
  const challenge = rows[0];
  if (!challenge) throw new CommandError("INTERNAL", "daily challenge vanished");

  const handCount = toInteger(challenge.hand_count, "daily_challenges.hand_count");
  const startingChips = toInteger(challenge.starting_chips, "daily_challenges.starting_chips");

  // An attempt already in flight is resumed, not restarted. Restarting would be
  // a second look at the same cards, which is the one thing one-attempt-per-day
  // is there to prevent.
  const existing = await tx<{ status: string; game_session_id: string | null }[]>`
    select status, game_session_id from public.daily_entries
    where daily_challenge_id = ${challengeId}::uuid and user_id = ${userId}::uuid
    for update
  `;
  const entry = existing[0];

  if (entry?.status === "in_progress" && entry.game_session_id) {
    log.gameId = entry.game_session_id;
    return await describeDailyChallenge(tx, {
      gameId: entry.game_session_id,
      userId,
      challengeId,
      seedCommitment: challenge.seed_commitment,
      handCount,
      startingChips,
      ranked: true,
    });
  }

  // A finished or abandoned attempt has spent the ranked slot. The replay is
  // playable — practising against a shoe you know is useful — and it writes no
  // entry row at all, so an unranked run cannot overwrite a ranked score. That
  // is enforced by never writing rather than by comparing scores.
  const ranked = isRankedAttempt(entry ? { status: entry.status } : null);

  const profile = await loadProfile(tx, userId);
  const gameId = crypto.randomUUID();
  log.gameId = gameId;

  await tx`
    insert into public.game_sessions
      (id, mode, ruleset_id, daily_challenge_id, host_user_id, status, max_seats,
       escrow_chips, started_at)
    values
      (${gameId}::uuid, 'daily_challenge', ${await resolveRulesetId(tx)}::uuid,
       ${challengeId}::uuid, ${userId}::uuid, 'active', 1, 0, now())
  `;

  const seatRows = await tx<{ id: string }[]>`
    insert into public.game_session_seats
      (game_session_id, seat_index, user_id, display_name, stack, buy_in, status)
    values
      (${gameId}::uuid, 0, ${userId}::uuid, ${profile.displayName},
       ${startingChips}::bigint, 0, 'active')
    returning id
  `;
  const seatId = seatRows[0]?.id;
  if (!seatId) throw new CommandError("INTERNAL", "seat insert returned no id");
  log.seatId = seatId;

  const now = serverNow();
  // The deterministic stream, not the CSPRNG. Same seed, same shoe, every time.
  const shoeSource = hmacCounterStream(challenge.seed_secret);
  const created = createGame({
    gameId,
    rules: { ...ARC_STANDARD_RULES, minBet: DAILY.minBet, maxBet: DAILY.maxBet },
    seats: [{ seatId, userId, displayName: profile.displayName, stack: startingChips }],
    random: shoeSource,
    // No clocks. A daily challenge is one player against a fixed shoe, and the
    // specification is explicit that completion speed is not a skill metric —
    // so nothing here should reward hurrying.
    timing: SOLO_TIMING,
    now,
  });
  const opened = startSession(created, { now, random: shoeSource });
  await insertEngineState(tx, gameId, opened.state);

  if (ranked) {
    await tx`
      insert into public.daily_entries
        (daily_challenge_id, user_id, game_session_id, status, hands_played, final_chips, score)
      values
        (${challengeId}::uuid, ${userId}::uuid, ${gameId}::uuid, 'in_progress', 0,
         ${startingChips}::bigint, 0)
    `;
  }

  await appendEvents(tx, gameId, opened.events, opened.state);

  return {
    status: "daily_challenge_started",
    gameId,
    seatId,
    challengeId,
    seedCommitment: challenge.seed_commitment,
    handCount,
    startingChips,
    ranked,
    publicState: sanitise(opened.state),
  };
}

async function describeDailyChallenge(
  tx: Tx,
  params: {
    gameId: string;
    userId: string;
    challengeId: string;
    seedCommitment: string;
    handCount: number;
    startingChips: number;
    ranked: boolean;
  },
): Promise<SessionResponse> {
  const locked = await lockEngineState(tx, params.gameId);
  const seat = await findSeat(tx, params.gameId, params.userId);
  if (!locked || !seat) throw new CommandError("NOT_A_PARTICIPANT", "no attempt to resume");

  return {
    status: "daily_challenge_started",
    gameId: params.gameId,
    seatId: seat.id,
    challengeId: params.challengeId,
    seedCommitment: params.seedCommitment,
    handCount: params.handCount,
    startingChips: params.startingChips,
    ranked: params.ranked,
    publicState: sanitise(locked.state),
  };
}

// ---------------------------------------------------------------------------
// REGISTER_SPRINT
// ---------------------------------------------------------------------------

/**
 * Enter the Sprint Tournament, and deal it once the field is full.
 *
 * The entry fee is the only global-wallet exposure in the format: 500 chips out,
 * and a prize back at the end for the top three. Tournament stacks themselves
 * never reach a wallet in either direction, which is why the tournament table is
 * a closed economy in `session-economics.ts`.
 *
 * The idempotency key is derived from the tournament and the player, never from
 * the client's request id — a retry with a fresh id must not pay a second fee.
 * The same reasoning protects a public-table buy-in and a cash-out.
 */
async function registerSprint(
  tx: Tx,
  userId: string,
  _command: RegisterSprintRequest,
  log: LogFields,
): Promise<SessionResponse> {
  /*
   * Serialise allocation for the whole format behind one advisory lock.
   *
   * This is the matchmaking lesson applied before it could be relearned: the
   * obvious `for update skip locked` on the candidate tournament is safe but
   * wrong, because under contention each registrant SKIPS the tournament another
   * is holding and opens its own — four players arriving together would sit at
   * four tournaments of one. Measured there, so assumed here.
   */
  await tx`select pg_advisory_xact_lock(hashtext('sprint:registration'))`;

  // Already entered: return the same entry rather than a second one. This is the
  // reconnect path as much as the double-tap path.
  const mine = await tx<
    { tournament_id: string; entry_id: string; status: string }[]
  >`
    select e.tournament_id, e.id as entry_id, t.status
    from public.tournament_entries e
    join public.tournaments t on t.id = e.tournament_id
    where e.user_id = ${userId}::uuid and t.status in ('registering', 'running')
    order by e.registered_at desc
    limit 1
  `;

  let tournamentId = mine[0]?.tournament_id ?? null;
  let entryId = mine[0]?.entry_id ?? null;

  if (!tournamentId) {
    const open = await tx<{ id: string }[]>`
      select t.id
      from public.tournaments t
      where t.code like 'sprint-%'
        and t.status = 'registering'
        and (select count(*) from public.tournament_entries e where e.tournament_id = t.id)
            < t.max_entries
      order by t.created_at
      limit 1
    `;
    tournamentId = open[0]?.id ?? (await createSprintTournament(tx));
  }
  log.gameId = undefined;

  const seatsRequired = SPRINT.seats;

  if (!entryId) {
    const filled = await countEntries(tx, tournamentId);
    const inserted = await tx<{ id: string }[]>`
      insert into public.tournament_entries
        (tournament_id, user_id, status, bracket_seed, chips, score)
      values
        (${tournamentId}::uuid, ${userId}::uuid, 'registered', ${filled + 1}::int, 0, 0)
      returning id
    `;
    entryId = inserted[0]?.id ?? null;
    if (!entryId) throw new CommandError("INTERNAL", "entry insert returned no id");
  }

  // The fee. Derived from the tournament and the player, so a retry lands on the
  // same key and returns the first result instead of charging twice.
  const idempotencyKey = `sprint_entry:${tournamentId}:${userId}`;
  const paid = await findLedgerEntry(tx, idempotencyKey);
  let balance: number;
  let entryFee: number;

  if (paid) {
    if (paid.userId !== userId) {
      throw new CommandError("IDEMPOTENCY_CONFLICT", "entry key belongs to another account");
    }
    balance = await walletBalance(tx, userId);
    entryFee = 0;
  } else {
    const ledger = await debitSprintEntry(tx, { userId, tournamentId, entryId });
    balance = ledger.balanceAfter;
    entryFee = SPRINT.entryFee;
    await tx`
      update public.tournament_entries set entry_ledger_id = ${ledger.id}::uuid
      where id = ${entryId}::uuid
    `;
  }

  const entriesFilled = await countEntries(tx, tournamentId);

  // The field filled. Deal it.
  let started = await findSprintSession(tx, tournamentId);
  if (!started && entriesFilled >= seatsRequired) {
    started = await dealSprintTable(tx, tournamentId, log);
  }

  const seat = started ? await findSeat(tx, started, userId) : null;
  const locked = started ? await lockEngineState(tx, started) : null;

  return {
    status: "sprint_registered",
    tournamentId,
    entryId,
    entryFee,
    walletBalance: balance,
    entriesFilled,
    seatsRequired,
    gameId: started ?? null,
    seatId: seat?.id ?? null,
    publicState: locked ? sanitise(locked.state) : null,
  };
}

async function countEntries(tx: Tx, tournamentId: string): Promise<number> {
  const rows = await tx<{ n: unknown }[]>`
    select count(*) as n from public.tournament_entries where tournament_id = ${tournamentId}::uuid
  `;
  return toInteger(rows[0]?.n ?? 0, "tournament_entries count");
}

async function findSprintSession(tx: Tx, tournamentId: string): Promise<string | null> {
  const rows = await tx<{ id: string }[]>`
    select id from public.game_sessions where tournament_id = ${tournamentId}::uuid limit 1
  `;
  return rows[0]?.id ?? null;
}

async function createSprintTournament(tx: Tx): Promise<string> {
  const code = `sprint-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const rows = await tx<{ id: string }[]>`
    insert into public.tournaments
      (code, name, description, format, status, ruleset_id, tier,
       entry_fee_chips, starting_chips, min_entries, max_entries, prize_structure,
       registration_opens_at, starts_at)
    values
      (${code}, 'Sprint Tournament',
       'Four players, twelve hands, one elimination after hand six.',
       'leaderboard', 'registering', ${await resolveRulesetId(tx)}::uuid, 'standard',
       ${SPRINT.entryFee}::bigint, ${SPRINT.startingStack}::bigint,
       ${SPRINT.seats}::int, ${SPRINT.seats}::int,
       (select prize_structure from public.sprint_format()),
       now(), now())
    returning id
  `;
  const id = rows[0]?.id;
  if (!id) throw new CommandError("INTERNAL", "tournament insert returned no id");
  return id;
}

/**
 * Seat four registrants and open the first betting round.
 *
 * The button for hand one is chosen by the server's CSPRNG and applied by
 * rotating the seating order, because the engine deals and positions its turn
 * cursor in `state.seats` order — so moving the button IS rotating that array,
 * and there is no second notion of "who acts first" to keep in step.
 */
async function dealSprintTable(tx: Tx, tournamentId: string, log: LogFields): Promise<string> {
  const entries = await tx<{ id: string; user_id: string; bracket_seed: unknown }[]>`
    select e.id, e.user_id, e.bracket_seed
    from public.tournament_entries e
    where e.tournament_id = ${tournamentId}::uuid
    order by e.bracket_seed, e.registered_at
  `;
  if (entries.length < SPRINT.seats) {
    throw new CommandError("INTERNAL", "asked to deal an unfilled tournament");
  }

  const gameId = crypto.randomUUID();
  log.gameId = gameId;

  await tx`
    insert into public.game_sessions
      (id, mode, ruleset_id, tournament_id, host_user_id, status, max_seats,
       escrow_chips, started_at)
    values
      (${gameId}::uuid, 'tournament', ${await resolveRulesetId(tx)}::uuid,
       ${tournamentId}::uuid, ${entries[0]!.user_id}::uuid, 'active',
       ${SPRINT.seats}::int, 0, now())
  `;

  const seats: Array<{ seatId: string; userId: string; displayName: string; stack: number }> = [];
  for (const [index, entry] of entries.entries()) {
    const profile = await loadProfile(tx, entry.user_id);
    const seatRows = await tx<{ id: string }[]>`
      insert into public.game_session_seats
        (game_session_id, seat_index, user_id, display_name, stack, buy_in, status)
      values
        (${gameId}::uuid, ${index}::int, ${entry.user_id}::uuid, ${profile.displayName},
         ${SPRINT.startingStack}::bigint, 0, 'active')
      returning id
    `;
    const seatId = seatRows[0]?.id;
    if (!seatId) throw new CommandError("INTERNAL", "tournament seat insert returned no id");
    seats.push({
      seatId,
      userId: entry.user_id,
      displayName: profile.displayName,
      stack: SPRINT.startingStack,
    });
  }

  // Server randomness, per the specification: "randomly choose initial button
  // using server randomness". Not a hash of anything a client can influence.
  const initialButton = randomIntBelow(serverRandom(), SPRINT.seats);

  const now = serverNow();
  const created = createGame({
    gameId,
    // Hand one sits inside the early band. The ceiling is raised at the hand-9
    // boundary by the session-boundary module, which is the only thing that ever
    // rewrites it.
    rules: {
      ...ARC_STANDARD_RULES,
      minBet: SPRINT.minBet,
      maxBet: maxBetForHand(1),
    },
    seats: rotateToButton(seats, initialButton),
    random: serverRandom(),
    timing: {
      betMillis: SPRINT.betMillis,
      insuranceMillis: SPRINT.actionMillis,
      actionMillis: SPRINT.actionMillis,
      settlementMillis: SPRINT.settlementMillis,
    },
    now,
  });
  const opened = startSession(created, { now, random: serverRandom() });
  await insertEngineState(tx, gameId, opened.state);

  await tx`
    update public.tournaments
    set status = 'running', initial_button = ${initialButton}::int, starts_at = now()
    where id = ${tournamentId}::uuid
  `;
  await tx`
    update public.tournament_entries
    set status = 'active', chips = ${SPRINT.startingStack}::bigint
    where tournament_id = ${tournamentId}::uuid
  `;

  await appendEvents(tx, gameId, opened.events, opened.state);

  // In this transaction on purpose. A tournament that fails to commit does not
  // tell four people it is starting.
  await notifyTournamentStarting(tx, {
    tournamentId,
    userIds: entries.map((entry) => entry.user_id),
  });

  return gameId;
}

async function debitSprintEntry(
  tx: Tx,
  params: { userId: string; tournamentId: string; entryId: string },
) {
  try {
    return await applyWalletDelta(tx, {
      userId: params.userId,
      delta: -SPRINT.entryFee,
      reason: "tournament_entry",
      idempotencyKey: `sprint_entry:${params.tournamentId}:${params.userId}`,
      referenceId: params.tournamentId,
      metadata: { entryId: params.entryId },
    });
  } catch (error) {
    const code = (error as PostgresErrorLike | null)?.code;
    if (code === "23514") {
      throw new CommandError("INSUFFICIENT_STACK", "the entry fee would overdraw the wallet");
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tierFor(id: string): TableTier {
  const tier = TABLE_TIERS.find((candidate) => candidate.id === id);
  if (!tier) throw new CommandError("INVALID_REQUEST", `unknown tier ${id}`);
  return tier;
}

async function loadProfile(tx: Tx, userId: string): Promise<{ displayName: string; level: number }> {
  const rows = await tx<{ display_name: string; level: unknown }[]>`
    select display_name, level from public.profiles where id = ${userId}::uuid
  `;
  const row = rows[0];
  if (!row) throw new CommandError("NOT_A_PARTICIPANT", `no profile for ${userId}`);
  return { displayName: row.display_name, level: toInteger(row.level, "profiles.level") };
}

async function resolveRulesetId(tx: Tx): Promise<string> {
  const key = rulesetKey(ARC_STANDARD_RULES);
  const rows = await tx<{ id: string }[]>`
    select id from public.rulesets where ruleset_key = ${key} and is_active
  `;
  const row = rows[0];
  if (!row) throw new CommandError("INTERNAL", `ruleset ${key} is not seeded`);
  return row.id;
}

interface PostgresErrorLike {
  code?: string;
  constraint_name?: string;
}

async function debitBuyIn(
  tx: Tx,
  params: { userId: string; buyIn: number; idempotencyKey: string; gameId: string; tierId: string },
) {
  try {
    return await applyWalletDelta(tx, {
      userId: params.userId,
      delta: -params.buyIn,
      reason: "table_buy_in",
      idempotencyKey: params.idempotencyKey,
      referenceId: params.gameId,
      metadata: { tier: params.tierId },
    });
  } catch (error) {
    // `balance >= 0` is a CHECK constraint, not a comparison in application
    // code — which is exactly why it is the thing that fires here. Translating
    // it gives the player a usable message without weakening the guard.
    const code = (error as PostgresErrorLike | null)?.code;
    if (code === "23514") {
      throw new CommandError("INSUFFICIENT_STACK", "buy-in would overdraw the wallet");
    }
    throw error;
  }
}
