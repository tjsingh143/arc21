/**
 * Whether the Deal control should be offered for the bet currently staged.
 *
 * Pure, and separate from `BettingBar` so it can be asserted without
 * rendering React Native — the same split as `format-chips.ts` and
 * `type-scale.ts`.
 *
 * THE BUG THIS EXISTS TO PIN. `BettingBar` used to gate Deal on
 * `legal.canLockBet` alone, which is
 * `!seat.betLocked && isBetAmountValid(seat.originalBet, …)` — a statement
 * about the bet the ENGINE already holds.
 *
 * At the practice table that is the same thing as the staged bet, because
 * `addChip` applies `PLACE_BET` to the local engine on every tap. At a
 * SERVER-AUTHORITATIVE table it is not: `addChip` only stages locally, and the
 * bet is not sent until Deal is pressed. So `originalBet` stayed 0,
 * `canLockBet` stayed false, and Deal was permanently disabled — no online
 * table could take a bet through the UI in any mode: private, public,
 * tournament or daily.
 *
 * Nothing was going to catch it. `tests/server/*` drive the Edge Function with
 * explicit commands and never touch this bar; the store's own `lockBet` is
 * unit-tested by CALLING it; and no E2E flow plays an online table. The
 * function was written, tested, and wired to a control that could not be
 * pressed. Found by playing a two-simulator private table in phase 14 s4.
 *
 * This decides only whether the button is worth offering. The engine re-checks
 * the amount and the server rejects an illegal `PLACE_BET` regardless.
 */

import type { LegalActionSet } from "../../../shared/blackjack/legal-actions.js";

export function canDealStagedBet(legal: LegalActionSet, stagedBet: number): boolean {
  if (legal.canLockBet) return true;
  /*
   * The seat may not stake anything right now, so a staged pile is not a bet
   * worth offering to send.
   *
   * This became reachable with the Sprint Tournament, which bets one seat at a
   * time: every seat but the current bettor is answered NO_ACTIONS, and the
   * earlier fallback ("no bounds, so trust whatever is staged") would have
   * offered Deal to all three of them. The engine would have refused it
   * NOT_YOUR_TURN, which is the right answer to the wrong question — a control
   * that can only be refused should not be offered.
   */
  if (!legal.canPlaceBet) return false;
  const bounds = legal.betBounds;
  if (!bounds) return stagedBet > 0;
  return stagedBet >= bounds.min && stagedBet <= bounds.max;
}

/**
 * What a seat with no control is actually waiting for.
 *
 * The table screen used to answer this with two sentences — "Waiting for the
 * next hand." when nobody was active and "Waiting for another player."
 * otherwise — and the second became misleading the moment a table started
 * betting one seat at a time. The Sprint Tournament's whole reason for
 * sequential betting is that a player WATCHES the bets go in and reacts to
 * them; a caption that does not say a bet is being placed hides the mechanic
 * the format is built on.
 *
 * Pure and separate so it can be asserted without rendering React Native, like
 * `canDealStagedBet` above.
 */
export function describeWaiting(params: {
  readonly phase: string;
  readonly activeSeatId: string | null;
  /** The active seat's display name, when the snapshot carries one. */
  readonly activeSeatName: string | null;
}): string {
  if (params.activeSeatId === null) return "Waiting for the next hand.";
  if (params.phase === "BETTING_OPEN") {
    return params.activeSeatName
      ? `${params.activeSeatName} is betting.`
      : "Another player is betting.";
  }
  return "Waiting for another player.";
}
