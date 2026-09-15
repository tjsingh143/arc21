/**
 * What another player's seat card is allowed to SAY about them.
 *
 * THE DEFECT THIS CLOSES. The table screen rendered exactly one sentence for a
 * seat whose `connected` was false — "Disconnected — their clock keeps running."
 * — and beside it, whenever that seat held no cards, "Yet to bet". Both are
 * untrue of a player who has LEFT, and the engine has no other kind of
 * disconnection: the reducer's own comment says so in as many words —
 * "`connected` is only ever cleared by LEAVE, by a table closure or by a
 * tournament elimination, and nothing sets it back". There is no flaky-network
 * state for that copy to be describing.
 *
 * Seen on a device at a two-seat private table: the host cashed out, and the
 * remaining player was left looking at `0 · Yet to bet · Disconnected — their
 * clock keeps running.` for the rest of the session. Nobody new ever joins a
 * private room, so `isVacatedSeat` — which reuses a vacated SLOT at a public
 * table — never gets the chance to tidy it away, and it would not have made the
 * sentence true in the meantime anyway.
 *
 * ONE CASE OF THE THREE DOES LEAVE A CLOCK RUNNING, and it is the one the
 * original sentence was written for: a player who leaves MID-HAND is
 * `connected: false` immediately while their committed hand goes on resolving,
 * because "leaving is never a way to escape a committed wager". So the answer is
 * not to delete the line but to tell the two apart, which every field this needs
 * is already on `PublicSeat`.
 *
 * Extracted rather than written inline for the reason this repository keeps
 * relearning: a test that drives the screen proves the screen renders, and a
 * test that calls the predicate proves the RULE. `betting-affordance.ts` is the
 * shape being copied.
 */

/** The least a caller must hold. `PublicSeat` satisfies it. */
export interface SeatPresenceView {
  readonly connected: boolean;
  readonly sittingOut: boolean;
  readonly betLocked: boolean;
  readonly stack: number;
  readonly originalBet: number;
  readonly insuranceBet: number;
  readonly hands: readonly unknown[];
}

export type SeatPresence =
  /** Still at the table and still playing. */
  | { readonly kind: "present" }
  /** Gone, but a wager of theirs is still on the table and being resolved. */
  | { readonly kind: "resolving"; readonly note: string }
  /** Gone. Nothing of theirs is live. */
  | { readonly kind: "departed"; readonly note: string };

/**
 * Whether this seat still has something at stake.
 *
 * The money conditions, and only those: a hand in front of them, a posted bet,
 * or an insurance bet. A stack is not something at stake — a tournament seat
 * eliminated with chips on it keeps them so the result screen can report the
 * bankroll they went out on, and that player is not owed a clock.
 */
function hasSomethingLive(seat: SeatPresenceView): boolean {
  return seat.hands.length > 0 || seat.originalBet > 0 || seat.insuranceBet > 0;
}

export function seatPresence(seat: SeatPresenceView): SeatPresence {
  if (seat.connected) return { kind: "present" };
  return hasSomethingLive(seat)
    ? {
        kind: "resolving",
        note: "Left mid-hand — the server is playing their hand out.",
      }
    : {
        kind: "departed",
        // True of all three ways `connected` is cleared: a cash-out, a table
        // closure and a tournament elimination. It deliberately does not say
        // "left", because an eliminated player did not choose to.
        note: "No longer playing at this table.",
      };
}

/**
 * The line under a seat that is holding no cards.
 *
 * `null` for a seat that has gone: `seatPresence` already says where they are,
 * and "Yet to bet" beside it would be a second, contradictory claim about
 * somebody who will never bet again.
 *
 * `sittingOut` was never rendered at all, so a seat genuinely sitting a hand out
 * — a stack below the table minimum, or a tournament's sudden-death hold-out —
 * was indistinguishable from one still deciding.
 */
export function describeSeatBetting(seat: SeatPresenceView): string | null {
  if (!seat.connected) return null;
  if (seat.sittingOut) return "Sitting out this hand";
  return seat.betLocked ? "Bet placed" : "Yet to bet";
}
