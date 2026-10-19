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

import { formatChips } from "../../design/format-chips.js";

/** The least a caller must hold. `PublicSeat` satisfies it. */
export interface SeatPresenceView {
  readonly connected: boolean;
  readonly sittingOut: boolean;
  readonly betLocked: boolean;
  readonly stack: number;
  readonly originalBet: number;
  readonly insuranceBet: number;
  readonly hands: readonly unknown[];
  /** Present, and true, only for a computer player. See `PublicSeat.isAi`. */
  readonly isAi?: true;
}

/**
 * The label a COMPUTER PLAYER carries, or null for a person.
 *
 * The specification's computer seats are "explicitly labeled", and the label is
 * read from the server's flag and from nothing else. A display name is free text
 * a person chooses — somebody may call themselves "AI Player 1" — so a seat is
 * labelled a computer player because the snapshot SAYS it is one, never because
 * of what it is called. `tests/table/seat-presence.test.ts` holds that line.
 */
export const COMPUTER_PLAYER_LABEL = "AI";

export function describeSeatIdentity(seat: { readonly isAi?: true }): string | null {
  return seat.isAi === true ? COMPUTER_PLAYER_LABEL : null;
}

/** What a screen reader hears for the label, spelled out. */
export const COMPUTER_PLAYER_ACCESSIBILITY_LABEL = "Computer player";

/**
 * The line under one of ANOTHER seat's hands: its wager, and once the hand is
 * settled, what it came to — "Bet 40 · Won 40", "Bet 20 · Lost 20",
 * "Bet 20 · Push".
 *
 * Every hand, not only the first. A seat that splits plays two to four hands,
 * and a table that drew only the first left the others' cards and results
 * invisible — at an AI table, where a computer player splits whenever the chart
 * says so, that is most of what there is to follow. Read from the snapshot's
 * own `outcome`, so nothing here works out who won.
 */
export function describeSeatHandDetail(hand: {
  readonly wager: number;
  readonly outcome?: { readonly kind: string; readonly net: number };
}): string | undefined {
  if (hand.wager <= 0) return undefined;
  const bet = `Bet ${formatChips(hand.wager)}`;
  if (hand.outcome === undefined) return bet;
  const { net } = hand.outcome;
  if (net > 0) return `${bet} · Won ${formatChips(net)}`;
  if (net < 0) return `${bet} · Lost ${formatChips(Math.abs(net))}`;
  return `${bet} · Push`;
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
  if (seat.betLocked) return "Bet placed";
  /*
   * A computer player stakes only once the person has locked a bet — the server
   * asks it no sooner, so that the last computer player to lock can never deal
   * the hand while the person is still choosing. "Yet to bet" would read as a
   * player taking their time; this says what it is waiting for.
   */
  return seat.isAi === true ? "Bets when you deal" : "Yet to bet";
}
