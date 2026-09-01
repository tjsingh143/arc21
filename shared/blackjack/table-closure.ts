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
