/**
 * Arc 21 — reading chips out of a live session.
 *
 * The seat's `stack` is not the player's chip total: the stake leaves the stack
 * the moment a wager is committed, so a bankroll read during a hand understates
 * the player by exactly the amount sitting on the felt. Reporting that as "net
 * chips" would show a loss the player has not made, every single hand, until it
 * settles.
 *
 * This module answers "how many chips are on the felt right now" for each phase
 * of a hand, so the statistics screen can add them back.
 *
 * Runtime-neutral: no React, React Native or Expo imports.
 */

import type { BlackjackGameState, SeatState } from "../../../shared/blackjack/types.js";

export interface SessionChips {
  /** Chips in the seat's stack. Null when there is no session. */
  stack: number | null;
  /** Chips committed to wagers and insurance, not yet settled. */
  atRisk: number;
  /** stack + atRisk, or null when there is no session. */
  total: number | null;
}

/**
 * Chips held by the seat, wherever they currently sit.
 *
 * Phase matters:
 *
 *   BETTING_OPEN     the staged bet lives in `originalBet` and no hands exist
 *   dealt hands      each hand carries its own `wager` (splits and doubles
 *                    added their own chips), plus any insurance stake
 *   HAND_COMPLETE    settlement has already credited the stack, but the hands
 *                    and their wagers are still present as a record of the hand
 *                    just played — counting them again would double the chips
 */
export function sessionChips(game: BlackjackGameState | null, seatId: string): SessionChips {
  const seat = game?.seats.find((candidate) => candidate.seatId === seatId) ?? null;
  if (!game || !seat) return { stack: null, atRisk: 0, total: null };

  const stack = finite(seat.stack);
  const atRisk = chipsAtRisk(game, seat);

  return { stack, atRisk, total: stack + atRisk };
}

function chipsAtRisk(game: BlackjackGameState, seat: SeatState): number {
  // Settled: the credit is already back in the stack. The hands remain only as
  // the record of what was just played.
  if (game.phase === "HAND_COMPLETE" || game.phase === "BETWEEN_HANDS") return 0;

  if (seat.hands.length === 0) return finite(seat.originalBet);

  const wagered = seat.hands.reduce((sum, hand) => sum + finite(hand.wager), 0);
  return wagered + finite(seat.insuranceBet);
}

function finite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
