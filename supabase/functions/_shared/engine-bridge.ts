/**
 * Arc 21 — the bridge between a wire command and the shared engine.
 *
 * Nothing in this file re-implements a rule. `shared/blackjack` decides what is
 * legal, what a hand is worth and what a settlement pays; this module only
 * translates, gates and sanitises:
 *
 *   translate  a validated `GameCommandRequest` into an `EngineCommand`, with
 *              the seat id taken from the caller's DB seat row — never from the
 *              request body.
 *   gate       re-run `getLegalActions` on AUTHORITATIVE state before applying
 *              anything. A hidden button is a UI convenience, not a boundary.
 *   sanitise   pass every outgoing payload through `toPublicState`, then prove
 *              the result carries no undealt card and no unrevealed hole card.
 */

import {
  assertNoHiddenCardLeak,
  canCloseSeat,
  CryptoRandomSource,
  EngineError,
  getLegalActions,
  isBettingTurn,
  toPublicState,
  type BlackjackGameState,
  type EngineCommand,
  type EngineState,
  type PublicGameState,
  type RandomSource,
  type SeatState,
} from "../../../shared/blackjack/index.js";
import type { GameCommandRequest } from "../../../shared/contracts/index.js";
import { CommandError } from "./command-errors.ts";

/** Server time. The only clock that authorises a deadline or a timeout. */
export function serverNow(): string {
  return new Date().toISOString();
}

/**
 * Production randomness. `CryptoRandomSource` throws on construction if no
 * CSPRNG is available rather than degrading — a quietly weak shuffle is exactly
 * the defect this product promises does not exist.
 */
export function serverRandom(): RandomSource {
  return new CryptoRandomSource();
}

/**
 * Reads persisted engine state back out of `jsonb`.
 *
 * This is server-written data, so the check is an invariant guard rather than
 * input validation — but a silently malformed state would be settled against
 * real chips, so it fails loudly instead.
 */
export function parseEngineState(value: unknown): EngineState {
  // A `jsonb` column comes back hydrated by some drivers and as raw text by
  // others, and this one returns text. Rejecting the string form made every
  // command fail with "persisted engine state is not an object" — the session
  // opened and debited a buy-in, then no command against it could ever run.
  // Accepting both shapes makes the repository independent of that detail.
  let hydrated: unknown = value;
  if (typeof hydrated === "string") {
    try {
      hydrated = JSON.parse(hydrated);
    } catch {
      throw new Error("persisted engine state is not valid JSON");
    }
  }

  if (typeof hydrated !== "object" || hydrated === null || Array.isArray(hydrated)) {
    throw new Error("persisted engine state is not an object");
  }
  const candidate = hydrated as Partial<EngineState>;
  const missing: string[] = [];
  if (typeof candidate.gameId !== "string") missing.push("gameId");
  if (typeof candidate.phase !== "string") missing.push("phase");
  if (typeof candidate.version !== "number") missing.push("version");
  if (typeof candidate.handNumber !== "number") missing.push("handNumber");
  if (!Array.isArray(candidate.seats)) missing.push("seats");
  if (typeof candidate.rules !== "object" || candidate.rules === null) missing.push("rules");
  if (typeof candidate.shoe !== "object" || candidate.shoe === null) missing.push("shoe");
  if (typeof candidate.dealer !== "object" || candidate.dealer === null) missing.push("dealer");
  if (missing.length > 0) {
    throw new Error(`persisted engine state is missing ${missing.join(", ")}`);
  }
  return candidate as EngineState;
}

/**
 * The sanitisation boundary, applied.
 *
 * `toPublicState` is the only function permitted to build a client-visible
 * payload, and `assertNoHiddenCardLeak` proves the result against the
 * authoritative state it came from. Running the assertion in production — not
 * only in tests — means a refactor that widens the public shape fails the
 * request rather than publishing the shoe.
 */
export function sanitise(state: BlackjackGameState): PublicGameState {
  const publicState = toPublicState(state);
  assertNoHiddenCardLeak(publicState, state);
  return publicState;
}

/** Same guard, for anything else about to be serialised (events, broadcasts). */
export function assertSafeToPublish(payload: unknown, state: BlackjackGameState): void {
  assertNoHiddenCardLeak(payload, state);
}

/**
 * Builds the engine command.
 *
 * `seatId` is supplied by the caller from the authenticated seat lookup. The
 * request body has no seat field at all, so there is nothing here to confuse.
 * `RESOLVE_TIMEOUT` carries the SERVER's clock; a client's `clientSentAt` is
 * telemetry and never reaches the engine.
 */
export function toEngineCommand(
  request: GameCommandRequest,
  seatId: string,
  now: string,
): EngineCommand {
  switch (request.type) {
    case "PLACE_BET":
      return { type: "PLACE_BET", seatId, amount: request.payload.amount };
    case "LOCK_BET":
      return { type: "LOCK_BET", seatId };
    case "INSURANCE":
      return { type: "INSURANCE", seatId };
    case "DECLINE_INSURANCE":
      return { type: "DECLINE_INSURANCE", seatId };
    case "HIT":
    case "STAND":
    case "DOUBLE":
    case "SPLIT":
    case "SURRENDER":
      return { type: request.type, seatId };
    case "RESOLVE_TIMEOUT":
      return { type: "RESOLVE_TIMEOUT", now };
    case "LEAVE":
      return { type: "LEAVE", seatId };
    case "NEXT_HAND":
      return { type: "NEXT_HAND", seatId };
    default: {
      const exhaustive: never = request;
      throw new CommandError("INVALID_REQUEST", `unhandled command ${JSON.stringify(exhaustive)}`);
    }
  }
}

function seatOf(state: EngineState, seatId: string): SeatState {
  const seat = state.seats.find((candidate) => candidate.seatId === seatId);
  if (!seat) throw new EngineError("UNKNOWN_SEAT", `No seat "${seatId}" at this table`);
  return seat;
}

/**
 * Re-runs `getLegalActions` on authoritative state.
 *
 * The engine re-checks all of this itself and would throw anyway; this gate
 * exists because it is the control SECURITY.md names, and because it produces
 * the precise rejection code before any state is cloned or any card is drawn.
 */
export function assertCommandIsLegal(
  state: EngineState,
  seatId: string,
  request: GameCommandRequest,
): void {
  // Timeout resolution is not a seat's action: any connected client may ask for
  // it, and only the server's own clock authorises it. The engine validates the
  // deadline; there is no seat legality to consult.
  if (request.type === "RESOLVE_TIMEOUT") return;

  // Leaving is always available to a seated player. Whether the seat may also
  // cash out is a session-lifecycle question, decided against the phase in
  // session-repository.ts, not an action-legality one.
  if (request.type === "LEAVE") {
    seatOf(state, seatId);
    return;
  }

  const seat = seatOf(state, seatId);
  const legal = getLegalActions(state, seatId);

  /*
   * A sequential table takes bets one seat at a time, and a seat whose turn has
   * not arrived is not doing anything illegal. The same distinction the player
   * actions below draw: NOT_YOUR_TURN is a synchronisation problem the client
   * recovers from by re-reading the snapshot, where WRONG_PHASE reads as a bug
   * and ILLEGAL_ACTION reads as an attack.
   */
  if (
    (request.type === "PLACE_BET" || request.type === "LOCK_BET") &&
    state.phase === "BETTING_OPEN" &&
    !seat.betLocked &&
    !isBettingTurn(state, seatId)
  ) {
    throw new EngineError("NOT_YOUR_TURN", "it is not this seat's turn to bet");
  }

  switch (request.type) {
    case "NEXT_HAND":
      if (legal.canStartNextHand) return;
      throw new EngineError("WRONG_PHASE", "the hand is not settled yet");
    case "PLACE_BET": {
      if (legal.canPlaceBet) return;
      // Taking chips back off the felt is an ordinary action, not a wager. The
      // engine permits amount 0 unconditionally while the bet is unlocked,
      // whereas `canPlaceBet` can be false purely because the entire stack is
      // already staged — so gating a clear on it would strand the player.
      if (request.payload.amount === 0 && state.phase === "BETTING_OPEN" && !seat.betLocked) {
        return;
      }
      throw new EngineError("WRONG_PHASE", "betting is not open for this seat");
    }
    case "LOCK_BET":
      if (legal.canLockBet) return;
      throw new EngineError("ILLEGAL_ACTION", "this seat cannot lock its bet");
    case "INSURANCE":
      if (legal.canTakeInsurance) return;
      throw new EngineError("INSURANCE_NOT_AVAILABLE", "insurance is not available");
    case "DECLINE_INSURANCE":
      if (legal.canDeclineInsurance) return;
      throw new EngineError("INSURANCE_NOT_AVAILABLE", "there is no insurance offer to decline");
    case "HIT":
    case "STAND":
    case "DOUBLE":
    case "SPLIT":
    case "SURRENDER": {
      if (state.phase !== "PLAYER_TURNS") {
        throw new EngineError("WRONG_PHASE", "player turns are not in progress");
      }
      // Distinguishing "not your turn" from "not a legal action" matters: the
      // first is a synchronisation problem the client can recover from, the
      // second is a bug or an attack.
      if (state.activeSeatIndex === null || state.seats[state.activeSeatIndex]?.seatId !== seatId) {
        throw new EngineError("NOT_YOUR_TURN", "it is not this seat's turn");
      }
      if (!legal.actions.includes(request.type)) {
        throw new EngineError("ILLEGAL_ACTION", "that action is not legal for this hand");
      }
      return;
    }
  }
}

/**
 * Whether the table can be closed and the stack returned right now.
 *
 * The rule itself is `canCloseSeat` in `shared/blackjack/table-closure.ts`,
 * because the CLIENT needs the same answer: a player who taps "Leave table"
 * mid-hand has their intent held until the table reaches a phase this permits,
 * and a second copy of the phase list here would be a second answer to one
 * question. This wrapper exists only to keep the server's call sites reading in
 * the server's own vocabulary.
 */
export function canCloseSession(state: EngineState, seatId: string): boolean {
  return canCloseSeat(state, seatId);
}
