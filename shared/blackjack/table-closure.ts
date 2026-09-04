/**
 * WHEN A SEAT MAY LEAVE WITH ITS CHIPS.
 *
 * "Leaving is never a way to escape a committed wager" — SECURITY.md. A seat in
 * the middle of a hand, or one that has locked a bet for a hand about to be
 * dealt, must see that hand resolve before its stack can go anywhere.
 *
 * THIS LIVES IN THE ENGINE BECAUSE BOTH SIDES ASK IT. The server asks in order
 * to REFUSE — `cashOut` raises `SESSION_BUSY` — and the client asks in order to
 * know when a player who has already tapped "Leave table" mid-hand can finally
 * be cashed out. Two copies of a phase list would be two answers to one
 * question, and the one that drifts is the client's: it would either strand a
 * leaving player at a settled table or ask the server for something it is about
 * to refuse, on a three-second poll.
 *
 * Written against a STRUCTURAL type rather than `EngineState`, because those
 * two callers hold different objects. The server has the full engine state; a
 * client has only `PublicGameState`, whose seats carry `betLocked` for exactly
 * this kind of question. Both satisfy the shape below.
 */

import type { GamePhase } from "./types.js";

/** Phases in which no wager is committed, so a seat may safely cash out. */
export const SAFE_TO_CLOSE_PHASES: readonly GamePhase[] = [
  "SESSION_READY",
  "BETTING_OPEN",
  "HAND_COMPLETE",
  "BETWEEN_HANDS",
  "SESSION_COMPLETE",
];

const SAFE = new Set<string>(SAFE_TO_CLOSE_PHASES);

/** The least a caller must hold for the question to be answerable. */
export interface ClosableTable {
  readonly phase: GamePhase;
  readonly seats: readonly { readonly seatId: string; readonly betLocked: boolean }[];
}

/**
 * Whether this seat can be closed and its stack returned right now.
 *
 * `BETTING_OPEN` is the phase that needs the seat argument: betting being open
 * says nothing about whether THIS player has already pushed chips forward for
 * the hand about to be dealt. A seat that has is committed; the others are not.
 *
 * A seatId that names no seat answers true — there is no wager to protect, and
 * the caller's own participant check is what decides whether it may act at all.
 */
export function canCloseSeat(state: ClosableTable, seatId: string): boolean {
  if (!SAFE.has(state.phase)) return false;
  if (state.phase !== "BETTING_OPEN") return true;
  const seat = state.seats.find((candidate) => candidate.seatId === seatId);
  return seat ? !seat.betLocked : true;
}

/** The least a caller must hold to ask whether a seat has been vacated. */
export interface VacatableSeat {
  readonly connected: boolean;
  readonly stack: number;
  readonly originalBet: number;
  readonly insuranceBet: number;
  readonly hands: readonly unknown[];
}

/**
 * Whether this seat is an EMPTY SLOT — a player who has left and whose chips
 * have already gone back where they came from.
 *
 * The mirror of `canCloseSeat`: that one answers "may this seat leave", and
 * this one answers "has it, completely". The state described here is exactly
 * what `settleTableClosure` leaves behind — nothing staked, no hand, no chips,
 * and `connected` false, which the reducer's own comment defines as departed
 * rather than flaky ("`connected` is only ever cleared by LEAVE, by a table
 * closure or by a tournament elimination, and nothing sets it back").
 *
 * ALL FIVE CONDITIONS MATTER, and the ones about money are the load-bearing
 * ones. A player who leaves MID-HAND is `connected: false` immediately while
 * their committed hand goes on resolving — "leaving is never a way to escape a
 * committed wager" — so a slot is only free once that hand is over and the
 * stack has been returned. A tournament player eliminated with chips still on
 * the seat is excluded by `stack`, because the result screen reports the
 * bankroll they went out on.
 *
 * WHY THIS EXISTS. A public table takes new players for as long as it has room,
 * and until phase 11 the eighth arrival was answered HTTP 500 — which
 * accidentally bounded how many departed seats one table could accumulate.
 * With that fixed, `joinPublicTable` appending every arrival meant the engine's
 * seat list, the state persisted under lock on every command, and the payload
 * every client renders all grew without limit: measured at twelve seats on a
 * five-seat table after ten ordinary arrivals and departures, ten of them
 * players who had gone, each drawn on the remaining players' screens under
 * "Disconnected — their clock keeps running". A newcomer takes a vacated slot
 * instead, the same way they take the seat INDEX a departure freed.
 */
export function isVacatedSeat(seat: VacatableSeat): boolean {
  return (
    !seat.connected &&
    seat.stack === 0 &&
    seat.originalBet === 0 &&
    seat.insuranceBet === 0 &&
    seat.hands.length === 0
  );
}
