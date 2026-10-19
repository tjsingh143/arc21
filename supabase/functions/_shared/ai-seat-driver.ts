/**
 * Playing the computer seats of an AI Table, inside the command that needs them.
 *
 * ARC 21 RUNS NO GAME PROCESS. A table moves only when a command arrives, so
 * the computer players cannot "take their turn later" — there is nothing to
 * wake them. They act INSIDE the transaction of whatever command handed them a
 * decision: the person's bet, their stand, their insurance answer. One command
 * from the person can therefore carry several computer decisions with it, all
 * committed together or not at all, all appended to the same event batch,
 * broadcast once.
 *
 * That is also what makes them safe under retry. The person's command is the
 * unit of idempotency: a replay of it returns the stored response — the AI
 * decisions included — and never reaches this module, so a lost reply cannot
 * make a computer player act twice.
 *
 * EVERY AI DECISION TAKES THE PERSON'S PATH. `applyAiSeatDecision` turns it into
 * the same `GameCommandRequest` a client would send, runs the server's
 * `assertCommandIsLegal` on authoritative state, translates it with
 * `toEngineCommand`, and applies it with `applyCommand`. There is no AI-only
 * entry point into the engine, and an illegal decision is refused by the same
 * code, with the same error, as an illegal tap.
 *
 * WHEN COMPUTER PLAYERS ARE ASKED — the orchestration, which is the driver's
 * job and not the policy's:
 *
 *   betting     only once every person at the table has locked a bet. Asking
 *               earlier would let the last computer lock close betting and DEAL
 *               while the person was still choosing — or deal a hand to nobody
 *               but computers the moment the person stood up to leave.
 *   insurance   as soon as the offer is made. The table then waits for the
 *               person's own answer.
 *   play        whenever it is a computer player's turn, until it is a person's
 *               turn or the hand is over.
 *
 * AND WHEN THEY STOP, WHICH IS ALWAYS. Each decision ends a computer player's
 * part in the current betting round, insurance offer or hand turn, and none of
 * them can start another hand — only `NEXT_HAND` does that, and a computer
 * player never sends it. So one drive is bounded by one hand's worth of
 * decisions per computer seat. Counted: at most two to bet (or one to leave),
 * one insurance answer, three splits and — because a hand completes itself at
 * 21 or a bust and every card adds at least one to its hard total — at most ten
 * decisions on each of four hands: 46. `AI_SEAT_COMMAND_LIMIT_PER_SEAT` allows
 * 64, and reaching it is not a slow table, it is a bug, so it THROWS — the whole
 * command rolls back and the table stays exactly where it was.
 *
 * The drive also ends only in a state the person can act on, or one at rest: if
 * a computer seat still owes a decision when the policy declines to make one,
 * that is thrown too, rather than committing a table that nothing can move.
 */

import {
  applyCommand,
  assertNoHiddenCardLeak,
  toPublicState,
  type CommandContext,
  type EngineEvent,
  type EngineResult,
  type EngineState,
  type PublicGameState,
} from "../../../shared/blackjack/index.js";
import type { GameCommandRequest } from "../../../shared/contracts/index.js";
import {
  aiSeatOwesDecision,
  decideAiSeatAction,
  observeAiSeat,
  type AiSeatDecision,
} from "./ai-seat-policy.ts";
import { assertCommandIsLegal, toEngineCommand } from "./engine-bridge.ts";

/** See the header for the 46 this bounds. Reaching it throws. */
export const AI_SEAT_COMMAND_LIMIT_PER_SEAT = 64;

/**
 * The idempotency id carried by an AI decision's request envelope.
 *
 * An AI decision is not a client action and is never recorded in
 * `private.game_commands`; it rides inside the person's command, whose own id
 * is the one that is recorded. The envelope needs an id to be the same SHAPE a
 * client sends, so it carries this fixed, recognisably-not-random one.
 */
export const AI_SEAT_COMMAND_ID = "00000000-0000-4000-8000-000000000000";

export interface AiSeatAction {
  readonly seatId: string;
  readonly decision: AiSeatDecision;
}

export interface AiSeatDrive {
  readonly state: EngineState;
  /** The engine's events for every AI decision, in order, ready to append. */
  readonly events: readonly EngineEvent[];
  readonly actions: readonly AiSeatAction[];
}

/** A drive that could not finish honestly. Always a bug; never a refusal. */
export class AiSeatDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiSeatDriverError";
  }
}

/** The context every AI decision is applied with. `now` is the server's clock. */
export type AiSeatContext = CommandContext & { readonly now: string };

/**
 * Whether computer players may stake chips yet: every PERSON still in the
 * betting round has locked a bet, and there is at least one such person.
 *
 * Read from the public snapshot, like everything else here, because the answer
 * is public: whether a seat is a computer player, connected, sitting out and
 * locked are all on every player's screen.
 */
export function aiSeatsMayBet(table: PublicGameState): boolean {
  const people = table.seats.filter(
    (seat) => seat.isAi !== true && seat.connected && !seat.sittingOut,
  );
  return people.length > 0 && people.every((seat) => seat.betLocked);
}

/**
 * The next computer decision the table is waiting on, or null when it is
 * waiting on a person, resting, or finished.
 *
 * The policy is shown an observation built from `toPublicState`, and the
 * observation itself is proved against the authoritative state before it is
 * used — in production, not only in tests — so a future widening of either
 * fails the command instead of showing a computer player the shoe.
 */
export function nextAiSeatAction(state: EngineState): AiSeatAction | null {
  if (!state.seats.some((seat) => seat.isAi === true)) return null;

  const table = toPublicState(state);
  const bettingClosedToAi = table.phase === "BETTING_OPEN" && !aiSeatsMayBet(table);

  for (const seat of table.seats) {
    if (seat.isAi !== true) continue;
    if (bettingClosedToAi) continue;

    const observation = observeAiSeat(table, seat.seatId, state.rules);
    if (observation === null) {
      throw new AiSeatDriverError(`AI seat ${seat.seatId} could not be observed`);
    }
    assertNoHiddenCardLeak(observation, state);

    const decision = decideAiSeatAction(observation);
    if (decision !== null) return { seatId: seat.seatId, decision };
    if (aiSeatOwesDecision(observation)) {
      throw new AiSeatDriverError(
        `AI seat ${seat.seatId} owes a decision at ${table.phase} and the policy made none`,
      );
    }
  }
  return null;
}

/** The request a client would send for this decision, envelope and all. */
function requestFor(state: EngineState, decision: AiSeatDecision, now: string): GameCommandRequest {
  const envelope = {
    gameId: state.gameId,
    clientActionId: AI_SEAT_COMMAND_ID,
    expectedVersion: state.version,
    clientSentAt: now,
  };
  switch (decision.type) {
    case "PLACE_BET":
      return { ...envelope, type: "PLACE_BET", payload: { amount: decision.amount } };
    case "LOCK_BET":
      return { ...envelope, type: "LOCK_BET", payload: {} };
    case "DECLINE_INSURANCE":
      return { ...envelope, type: "DECLINE_INSURANCE", payload: {} };
    case "LEAVE":
      return { ...envelope, type: "LEAVE", payload: {} };
    case "HIT":
    case "STAND":
    case "DOUBLE":
    case "SPLIT":
    case "SURRENDER":
      return { ...envelope, type: decision.type, payload: {} };
  }
}

/**
 * Applies one AI decision through the person's path: the server's legality gate
 * on authoritative state, the wire-to-engine translation, and the engine.
 *
 * Refuses any seat that is not a computer player's. The driver only ever names
 * one, but this is the function that would be reached if anything else ever
 * did, and acting for a person is the one thing it must never do.
 */
export function applyAiSeatDecision(
  state: EngineState,
  seatId: string,
  decision: AiSeatDecision,
  context: AiSeatContext,
): EngineResult<EngineState> {
  const seat = state.seats.find((candidate) => candidate.seatId === seatId);
  if (seat === undefined || seat.isAi !== true) {
    throw new AiSeatDriverError(`seat ${seatId} is not a computer player's`);
  }
  const request = requestFor(state, decision, context.now);
  assertCommandIsLegal(state, seatId, request);
  return applyCommand(state, toEngineCommand(request, seatId, context.now), context);
}

/**
 * Plays every computer decision the table is waiting on, in order, and returns
 * the state the person comes back to.
 *
 * A table with no computer seats is returned untouched, so calling this is
 * harmless anywhere — but the server calls it only for a mode that seats them.
 */
export function driveAiSeats(state: EngineState, context: AiSeatContext): AiSeatDrive {
  return driveAiSeatsWithin(state, context, AI_SEAT_COMMAND_LIMIT_PER_SEAT);
}

/**
 * `driveAiSeats` with the per-seat bound as a parameter.
 *
 * Exported so the bound can be shown to THROW rather than assumed to: no table
 * the real policy can produce gets near 64, so a test that wants to watch the
 * guard fire has to lower it. The server never calls this directly.
 */
export function driveAiSeatsWithin(
  state: EngineState,
  context: AiSeatContext,
  limitPerSeat: number,
): AiSeatDrive {
  const aiSeats = state.seats.filter((seat) => seat.isAi === true).length;
  if (aiSeats === 0) return { state, events: [], actions: [] };

  const limit = limitPerSeat * aiSeats;
  let current = state;
  const events: EngineEvent[] = [];
  const actions: AiSeatAction[] = [];

  for (;;) {
    const next = nextAiSeatAction(current);
    if (next === null) return { state: current, events, actions };
    if (actions.length >= limit) {
      throw new AiSeatDriverError(
        `AI seats made ${actions.length} decisions in one command without the table ` +
          `coming to rest — the bound is ${limit}, and reaching it is a bug, not a slow table`,
      );
    }
    const result = applyAiSeatDecision(current, next.seatId, next.decision, context);
    events.push(...result.events);
    actions.push(next);
    current = result.state;
  }
}
