/**
 * Arc 21 — the authoritative command handler.
 *
 * ONE transaction, in this order (ARCHITECTURE.md, "Server command model"):
 *
 *   authenticate                         identity from the verified JWT
 *   validate                             Zod, strict, unknown fields rejected
 *   SELECT engine state FOR UPDATE       the game's serialisation point
 *   verify session membership            the seat is looked up, never sent
 *   clientActionId already applied?      return the FIRST committed result
 *   expectedVersion != current?          return stale + authoritative snapshot
 *   verify phase, actor and legality     getLegalActions on AUTHORITATIVE state
 *   apply the shared engine command      no rule is re-implemented here
 *   move chips ONLY via apply_wallet_delta
 *   bump version, append events, persist state, record idempotency
 *   COMMIT
 *   broadcast the sanitised snapshot
 *
 * There is no partial settlement: every write above is in the same transaction,
 * and anything thrown rolls all of it back.
 */

import { applyCommand } from "../../../shared/blackjack/index.js";
import {
  adviceFor,
  countsTowardsAccuracy,
  gradeDecision,
  isGradedMode,
} from "../_shared/decision-grading.ts";
import {
  gameCommandRequestSchema,
  type AcceptedResponse,
  type GameCommandRequest,
  type GameCommandResponse,
  type PublicGameEvent,
} from "../../../shared/contracts/index.js";
import type { PublicGameState, RandomSource } from "../../../shared/blackjack/index.js";
import {
  accountForSettlement,
  isEmptyAccounting,
  SERVER_DAILY_REPEATABLE_XP_CAP,
} from "../_shared/settlement-accounting.ts";
import { authenticate } from "../_shared/identity.ts";
import { classify, CommandError, toRejectedResponse } from "../_shared/command-errors.ts";
import {
  jsonResponse,
  newRequestId,
  preflightResponse,
  readJsonBody,
} from "../_shared/http-json.ts";
import { logError, logInfo, logWarn, type LogFields } from "../_shared/structured-log.ts";
import { checkRateLimit, consumeRateLimit, OUTSIDE_GAME_ACTION } from "../_shared/rate-limit.ts";
import { withTransaction, type Tx } from "../_shared/postgres-client.ts";
import {
  appendEvents,
  closeRoomForSession,
  findAppliedCommand,
  findSeat,
  loadSession,
  lockEngineState,
  lockRoomForSession,
  persistEngineState,
  recordAppliedCommand,
  releaseRoomSeat,
  syncSeatRow,
  recordDecisions,
  recordCareerAttemptDecisions,
  recordDailyAttemptDecisions,
  findDailyShoeSeed,
  recordHandSettlement,
  syncSessionRow,
  totalChipsAtTable,
} from "../_shared/session-repository.ts";
import { settleTableClosure } from "../_shared/close-table.ts";
import { chipsCameFromWallet } from "../_shared/session-economics.ts";
import { commandStartsNextHand, resolveHandBoundary } from "../_shared/session-boundary.ts";
import { careerNodeBySlug } from "../_shared/career/index.ts";
import { dailyShoeSource } from "../_shared/daily-challenge.ts";
import { notifyTurnPlayedByTimeout } from "../_shared/notify.ts";

import {
  assertCommandIsLegal,
  assertSafeToPublish,
  canCloseSession,
  sanitise,
  serverNow,
  serverRandom,
  toEngineCommand,
} from "../_shared/engine-bridge.ts";
import { broadcastSnapshot } from "../_shared/realtime-broadcast.ts";

interface HandledCommand {
  response: GameCommandResponse;
  /** Present only when authoritative state actually changed. */
  broadcast?: { publicState: PublicGameState; events: PublicGameEvent[] };
  outcome: "accepted" | "stale" | "replayed";
  stateVersion: number;
  chipDelta?: number;
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") return preflightResponse();

  const startedAt = Date.now();
  const log: LogFields = { requestId: newRequestId(), fn: "game-command" };

  try {
    // 1. Identity. Never from the payload — there is no user field to send.
    const identity = await authenticate(request);
    log.userId = identity.userId;

    // 2. Validation. Strict: an unknown field is a rejection, not a stripped key.
    const parsed = gameCommandRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      // Paths and codes only. Zod issues can echo the offending value back, and
      // an error message is not a place to reflect attacker-controlled input.
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
        .join(", ");
      throw new CommandError("INVALID_REQUEST", detail);
    }

    const command = parsed.data;
    log.gameId = command.gameId;
    log.commandId = command.clientActionId;
    log.commandType = command.type;
    log.expectedVersion = command.expectedVersion;

    const handled = await withTransaction((tx) => handle(tx, identity.userId, command, log));

    log.outcome = handled.outcome;
    log.stateVersion = handled.stateVersion;
    log.durationMs = Date.now() - startedAt;
    if (handled.chipDelta !== undefined) log.chipDelta = handled.chipDelta;
    logInfo("command handled", log);

    // 3. Broadcast AFTER the commit, and never in a way that can fail the call.
    if (handled.broadcast) {
      await broadcastSnapshot(handled.broadcast.publicState, handled.broadcast.events, log);
    }

    return jsonResponse(handled.response, 200);
  } catch (error) {
    const rejection = classify(error);
    log.code = rejection.code;
    log.outcome = "rejected";
    log.durationMs = Date.now() - startedAt;

    // A command that named a table the caller holds no live seat at. Charged
    // here, outside the transaction that just unwound, because a write made
    // inside it would have unwound with it.
    if (
      typeof log.userId === "string" &&
      (rejection.code === "NOT_A_PARTICIPANT" || rejection.code === "SESSION_CLOSED")
    ) {
      await chargeOutsideGame(log.userId, log);
    }

    if (rejection.code === "INTERNAL") {
      // The only place the underlying error's text is recorded. It stays here.
      logError("command failed", log, error);
    } else {
      logWarn("command rejected", log, rejection.internalDetail);
    }

    return jsonResponse(toRejectedResponse(rejection, log.requestId), rejection.httpStatus);
  }
});

/**
 * Escrow is "chips this table owes back to a wallet", not "chips on the felt".
 *
 * A closed-economy table therefore reports zero however large its stacks grow.
 * `startPrivateTable` already said so in a comment and set 0 at creation, but
 * every command afterwards overwrote it with the table total — so a private
 * table read as holding 10,000 chips of escrow that no wallet was owed.
 */
function escrowFor(mode: string, state: Parameters<typeof totalChipsAtTable>[0]): number {
  return chipsCameFromWallet(mode) ? totalChipsAtTable(state) : 0;
}

/**
 * Which random source deals this command's cards.
 *
 * Randomness reaches the engine at exactly two points — `createShoe` when the
 * session opens, and `reshuffle` inside `openBetting` when the cut card has been
 * passed — so this decides only what a RESHUFFLE is shuffled with. Every other
 * command builds a source that is never consulted.
 *
 * THE DEFECT: `serverRandom()` was passed unconditionally, including for the
 * Daily Challenge, whose whole claim is that every ranked entrant faces the
 * identical sequence. An attempt that crossed the cut card would have been dealt
 * a CSPRNG shoe from that point and silently stopped matching everybody else's.
 * The mode is read from the session row, never from the request — the same rule
 * `settleTableClosure` follows, and for the same reason: a caller that could
 * name the answer could name the wrong one.
 */
async function shoeSourceFor(
  tx: Tx,
  session: { mode: string },
  gameId: string,
  state: { shoe: { shuffleNumber: number } },
): Promise<RandomSource> {
  if (session.mode !== "daily_challenge") return serverRandom();

  const seed = await findDailyShoeSeed(tx, gameId);
  // A daily session whose challenge has gone is not something to improvise a
  // shoe for: dealing from the CSPRNG here is the very defect this closes.
  if (!seed) throw new CommandError("INTERNAL", "daily challenge session has no seed");

  // The shuffle this command could produce, not the one already on the table.
  return dailyShoeSource(seed, state.shoe.shuffleNumber + 1);
}

/**
 * Whether this career session's decisions count as UNAIDED.
 *
 * The node's assistance mode decides it: "learn" and "analysis" put the
 * recommended play on screen, so a correct choice made while reading it
 * measures nothing about recall. "play" and "challenge" do not, so their
 * decisions are unaided. The offline runner draws the identical line from the
 * identical field — one rule, read from the catalogue in both places.
 *
 * Unknown node, or no live attempt: NOT unaided. The conservative direction, so
 * a lookup failure can never inflate an accuracy figure a star is awarded on.
 */
async function careerDecisionIsUnaided(tx: Tx, gameId: string): Promise<boolean> {
  const rows = await tx<{ code: string }[]>`
    select n.code
    from public.career_attempts a
    join public.career_nodes n on n.id = a.career_node_id
    where a.game_session_id = ${gameId}::uuid and a.status = 'in_progress'
  `;
  const node = rows[0] ? careerNodeBySlug(rows[0].code) : null;
  return node?.assistance === "play" || node?.assistance === "challenge";
}

/**
 * Ends a competition session that has just played its last hand.
 *
 * No `applyCommand` and no `settleTableClosure`: the boundary module has already
 * written the placements, the prizes and the rewards, and neither a tournament
 * stack nor a challenge stack has anywhere to go — they are scoring media, not
 * escrow. The seat is marked left and the state closed so the client is told
 * plainly that it is over rather than left polling a table that will not advance.
 */
async function closeCompetition(
  tx: Tx,
  params: {
    gameId: string;
    userId: string;
    seatId: string;
    session: { mode: string };
    state: Parameters<typeof sanitise>[0] & { version: number };
    command: GameCommandRequest;
    now: string;
    log: LogFields;
    note?: string;
  },
): Promise<HandledCommand> {
  const closed = { ...params.state, version: params.state.version + 1 };

  await persistEngineState(tx, params.gameId, closed as never);
  await syncSessionRow(tx, params.gameId, closed as never, {
    status: "completed",
    endedAt: params.now,
    // A closed economy owes no wallet anything, however large the stacks got.
    escrowChips: 0,
  });
  // A tournament and the daily challenge have no room, so this updates nothing
  // for them; a mode that grows one is retired without anybody remembering to.
  await closeRoomForSession(tx, params.gameId);

  const seatState = closed.seats.find((candidate) => candidate.seatId === params.seatId);
  if (seatState) {
    await syncSeatRow(tx, params.seatId, seatState as never, {
      status: "left",
      leftAt: params.now,
    });
  }

  const publicState = sanitise(closed);
  const response: AcceptedResponse = { status: "accepted", publicState, events: [] };

  await recordAppliedCommand(tx, {
    gameId: params.gameId,
    userId: params.userId,
    clientActionId: params.command.clientActionId,
    commandType: params.command.type,
    appliedVersion: closed.version,
    response,
  });

  params.log.outcome = "accepted";
  return {
    response,
    broadcast: { publicState, events: [] },
    outcome: "accepted",
    stateVersion: closed.version,
  };
}

/**
 * The specification's sixth limited action: "game commands outside an active
 * game".
 *
 * Read-only on purpose. It is called from the two branches that are about to
 * throw, so the transaction it runs in is going to unwind either way — and a
 * read has nothing to lose by that. An accepted command never reaches it, so
 * ordinary play pays nothing for this check.
 *
 * The attempt itself is charged after the rollback, by `chargeOutsideGame`.
 */
async function refuseIfHammering(tx: Tx, userId: string, log: LogFields): Promise<void> {
  const verdict = await checkRateLimit(tx, userId, OUTSIDE_GAME_ACTION);
  if (verdict.allowed) return;

  log.retryAfterSeconds = verdict.retryAfterSeconds;
  throw new CommandError(
    "RATE_LIMITED",
    `${OUTSIDE_GAME_ACTION} exhausted; ${verdict.retryAfterSeconds}s remaining`,
  );
}

/**
 * Charges one out-of-game command, in a transaction of its own.
 *
 * This runs after the command transaction has rolled back, which is the only
 * point at which the record can survive. It must never fail the response: the
 * caller is already being told their command was refused, and a limiter that
 * turns a 403 into a 500 is worse than no limiter.
 */
async function chargeOutsideGame(userId: string, log: LogFields): Promise<void> {
  try {
    await consumeRateLimit(userId, OUTSIDE_GAME_ACTION);
  } catch (error) {
    logWarn("could not record an out-of-game command", log, String(error));
  }
}

async function handle(
  tx: Tx,
  userId: string,
  command: GameCommandRequest,
  log: LogFields,
): Promise<HandledCommand> {
  /*
   * --- The room lock, for the one command that will need it ----------------
   *
   * `LEAVE` ends with `release_room_seat`, which takes the room row `for
   * update` — and `JOIN_PUBLIC_TABLE` takes that row FIRST and the engine state
   * second. Taking them in the other order here is the lock inversion that
   * produced `deadlock detected` between a leave and a join at the same public
   * table, so the order is made the same rather than the collision made rarer.
   * Only for LEAVE: every other command touches no room at all, and a lock
   * taken for nothing would serialise ordinary play against the lobby.
   */
  if (command.type === "LEAVE") await lockRoomForSession(tx, command.gameId);

  // --- The write lock ------------------------------------------------------
  // Taken before anything else is read, exactly as apply_wallet_delta takes the
  // wallet lock before consulting its idempotency key: under READ COMMITTED two
  // concurrent replays would otherwise both miss the other's uncommitted row.
  const locked = await lockEngineState(tx, command.gameId);
  const session = locked ? await loadSession(tx, command.gameId) : null;
  const seat = locked && session ? await findSeat(tx, command.gameId, userId) : null;

  // A caller who is not a participant learns nothing about whether the game
  // exists. Distinguishing the two would let a modified client enumerate live
  // session ids by timing or by response code.
  if (!locked || !session || !seat) {
    await refuseIfHammering(tx, userId, log);
    throw new CommandError("NOT_A_PARTICIPANT", `no seat for ${userId} in ${command.gameId}`);
  }
  log.seatId = seat.id;

  // --- Idempotency ---------------------------------------------------------
  // Deliberately ahead of the "is this seat still live" check: the command that
  // closes a table also ends the seat, so its own retry must still resolve.
  const applied = await findAppliedCommand(tx, command.gameId, command.clientActionId);
  if (applied) {
    if (applied.userId !== userId) {
      // Someone is replaying another account's action id. It is not a hit.
      throw new CommandError("IDEMPOTENCY_CONFLICT", `action ${command.clientActionId} belongs to another account`);
    }
    // Byte-for-byte the first committed result: no recomputation, no second
    // chip movement, no second card.
    return { response: applied.response, outcome: "replayed", stateVersion: applied.appliedVersion };
  }

  if (seat.status === "left" || session.status === "completed" || session.status === "abandoned") {
    await refuseIfHammering(tx, userId, log);
    throw new CommandError("SESSION_CLOSED", `session ${command.gameId} is ${session.status}`);
  }

  const state = locked.state;

  // --- Optimistic concurrency ---------------------------------------------
  // Nothing is applied. The authoritative snapshot goes back so the client can
  // resynchronise and decide for itself whether to retry.
  if (command.expectedVersion !== state.version) {
    return {
      response: {
        status: "stale",
        // Advice travels with the snapshot a resynchronising client reads, or
        // a Learn table would lose its recommendation on every refresh — and
        // the table screen refreshes on a timer.
        publicState: {
          ...sanitise(state),
          advice: adviceFor({ state, seatId: seat.id, assistance: session.assistance }),
        },
      },
      outcome: "stale",
      stateVersion: state.version,
    };
  }

  // --- Legality on authoritative state ------------------------------------
  assertCommandIsLegal(state, seat.id, command);

  // --- The competition boundary -------------------------------------------
  /*
   * Runs between hands, before the engine deals the next one, and inside this
   * same transaction.
   *
   * A Daily Challenge stops after its hand count; a Sprint Tournament changes its
   * bet ceiling, moves the button, eliminates the lowest stack after hand six and
   * settles placements after hand twelve. Doing any of it after the commit, or on
   * a schedule, would leave a tournament half-eliminated whenever a connection
   * dropped at the wrong moment.
   */
  const now = serverNow();
  let boundaryNote: string | undefined;

  /*
   * NOT `command.type === "NEXT_HAND"`. A settled hand also advances when its
   * rest window lapses and a connected client asks the server to resolve the
   * deadline — and for a whole phase that path dealt the next hand with no
   * boundary at all. See `commandStartsNextHand`.
   */
  if (commandStartsNextHand(state, command.type, now)) {
    const boundary = await resolveHandBoundary(tx, {
      gameId: command.gameId,
      mode: session.mode,
      state,
      now,
    });
    boundaryNote = boundary.note;
    if (boundaryNote) log.boundary = boundaryNote;

    if (boundary.finished) {
      // The session is over. The engine is deliberately NOT asked to deal again:
      // a twenty-first hand of a twenty-hand challenge is not a smaller bug than
      // a wrong payout.
      return await closeCompetition(tx, {
        gameId: command.gameId,
        userId,
        seatId: seat.id,
        session,
        state,
        command,
        now,
        log,
        note: boundaryNote,
      });
    }
  }

  /*
   * --- Grade the decision, BEFORE it is applied ----------------------------
   *
   * The chart has to be consulted against the cards the player was actually
   * looking at. Grading after `applyCommand` would compare basic strategy to a
   * hand that already has the hit card in it.
   *
   * Eligibility is decided by mode: Practice never reaches here, tournaments are
   * excluded because correct tournament play deviates from the chart, and private
   * tables are excluded because the product calls them unranked.
   */
  const grade = isGradedMode(session.mode)
    ? gradeDecision({
        mode: session.mode,
        state,
        seatId: seat.id,
        action: command.type as never,
      })
    : null;

  // --- Apply ---------------------------------------------------------------
  const engineCommand = toEngineCommand(command, seat.id, now);
  const { state: nextState, events } = applyCommand(state, engineCommand, {
    random: await shoeSourceFor(tx, session, command.gameId, state),
    now,
  });

  const seatState = nextState.seats.find((candidate) => candidate.seatId === seat.id);
  if (!seatState) throw new CommandError("INTERNAL", "seat vanished from engine state");

  // --- Money ---------------------------------------------------------------
  // Wagers move inside the table stack, which is why an ordinary HIT or DOUBLE
  // touches no wallet at all (SECURITY.md: "a table buy-in debits the wallet
  // once; wagers move within that stack"). The one command that crosses back
  // over is LEAVE, and only at a phase where no wager is committed.
  let chipDelta = 0;
  const closing = command.type === "LEAVE" && canCloseSession(nextState, seat.id);
  // A seat closing and the TABLE closing are different events. One player
  // leaving a five-seat table must not end it for the other four.
  let sessionEnded = false;

  if (closing) {
    // Shared with the explicit CASH_OUT route, down to the idempotency key, so
    // a dropped LEAVE response followed by a "cash out" tap credits once. The
    // closure also decides whether any chips are owed at all: a private table,
    // a tournament and the daily challenge are closed economies whose stacks
    // never reach a wallet.
    const closure = await settleTableClosure(tx, {
      gameId: command.gameId,
      userId,
      seatId: seat.id,
      state: nextState,
    });
    chipDelta = closure.returned;
    sessionEnded = closure.sessionEnded;
  }

  // --- Record the hand ------------------------------------------------------
  // Statistics and XP move in the same transaction as the settlement that
  // caused them. Doing this afterwards, or on a schedule, would create a second
  // place for the hand count to be wrong.
  if (grade?.counted) {
    // Same transaction as the action itself. Recording accuracy afterwards, or on
    // a schedule, would create a second place for the count to be wrong.
    //
    // GRADED is not the same as COUNTED TOWARDS THE LEADERBOARD. A career node
    // has to be graded — its second and third stars are accuracy thresholds —
    // but half of them run in "learn", which puts the recommended play on
    // screen before the choice, and the specification excludes exactly that
    // from the ranked board. So career decisions are graded here and are not
    // sent to `record_decisions`.
    if (countsTowardsAccuracy(session.mode, session.assistance)) {
      await recordDecisions(tx, {
        userId,
        total: 1,
        optimal: grade.optimal ? 1 : 0,
        at: now,
      });
    }

    if (session.mode === "career") {
      await recordCareerAttemptDecisions(tx, {
        gameId: command.gameId,
        total: 1,
        optimal: grade.optimal ? 1 : 0,
        // A property of the NODE, never of anything the client sent.
        unaided: await careerDecisionIsUnaided(tx, command.gameId),
        evLostMicros: grade.evLostMicros,
      });
    }

    // The daily board's tie-breaks are accuracy and then EV lost, and neither can
    // come from the week bucket above — that one mixes in every solo and
    // public-table decision the player made this week. The attempt carries its
    // own counters, written here, in the same transaction as the decision.
    if (session.mode === "daily_challenge") {
      await recordDailyAttemptDecisions(tx, {
        gameId: command.gameId,
        total: 1,
        optimal: grade.optimal ? 1 : 0,
        evLostMicros: grade.evLostMicros,
      });
    }
  }
  if (grade && !grade.counted && grade.skipped) log.decisionSkipped = grade.skipped;

  // One command can settle every hand at a shared table. Each authenticated
  // seat owns its own events, regardless of who stood or resolved the timeout.
  // The engine lock and command replay gate cover this entire transaction.
  const persistedSeats = [...nextState.seats].sort((a, b) => a.seatId.localeCompare(b.seatId));
  for (const settledSeat of persistedSeats) {
    if (!settledSeat.userId) continue;
    const accounting = accountForSettlement(events, settledSeat.seatId);
    if (isEmptyAccounting(accounting)) continue;
    await recordHandSettlement(tx, {
      userId: settledSeat.userId,
      stats: accounting.stats,
      xp: accounting.xp,
      // The UTC calendar day, taken from the SERVER clock. A client-supplied
      // day would let a player reset their own daily allowance by lying about
      // their timezone.
      utcDay: now.slice(0, 10),
      dailyCap: SERVER_DAILY_REPEATABLE_XP_CAP,
    });
  }

  // --- Persist -------------------------------------------------------------
  await persistEngineState(tx, command.gameId, nextState);
  await syncSessionRow(tx, command.gameId, nextState, {
    status: sessionEnded ? "completed" : undefined,
    endedAt: sessionEnded ? now : null,
    escrowChips: escrowFor(session.mode, nextState),
  });
  // The TABLE ending — not this seat leaving — is what retires the room, so a
  // five-seat table keeps its code while four people are still playing.
  if (sessionEnded) await closeRoomForSession(tx, command.gameId);
  // Deal, settlement and timeout commands also change other players' stacks or
  // connection state. Keep their public projections in the same transaction.
  for (const projectedSeat of persistedSeats) {
    await syncSeatRow(tx, projectedSeat.seatId, projectedSeat,
      closing && projectedSeat.seatId === seat.id ? { status: "left", leftAt: now } : {});
  }
  // A LEAVE that closed the seat ends the room membership too, migrating the
  // host role if this player held it. Shared with the CASH_OUT route, down to
  // the SQL function, so the two cannot disagree about who inherits a room.
  if (closing) await releaseRoomSeat(tx, command.gameId, userId);

  await notifyTimedOutSeats(tx, command.gameId, events);

  const published = await appendEvents(tx, command.gameId, events, nextState);

  // Both halves of the payload are proved against the authoritative state
  // before either is stored or returned. A refactor that widened the public
  // shape fails the command rather than publishing the shoe.
  const publicState = sanitise(nextState);
  assertSafeToPublish(published, nextState);

  /*
   * Advice goes to the CALLER, not to the broadcast.
   *
   * Only a one-seat Quick Play table can carry a non-`play` assistance, so the
   * two payloads are identical in practice today — but a broadcast is addressed
   * to every subscriber of the channel, and "what one player asked to be told"
   * is not a property of the table. Keeping it out of the broadcast means a
   * future multi-seat mode cannot start showing one player's help to another by
   * accident.
   */
  const advice = adviceFor({
    state: nextState,
    seatId: seat.id,
    assistance: session.assistance,
  });
  const response: AcceptedResponse = {
    status: "accepted",
    publicState: advice ? { ...publicState, advice } : publicState,
    events: published,
  };

  await recordAppliedCommand(tx, {
    gameId: command.gameId,
    userId,
    clientActionId: command.clientActionId,
    commandType: command.type,
    appliedVersion: nextState.version,
    response,
  });

  log.eventCount = published.length;
  log.firstSeq = published[0]?.seq;
  log.lastSeq = published[published.length - 1]?.seq;

  return {
    response,
    broadcast: { publicState, events: published },
    outcome: "accepted",
    stateVersion: nextState.version,
    chipDelta,
  };
}

/**
 * Tells a player their hand was played for them.
 *
 * Driven by the engine's own `TIMEOUT_RESOLVED` events rather than by a guess at
 * who is present, so a notification can only exist where a default was actually
 * applied. Runs inside the command transaction: a rolled-back hand notifies
 * nobody.
 */
async function notifyTimedOutSeats(
  tx: Tx,
  gameId: string,
  events: readonly { type: string; seatId?: string }[],
): Promise<void> {
  const seatIds = new Set(
    events
      .filter((event) => event.type === "TIMEOUT_RESOLVED" && event.seatId)
      .map((event) => event.seatId as string),
  );
  if (seatIds.size === 0) return;

  for (const seatId of seatIds) {
    const rows = await tx<{ user_id: string }[]>`
      select user_id from public.game_session_seats where id = ${seatId}::uuid
    `;
    const userId = rows[0]?.user_id;
    if (userId) await notifyTurnPlayedByTimeout(tx, { gameId, userId });
  }
}
